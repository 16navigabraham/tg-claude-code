import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  logMessage,
  getRecentPlainHistory,
  touchSession,
  setCliSessionId,
} from './db.js';
import { runTurnPersistent, persistentEnabled } from './persistentClaude.js';
import { approvalGateOn, approvalSpawnArgs } from './approvals.js';
import { scheduleRateLimitReminder, parseResetTimeFromText } from './rateLimitReminder.js';

// A run is killed if it produces NO output for STALL_MS (something's hung), or
// if total runtime exceeds MAX_RUNTIME_MS (a backstop). An actively-working
// task that keeps emitting events is left alone up to the backstop.
// NOTE: deliberately NOT reading the old CLAUDE_TIMEOUT_MS — many .env files
// still carry its original 60000, which would make every build die in a minute.
const STALL_MS = Number(process.env.CLAUDE_STALL_TIMEOUT_MS) || 300000; // 5 min
const MAX_RUNTIME_MS = Number(process.env.CLAUDE_MAX_RUNTIME_MS) || 2700000; // 45 min

// Subscription model. Per-session /model overrides this; null = plan default.
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || null;

// Cap agentic tool-loop iterations per message. Unsupervised, a fresh instruction
// can otherwise run 20-40 iterations, each re-billing the whole context — the
// single biggest cost gap vs a human-steered PC session. On hit, the CLI stops
// and returns what it has; the bot tells the user to reply "continue".
// CLAUDE_MAX_TURNS=0 disables the cap.
export const MAX_TURNS = Number.isFinite(Number(process.env.CLAUDE_MAX_TURNS))
  ? Number(process.env.CLAUDE_MAX_TURNS)
  : 30;

// Told to every session: how to run a server/tunnel that outlives the turn.
// (A `claude -p` run exits when it replies, killing its `&` jobs — daemon.sh
// re-parents them via setsid so they survive.) Kept terse; prompt-cached.
const DAEMON_SH = fileURLToPath(new URL('../scripts/daemon.sh', import.meta.url));
export const SESSION_SYSTEM_NOTE =
  `You are running inside a Telegram-driven bot session on a VPS, not an interactive terminal. ` +
  `A background job started with plain \`&\` dies when this turn ends. To run a dev server, ` +
  `static server, or tunnel that must keep running for the user across turns, use:\n` +
  `  bash ${DAEMON_SH} start <name> <abs-cwd> <command...>\n` +
  `  bash ${DAEMON_SH} list | stop <name> | logs <name>\n` +
  `\`cloudflared\` is installed (if \`command -v cloudflared\` succeeds): ` +
  `\`cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>\` prints a public ` +
  `https://<slug>.trycloudflare.com URL on stderr — run IT under daemon.sh too, then ` +
  `\`daemon.sh logs\` to read back the URL. One session can host several projects this way; ` +
  `give each daemon a distinct <name>. Tell the user the URL and which project it serves.`;

// The bot runs on a dedicated single-user VPS, so by default let Claude Code
// use every tool without interactive approval (there's no TTY to approve on).
// Set CLAUDE_PERMISSION_MODE=acceptEdits (or plan / default) to tighten this.
const PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions';

// The user's claude.ai MCP connectors (Gmail, Drive, Paybox, …) load by
// default — same as on the desktop. Set CLAUDE_STRICT_MCP=1 to drop them from
// bot runs (faster startup, ~15-20k fewer tokens/prompt) if you don't need
// them and want to stretch the rate limit.
const STRICT_MCP = !!process.env.CLAUDE_STRICT_MCP;

// The subscription OAuth token lives in ~/.claude/.credentials.json. We point
// CLAUDE_CONFIG_DIR at an isolated per-session dir (to keep the two providers'
// state — and the user's heavyweight ~/.claude MCP/skill config — out of the
// bot's runs), and claude then can't find that token: it reports "Not logged
// in". Symlink the live file into each session dir so every run uses the same
// auto-refreshed token, with nothing else inherited.
const REAL_CREDENTIALS = path.join(
  process.env.HOME || os.homedir(),
  '.claude',
  '.credentials.json'
);

// A long-lived subscription token from `claude setup-token`, set via /reauth.
// When present it's injected as CLAUDE_CODE_OAUTH_TOKEN and takes precedence
// over the (expiry-prone) ~/.claude/.credentials.json symlink.
export const OAUTH_TOKEN_FILE = path.resolve(
  process.env.OAUTH_TOKEN_FILE || 'data/oauth-token'
);

export function readOAuthToken() {
  try {
    const t = fs.readFileSync(OAUTH_TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch {
    /* no file */
  }
  return process.env.CLAUDE_CODE_OAUTH_TOKEN || null;
}

function subscriptionEnv() {
  const tok = readOAuthToken();
  return tok ? { CLAUDE_CODE_OAUTH_TOKEN: tok } : {};
}

export function ensureSubscriptionAuth(configDir) {
  try {
    if (!fs.existsSync(REAL_CREDENTIALS)) return;
    fs.mkdirSync(configDir, { recursive: true });
    const link = path.join(configDir, '.credentials.json');
    if (fs.lstatSync(link, { throwIfNoEntry: false })) return;
    try {
      fs.symlinkSync(REAL_CREDENTIALS, link);
    } catch {
      fs.copyFileSync(REAL_CREDENTIALS, link);
    }
  } catch {
    // best effort — a failure here just surfaces downstream as "Not logged in"
  }
}

// Absolute deny rules — enforced even under bypassPermissions. Blocks the
// obvious footguns (secret files, destructive git/fs, repo self-modification).
// NOT a security boundary against a determined prompt injection (a bypass agent
// can still read a file via python/xxd/etc.) — it's accident + casual-misuse
// protection. Extend/replace with CLAUDE_DENY (newline- or comma-separated).
// Claude Code absolute-path rules are "//" + the path; HOME_DIR already has a
// leading "/", so prepend just one more.
const A = (p) => `/${(process.env.HOME || os.homedir()).replace(/\/+$/, '')}${p}`;
const DEFAULT_DENY = [
  `Read(${A('/.aws/**')})`,
  `Read(${A('/.ssh/**')})`,
  `Read(${A('/.config/gh/**')})`,
  `Read(${A('/.claude/**')})`,
  `Read(${A('/tg-claude-agent/.env')})`,
  `Read(${A('/tg-claude-agent/data/**')})`,
  `Edit(${A('/tg-claude-agent/**')})`,
  `Write(${A('/tg-claude-agent/**')})`,
  'Bash(rm -rf:*)',
  'Bash(rm -fr:*)',
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(git reset --hard:*)',
  'Bash(gh repo delete:*)',
  'Bash(gh secret:*)',
  'Bash(sudo:*)',
];
const DENY_RULES = (process.env.CLAUDE_DENY
  ? process.env.CLAUDE_DENY.split(/[\n,]/)
  : DEFAULT_DENY
)
  .map((s) => s.trim())
  .filter(Boolean);

// Bot commits must not carry the "Co-Authored-By: Claude" / "Generated with
// Claude Code" trailer — they're the user's commits. The bot overrides
// CLAUDE_CONFIG_DIR, so ~/.claude/settings.json is never consulted; seed the
// settings (attribution + deny rules) into each isolated config dir. Merge into
// any existing file so re-seeding picks up rule changes.
export function seedSettings(configDir) {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const f = path.join(configDir, 'settings.json');
    let cur = {};
    try {
      cur = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
    } catch {
      /* none / unparseable — start fresh */
    }
    const next = {
      ...cur,
      includeCoAuthoredBy: false,
      permissions: { ...(cur.permissions || {}), deny: DENY_RULES },
    };
    fs.writeFileSync(f, JSON.stringify(next, null, 2) + '\n');
  } catch {
    // best effort
  }
}

// Verified against Claude Code CLI 2.1.x (2026-08) by running a real prompt:
//  - `-p --output-format stream-json` REQUIRES `--verbose`, otherwise the CLI errors.
//  - stream-json output is newline-delimited JSON events, e.g.:
//      {"type":"system","subtype":"init","session_id":"<uuid>", ...}
//      {"type":"assistant","message":{"content":[{"type":"text","text":"..."}], ...}}
//      {"type":"result","subtype":"success","result":"<final text>","is_error":false, ...}
//  - CLAUDE_CONFIG_DIR overrides where Claude Code keeps its state
//    (projects/, sessions/, .claude.json) — confirmed it creates that tree
//    under the override path. This is the per-provider isolation mechanism.
//  - A failed run can still exit 0 while setting "is_error":true on the result
//    event (e.g. auth failure surfaces there, not on stderr). Always inspect the
//    parsed events, not just the exit code / stderr.
//  - The real conversation session id comes from the `system/init` event's
//    `session_id`; pass it back via `--resume <id>` for multi-turn continuity
//    within the same provider.

function buildSeedPrefix(history) {
  if (!history || history.length === 0) return '';
  const transcript = history
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
  return (
    `[Context from earlier in this conversation, carried over as plain text ` +
    `because this provider's session is fresh — not a resumed transcript]\n\n` +
    `${transcript}\n\n---\n\n`
  );
}

// Session id -> running child, so /cancel can kill an in-flight run.
const activeRuns = new Map();

export function cancelRun(sessionId) {
  const child = activeRuns.get(sessionId);
  if (!child) return false;
  child.__cancelled = true;
  child.kill('SIGKILL');
  return true;
}

// Pull a one-line "what is it doing now" label out of a stream-json event.
export function progressLabel(line) {
  let evt;
  try {
    evt = JSON.parse(line.trim());
  } catch {
    return null;
  }
  if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
    for (const b of evt.message.content) {
      if (b.type === 'tool_use') {
        const inp = b.input || {};
        let hint = '';
        if (inp.command) hint = String(inp.command).replace(/\s+/g, ' ').slice(0, 60);
        else if (inp.file_path || inp.path) {
          hint = String(inp.file_path || inp.path).split('/').filter(Boolean).pop() || '';
        } else if (inp.pattern) hint = String(inp.pattern).slice(0, 40);
        else if (inp.url) hint = String(inp.url).slice(0, 60);
        return `${b.name}${hint ? ` ${hint}` : ''}`;
      }
      if (b.type === 'text' && b.text && b.text.trim()) {
        return b.text.trim().replace(/\s+/g, ' ').slice(0, 90);
      }
    }
  }
  return null;
}

function runClaudeSubprocess({
  prompt,
  cwd,
  configDir,
  resumeId,
  model,
  extraEnv,
  cancelKey,
  onProgress,
}) {
  return new Promise((resolve, reject) => {
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(process.env.TZ ? { TZ: process.env.TZ } : {}), // local time in claude's own messages
      // Isolate per-provider state. Never inherit ANTHROPIC_BASE_URL /
      // ANTHROPIC_AUTH_TOKEN from the parent shell — only inject them
      // explicitly for the fallback branch, below.
      CLAUDE_CONFIG_DIR: configDir,
      ...extraEnv,
    };

    // The prompt goes on STDIN, not as an arg: `-p` is just the `--print`
    // boolean and the prompt would otherwise be a positional — so any prompt
    // starting with `-` gets misparsed as an unknown option. stdin also has no
    // length limit and needs no escaping. `--verbose` is mandatory for
    // `-p --output-format stream-json`.
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      // bypassPermissions skips prompting entirely — for the approval gate we
      // need `default` so Claude Code actually calls the permission tool.
      '--permission-mode', approvalGateOn() ? 'default' : PERMISSION_MODE,
    ];
    if (model) args.push('--model', model);
    if (MAX_TURNS > 0) args.push('--max-turns', String(MAX_TURNS));
    args.push('--append-system-prompt', SESSION_SYSTEM_NOTE);
    // Opt-in: drop the user's managed MCP connectors from bot runs.
    if (STRICT_MCP) args.push('--strict-mcp-config');
    args.push(...approvalSpawnArgs(cancelKey));
    // Resume the same provider-side conversation if we've spoken to it before.
    if (resumeId) args.push('--resume', resumeId);

    const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    if (cancelKey) activeRuns.set(cancelKey, child);
    // Write the prompt and close stdin immediately → EOF at once, no 3s wait.
    child.stdin.on('error', () => {}); // ignore EPIPE if the process exits early
    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let settled = false;
    let stallTimer;

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      clearTimeout(maxTimer);
      if (cancelKey && activeRuns.get(cancelKey) === child) activeRuns.delete(cancelKey);
      fn(arg);
    };

    const timerErr = (code, ms) => {
      const e = new Error(code);
      e.mins = Math.max(1, Math.round(ms / 60000));
      return e;
    };
    // Kill if the process goes silent for STALL_MS; reset on every output chunk.
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        child.kill('SIGKILL');
        done(reject, timerErr('STALLED', STALL_MS));
      }, STALL_MS);
    };
    // Absolute backstop regardless of activity.
    const maxTimer = setTimeout(() => {
      child.kill('SIGKILL');
      done(reject, timerErr('MAX_RUNTIME', MAX_RUNTIME_MS));
    }, MAX_RUNTIME_MS);
    armStall();

    let lineBuf = '';
    let lastProgress = 0;
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      armStall();
      if (!onProgress) return;
      lineBuf += s;
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (Date.now() - lastProgress < 12000) continue; // throttle progress edits
        const label = progressLabel(line);
        if (label) {
          lastProgress = Date.now();
          try {
            onProgress(label);
          } catch {
            /* reporting must never break the run */
          }
        }
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      armStall(); // stderr activity also counts as "alive"
    });

    child.on('error', (err) => done(reject, err));

    child.on('close', (code) => {
      if (child.__cancelled) {
        const e = new Error('CANCELLED');
        e.cancelled = true;
        return done(reject, e);
      }
      done(resolve, { stdout, stderr, code });
    });
  });
}

// stream-json is newline-delimited JSON. Parse every complete line into an event;
// silently skip anything that isn't valid JSON (partial writes, stray output).
export function parseStreamEvents(raw) {
  const events = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // not a complete JSON object on this line — ignore
    }
  }
  return events;
}

// A run like /compact produces no assistant text — just a system compact_boundary
// event with before/after token counts. Turn that into a readable summary.
function compactMetadata(events) {
  return events.find((e) => e.type === 'system' && e.compact_metadata)?.compact_metadata || null;
}

function extractCompactSummary(events) {
  const m = compactMetadata(events);
  if (!m) return null;
  const pre = m.pre_tokens?.toLocaleString?.() ?? m.pre_tokens;
  const post = m.post_tokens?.toLocaleString?.() ?? m.post_tokens;
  return `✅ Compacted — context reduced from ~${pre} to ~${post} tokens. Same conversation, continue as normal.`;
}

// Live context size ≈ the input side of the LAST assistant turn in the run
// (the `result` event's usage is a cumulative total across every internal
// step — millions on a big agentic task — so it's not a "how big is this
// conversation" number). A /compact run has no assistant turn at all, so fall
// back to the compaction's own post_tokens — otherwise the tracked size stays
// stale at the pre-compact value forever.
export function contextFromEvents(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const mu = events[i].type === 'assistant' ? events[i].message?.usage : null;
    if (mu) {
      return (
        (mu.input_tokens || 0) + (mu.cache_read_input_tokens || 0) + (mu.cache_creation_input_tokens || 0)
      );
    }
  }
  return compactMetadata(events)?.post_tokens || 0;
}

// Prefer the final `result` event's text (that's the authoritative answer).
// Fall back to concatenating text blocks from `assistant` events, then a
// compact summary if that's what this run was, then a plain notice — NEVER
// the raw stream-json (a compact-only run, for one, has no assistant text and
// used to dump the entire raw event log into the chat).
export function extractText(events, raw) {
  const result = events.find((e) => e.type === 'result');
  if (result && typeof result.result === 'string' && result.result.length) {
    return result.result;
  }
  let text = '';
  for (const evt of events) {
    if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
      for (const block of evt.message.content) {
        if (block.type === 'text' && block.text) text += block.text;
      }
    }
  }
  if (text) return text;
  return extractCompactSummary(events) || '(done — no text output for this turn)';
}

export function extractCliSessionId(events) {
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  if (init?.session_id) return init.session_id;
  const anyWithId = events.find((e) => e.session_id);
  return anyWithId?.session_id || null;
}

// Did the run stop because it hit --max-turns (rather than finishing)?
export function hitMaxTurns(events) {
  return /max.?turns/i.test(events.find((e) => e.type === 'result')?.subtype || '');
}

// Turn a completed run into an Error if the CLI reported failure — via a
// non-zero exit, OR an in-band {"is_error":true} result event, OR an `error`
// field on an assistant event (exit code may still be 0 in those cases).
export function detectRunError({ stdout, stderr, code }, events) {
  // Subscription rate-limit: the CLI emits `rate_limit_event` lines; when the
  // window is spent, `status` moves off "allowed" / "allowed_warning".
  const rl = [...events].reverse().find((e) => e.type === 'rate_limit_event');
  const rlStatus = rl?.rate_limit_info?.status;
  if (rlStatus && rlStatus !== 'allowed' && rlStatus !== 'allowed_warning') {
    const err = new Error(
      `Claude rate limit (${rlStatus}); resets at ${rl.rate_limit_info?.resetsAt ?? 'unknown'}`
    );
    err.isRateLimit = true;
    // resetsAt is epoch seconds when present.
    if (rl.rate_limit_info?.resetsAt) err.resetsAt = rl.rate_limit_info.resetsAt * 1000;
    err.stderr = stderr;
    err.code = code;
    return err;
  }

  const result = events.find((e) => e.type === 'result');
  // Hitting --max-turns is a deliberate stop, not a failure: the work so far is
  // real and the user can say "continue". Let the normal text-extraction path run.
  const isMaxTurns = /max.?turns/i.test(result?.subtype || '');
  if (result?.is_error && !isMaxTurns) {
    const err = new Error(
      `Claude reported an error: ${String(result.result || result.subtype || 'unknown').slice(0, 500)}`
    );
    err.resultText = String(result.result || '');
    err.apiErrorStatus = result.api_error_status ?? null;
    err.stderr = stderr;
    err.code = code;
    return err;
  }

  const assistantErr = events.find((e) => e.type === 'assistant' && e.error);
  if (assistantErr) {
    const err = new Error(`Claude reported an error: ${assistantErr.error}`);
    err.resultText = events.find((e) => e.type === 'result')?.result || '';
    err.claudeError = assistantErr.error;
    err.stderr = stderr;
    err.code = code;
    return err;
  }

  if (code !== 0) {
    // 143 = SIGTERM, 137 = SIGKILL, null = killed without a code — almost always
    // the bot process being restarted mid-run, not a real failure.
    if (code === 143 || code === 137 || code === null) {
      const err = new Error('INTERRUPTED');
      err.stderr = stderr;
      err.code = code;
      return err;
    }
    const err = new Error(
      `Claude exited with code ${code}: ${(stderr || stdout).slice(0, 500)}`
    );
    err.stderr = stderr;
    err.code = code;
    return err;
  }

  return null;
}

// Only rate-limit / quota / overload conditions should trip the fallback
// fallback. Auth failures, bad flags, crashes, etc. must propagate instead of
// silently burning fallback credits.
// NOTE: the exact rate-limit wording Claude Code emits on a real subscription
// limit is still unconfirmed — tighten these patterns once observed on the VPS.
function looksLikeRateLimit(err) {
  if (err.isRateLimit) return true;
  if (err.apiErrorStatus === 429) return true;
  // These are not rate limits — don't fall back.
  if (['STALLED', 'MAX_RUNTIME', 'CANCELLED', 'INTERRUPTED'].includes(err.message)) return false;
  const msg = `${err.message || ''} ${err.stderr || ''} ${err.resultText || ''}`.toLowerCase();
  return (
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('429') ||
    msg.includes('quota') ||
    msg.includes('usage limit') ||
    msg.includes('overloaded')
  );
}

async function runProvider({ session, provider, prompt, configDir, resumeId, model, extraEnv, onProgress }) {
  seedSettings(configDir);
  const run = await runClaudeSubprocess({
    prompt,
    cwd: session.working_dir,
    configDir,
    resumeId,
    model,
    extraEnv,
    cancelKey: session.id,
    onProgress,
  });

  const events = parseStreamEvents(run.stdout);

  const runErr = detectRunError(run, events);
  if (runErr) {
    runErr.provider = provider; // so the caller can say which side failed
    throw runErr;
  }

  const text = extractText(events, run.stdout);

  // Persist the CLI-side conversation id so the next turn on this provider can
  // `--resume` it instead of starting cold.
  const cliSessionId = extractCliSessionId(events);
  if (cliSessionId) setCliSessionId(session.id, provider, cliSessionId);

  return { text, contextTokens: contextFromEvents(events), stoppedEarly: hitMaxTurns(events) };
}

export async function routePrompt(session, userPrompt, { onProgress } = {}) {
  // Snapshot the conversation BEFORE logging this turn — used to seed a
  // provider whose own transcript is still empty (first fallback, or the first
  // subscription turn after a fallback period). Plain text only, never the
  // other provider's raw Claude Code state.
  const priorHistory = getRecentPlainHistory(session.id, 20);
  logMessage({ session_id: session.id, role: 'user', content: userPrompt });

  // FORCE_FALLBACK=1 skips the subscription entirely — for testing the
  // fallback path without waiting to hit a real rate limit.
  const forceFallback = !!process.env.FORCE_FALLBACK;

  // --- Primary: subscription auth, isolated config dir, no proxy env at all ---
  ensureSubscriptionAuth(session.claude_session_dir);
  if (!forceFallback) {
    try {
      // Cold subscription session but a conversation already happened (e.g. on
      // the fallback API) → carry it over as plain text.
      const seed = session.claude_cli_session_id ? '' : buildSeedPrefix(priorHistory);
      const model = session.model || DEFAULT_MODEL; // /model override → CLAUDE_MODEL → plan default
      const subEnv = subscriptionEnv(); // /reauth token, else the credentials symlink

      const { text, contextTokens, stoppedEarly } = persistentEnabled()
        ? await runTurnPersistent({
            session,
            prompt: seed + userPrompt,
            model,
            extraEnv: subEnv,
            onProgress,
          })
        : await runProvider({
            session,
            provider: 'claude',
            prompt: seed + userPrompt,
            configDir: session.claude_session_dir,
            resumeId: session.claude_cli_session_id || null,
            model,
            extraEnv: subEnv,
            onProgress,
          });

      logMessage({ session_id: session.id, role: 'assistant', content: text, provider_used: 'claude' });
      touchSession(session.id, 'claude');
      return { text, provider: 'claude', contextTokens, stoppedEarly };
    } catch (err) {
      if (!looksLikeRateLimit(err)) throw err;
      // Structured rate_limit_event gives resetsAt directly; otherwise fall
      // back to parsing Claude's own "resets 2:20pm" text (best-effort).
      const resetsAt =
        err.resetsAt || parseResetTimeFromText(err.resultText || err.message);
      if (resetsAt) scheduleRateLimitReminder(resetsAt);
      // rate-limited / quota-exhausted on the subscription — fall through
    }
  }

  // --- Fallback: a separate Anthropic API key, when the subscription is
  // rate-limited. Separate config dir + a fresh branch (never resumes the
  // subscription transcript) so the two never mix. Injects ANTHROPIC_* into
  // THIS subprocess only. Base URL defaults to the real API; point it
  // elsewhere only if you're using an API-compatible proxy.
  const fbKey = process.env.FALLBACK_ANTHROPIC_API_KEY;
  if (!fbKey) {
    throw new Error(
      'Fallback not configured — set FALLBACK_ANTHROPIC_API_KEY in .env ' +
        '(an Anthropic API key from console.anthropic.com), or wait for the subscription to recover.'
    );
  }
  const fbBaseUrl = (process.env.FALLBACK_ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const fbModel = process.env.FALLBACK_ANTHROPIC_MODEL || 'claude-sonnet-4-5';

  // Seed plain-text history on the first fallback turn (nothing to --resume yet).
  const promptToSend = session.fallback_cli_session_id
    ? userPrompt
    : buildSeedPrefix(priorHistory) + userPrompt;

  const { text, contextTokens, stoppedEarly } = await runProvider({
    session,
    provider: 'fallback',
    prompt: promptToSend,
    configDir: session.fallback_session_dir,
    resumeId: session.fallback_cli_session_id || null,
    extraEnv: {
      ANTHROPIC_BASE_URL: fbBaseUrl,
      ANTHROPIC_AUTH_TOKEN: fbKey,
      ANTHROPIC_MODEL: fbModel,
      // Some API-compatible proxies don't implement the count-tokens preflight.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    onProgress,
  });

  logMessage({ session_id: session.id, role: 'assistant', content: text, provider_used: 'fallback' });
  touchSession(session.id, 'fallback');
  return { text, provider: 'fallback', contextTokens, stoppedEarly };
}

// Fire a trivial subscription prompt in a throwaway config dir to check auth —
// used by /reauth to tell the user immediately whether the token works.
export async function verifyAuth() {
  const dir = path.join(os.tmpdir(), `authcheck-${Date.now()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const extraEnv = subscriptionEnv();
    if (!extraEnv.CLAUDE_CODE_OAUTH_TOKEN) ensureSubscriptionAuth(dir);
    const run = await runClaudeSubprocess({
      prompt: 'reply with the single word OK',
      cwd: os.tmpdir(),
      configDir: dir,
      extraEnv,
      onProgress: null,
    });
    const events = parseStreamEvents(run.stdout);
    const err = detectRunError(run, events);
    if (err) return { ok: false, detail: (err.resultText || err.message).slice(0, 200) };
    return { ok: true, detail: extractText(events, run.stdout).slice(0, 80) };
  } catch (e) {
    return { ok: false, detail: (e.message || String(e)).slice(0, 200) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
