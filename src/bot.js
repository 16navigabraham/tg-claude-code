import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { Telegraf } from 'telegraf';
import {
  newSession,
  listAllSessions,
  listAllArchived,
  purgeSession,
  renewSession,
  diskReport,
  switchSession,
  currentSession,
  killSession,
  getSessionById,
  setSessionEmoji,
  backfillEmojis,
} from './sessionManager.js';
import { routePrompt, cancelRun, verifyAuth, OAUTH_TOKEN_FILE, MAX_TURNS } from './providerRouter.js';

const MAX_TURNS_INFO = MAX_TURNS || 'no';
import { cancelPersistent } from './persistentClaude.js';
import {
  startApprovalListener,
  resolveApproval,
  pendingCount,
  approvalGateOn,
} from './approvals.js';
import { initReminder } from './rateLimitReminder.js';
import { capturePreview } from './preview.js';
import { openTunnel, stopTunnel } from './tunnel.js';
import { transcribe, voiceSupported } from './transcribe.js';
import {
  setSessionModel,
  setSessionContextTokens,
  addInflight,
  removeInflight,
  takeAllInflight,
} from './db.js';

const CONTEXT_WARN_TOKENS = Number(process.env.CONTEXT_WARN_TOKENS) || 160000;
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|‍|️){1,8}$/u;

// The model a session actually runs on: its own override → CLAUDE_MODEL → plan default.
function effectiveModel(session) {
  if (session.model) return `${session.model} (set for this session)`;
  if (process.env.CLAUDE_MODEL) return `${process.env.CLAUDE_MODEL} (CLAUDE_MODEL default)`;
  return 'plan default';
}

const ALLOWED_USER_ID = String(process.env.ALLOWED_TELEGRAM_USER_ID || '');
const TELEGRAM_CHUNK_LIMIT = 4000; // headroom under Telegram's 4096 hard limit
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // Telegram getFile download ceiling

const HELP = `Abraham-Claude-code — Claude Code, driven from Telegram

SESSIONS  (each = its own working dir + isolated Claude conversation)
  /new [emoji] <name>  create a session; auto-gets an emoji unless you pass one
  /sessions            list every session (emoji, last active, provider, model)
  /switch <name>       make another session active (prefix / case-insensitive)
  /compact             Claude summarizes its own conversation to cut cost —
                       same session, same --resume chain, best continuity
                       (identical to /compact on the PC terminal)
  /renew [name]        harder reset: drops the conversation entirely, keeps
                       the session's files/git/node_modules, reseeds from
                       only the last 20 messages (use if /compact isn't enough)
  /kill <name>         end a session (files kept — /purge to actually delete)
  /archived            list killed sessions still taking up disk space
  /purge <name>        permanently delete an archived session's files
  /disk                disk usage: overall + per-session, biggest first
  /status              active session: emoji, provider, model, context, running?

PER-SESSION SETTINGS
  /model [name]     show, or set to opus / sonnet / haiku / sonnet[1m] /
                    a full claude-* id / default. Subscription only.
                    (CLAUDE_MODEL=sonnet in .env sets the default for all.)
  /emoji <emoji>   change the emoji for the active session (/emoji all = backfill)

RUN CONTROL
  /cancel           stop the task running in the active session
  /approve [id]     approve a pending action (APPROVAL_GATE=1); newest if no id
  /deny [id]        deny a pending action
  /preview          screenshot the site in the session's working dir
  /preview dev [p]  same, but via 'npm run dev' (optional port)
  /tunnel           managed public URL for ONE static site in the session
  /tunnel dev [p]   managed public URL for 'npm run dev'
  /tunnel stop      close that managed tunnel
  /servers          list background servers/tunnels Claude started itself
  /servers stop <name> | logs <name>

  For multiple projects in one session, just ask Claude:
  "serve ./frontend and ./admin, tunnel both, give me the URLs" — it uses
  scripts/daemon.sh so they keep running across turns.

CLAUDE SUBSCRIPTION AUTH
  /reauth <token>   apply a token you already have (from 'claude setup-token')
  /setuptoken       mint a NEW token entirely from your phone — no terminal
  /authcode <code>  (used during /setuptoken) send the approval code back

  /help             this message

USING IT
  Any non-command message goes to Claude Code in the active session — it
  reads/writes files, runs shell commands, uses git & gh, browses the web,
  can spawn sub-agents. Work happens in ~/sessions/<id>/workdir on the VPS.

  Photo / PDF / file  → saved to the session's uploads/ and handed to Claude
                        (add a caption to say what to do with it).
  Voice note          → transcribed on the VPS (whisper.cpp) and run as text.

  Continuity: follow-ups keep context automatically; messages to one session
  run one at a time, in order; different sessions run in parallel. Replies
  are prefixed [session-name] so you can trace which is which.

  A long task shows a live "⚙️ Working — <current step>" line. If the
  subscription hits its usage limit, the bot retries via AgentRouter and
  tags the reply [via AgentRouter fallback].`;

// Serialise prompts per session: concurrent `claude --resume` runs against the
// same session dir can corrupt its transcript, and out-of-order replies are
// confusing. Each session gets a promise chain; new work waits its turn.
const sessionChains = new Map();

function runQueued(sessionId, fn) {
  const prev = sessionChains.get(sessionId) || Promise.resolve();
  const next = prev.then(fn, fn); // run regardless of how the previous one ended
  const tail = next.then(
    () => {},
    () => {}
  );
  sessionChains.set(sessionId, tail);
  // Drop the entry once this tail drains, unless something newer took its place.
  tail.then(() => {
    if (sessionChains.get(sessionId) === tail) sessionChains.delete(sessionId);
  });
  return next;
}

// chatId -> { child, timer } for an in-progress `claude setup-token` bridge.
const tokenSetups = new Map();

function endTokenSetup(chatId) {
  const s = tokenSetups.get(chatId);
  if (!s) return;
  clearTimeout(s.timer);
  try {
    s.child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  tokenSetups.delete(chatId);
}

// Run long work WITHOUT blocking Telegraf's update loop. Telegraf awaits each
// handler's returned promise before dispatching the next update, so a handler
// that awaits a multi-minute `claude` run stalls every other message/command.
// These handlers manage their own replies + errors, so fire and forget.
function detach(promise) {
  Promise.resolve(promise).catch((err) => {
    console.error(`[${new Date().toISOString()}] detached handler:`, err?.stack || err);
  });
}

// Map a raw provider error to something actionable for the user.
function friendlyError(err) {
  const m = `${err.message || ''} ${err.resultText || ''}`;
  if (err.cancelled || /(^|\W)CANCELLED(\W|$)/.test(m)) {
    return 'Task cancelled.';
  }
  if (/(^|\W)INTERRUPTED(\W|$)/.test(m)) {
    return 'The bot restarted while this was running, so it was cut off. Resend it.';
  }
  if (/(^|\W)STALLED(\W|$)/.test(m)) {
    const mins = err.mins || 5;
    return `That task produced no output for ${mins} min (looked hung) and was stopped. Retry, or break it into smaller steps.`;
  }
  if (/(^|\W)MAX_RUNTIME(\W|$)/.test(m)) {
    const mins = err.mins || 45;
    return `That task ran past the ${mins}-minute limit and was stopped. Break it into smaller steps, or raise CLAUDE_MAX_RUNTIME_MS in .env.`;
  }
  if (/not logged in|please run \/login|authentication_failed/i.test(m)) {
    return 'Claude subscription auth has lapsed. SSH into the VPS and run `claude login` (or `claude setup-token` for a long-lived token).';
  }
  if (err.isRateLimit || /rate[ _]limit|\b429\b|quota|usage limit|overloaded/i.test(m)) {
    return "Claude subscription hit its usage limit. I'll DM you the moment it resets — or retry later yourself, or set up AgentRouter as a fallback.";
  }
  if (/\b405\b/.test(m) && err.provider === 'agentrouter') {
    return "AgentRouter rejected this request (HTTP 405 — it can't handle this task type). Your subscription is likely rate-limited right now; wait for the reset and retry.";
  }
  if (err.provider === 'agentrouter' && /no available channel|无可用渠道|\b503\b/i.test(m)) {
    return 'AgentRouter has no capacity for any of its models right now, and your Claude subscription is rate-limited. Nothing to do but wait for the subscription window to reset (a few hours), or lower usage with CLAUDE_STRICT_MCP=1.';
  }
  if (/AgentRouter fallback is not configured/i.test(m)) {
    return 'Subscription failed and AgentRouter isn\'t configured. Fill AGENTROUTER_* in .env, or wait for the subscription to recover.';
  }
  return `Error${err.provider ? ` (${err.provider})` : ''}: ${err.message}`;
}

// Run a prompt against the chat's active session and stream the reply back,
// chunked to Telegram's message limit, with a "typing" heartbeat.
async function deliver(ctx, promptText) {
  const active = currentSession(ctx.chat.id);
  if (!active) {
    return ctx.reply('No active session. Create one with /new <name> first.');
  }

  // Prefix every message this task emits with the session emoji + name, so a
  // chat with several sessions / out-of-order replies stays traceable.
  // SESSION_TAG=0 off.
  const tag =
    process.env.SESSION_TAG === '0'
      ? ''
      : `${active.emoji ? active.emoji + ' ' : ''}[${active.name}] `;

  if (sessionChains.has(active.id)) {
    await ctx.reply(
      `${tag}⏳ Still working on an earlier message in this session — this one is queued behind it. /cancel to stop the current one.`
    );
  }

  const pingInterval = setInterval(() => {
    ctx.sendChatAction('typing').catch(() => {});
  }, 4000);

  // A single status message we keep editing while the task runs, so a long job
  // never looks dead. Best-effort — if Telegram rejects an edit we ignore it.
  const startedAt = Date.now();
  const status = await ctx.reply(`${tag}⚙️ Working…`).catch(() => null);
  const onProgress = (label) => {
    if (!status) return;
    const mins = Math.round((Date.now() - startedAt) / 60000);
    const age = mins >= 1 ? ` ${mins}m` : '';
    ctx.telegram
      .editMessageText(ctx.chat.id, status.message_id, undefined, `${tag}⚙️ Working${age} — ${label}`)
      .catch(() => {});
  };

  try {
    const { text: reply, provider, contextTokens, stoppedEarly } = await runQueued(active.id, async () => {
      // Re-read the row: a queued-ahead prompt may have just stored the
      // CLI session id we need to --resume, or a /model change.
      const fresh = getSessionById(active.id) || active;
      const flightId = addInflight({
        chat_id: ctx.chat.id,
        session_id: fresh.id,
        prompt: promptText.slice(0, 1000),
      });
      try {
        return await routePrompt(fresh, promptText, { onProgress });
      } finally {
        removeInflight(flightId);
      }
    });

    if (contextTokens) setSessionContextTokens(active.id, contextTokens);
    let suffix = provider === 'agentrouter' ? '\n\n[via AgentRouter fallback]' : '';
    if (stoppedEarly) {
      suffix += `\n\n⏸ Paused at the ${MAX_TURNS_INFO}-step limit (keeps runaway usage in check). Reply "continue" to carry on.`;
    }
    if (contextTokens && contextTokens >= CONTEXT_WARN_TOKENS) {
      suffix += `\n\n⚠️ This session's context is ~${Math.round(contextTokens / 1000)}k tokens — /compact to shrink it (Claude summarizes itself, same conversation continues), or /renew for a harder reset if that's not enough.`;
    }
    const body = reply + suffix;
    const size = TELEGRAM_CHUNK_LIMIT - tag.length;
    for (let i = 0; i < body.length; i += size) {
      await ctx.reply(tag + body.slice(i, i + size)).catch(() => {});
    }
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] session=${active.name} provider=${err.provider || '?'} ${err.stack || err.message}`
    );
    await ctx.reply(tag + friendlyError(err)).catch(() => {});
  } finally {
    clearInterval(pingInterval);
    if (status) ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
  }
}

// On startup, anything still in the inflight table was killed mid-task by a
// crash/restart. Tell each affected chat, then clear the table.
export async function notifyInterrupted(bot) {
  let rows = [];
  try {
    rows = takeAllInflight();
  } catch {
    return;
  }
  for (const r of rows) {
    const snippet = r.prompt.length > 300 ? `${r.prompt.slice(0, 300)}…` : r.prompt;
    try {
      await bot.telegram.sendMessage(
        r.chat_id,
        `⚠️ A task was interrupted by a restart and didn't finish:\n\n"${snippet}"\n\nResend it if you still need it.`
      );
    } catch {
      /* chat unreachable — skip */
    }
  }
}

// Claude Code's accepted model aliases; also allow any full `claude-*` id.
const MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'sonnet[1m]', 'opusplan'];

function normalizeModel(arg) {
  const a = arg.trim();
  if (/^(default|clear|none|reset|plan)$/i.test(a)) return { value: null };
  const lower = a.toLowerCase();
  if (MODEL_ALIASES.includes(lower)) return { value: lower };
  if (/^claude-[a-z0-9.\[\]-]+$/i.test(a)) return { value: a };
  return {
    error: `"${a}" isn't a Claude Code model. Use: ${MODEL_ALIASES.join(', ')}, a full claude-* id, or "default".`,
  };
}

function safeName(name, fallbackExt = '') {
  const base = path
    .basename(String(name || ''))
    .replace(/[^\w.\-]+/g, '_')
    .replace(/^_+/, '')
    .slice(-120);
  return base && base !== '_' ? base : `file-${Date.now()}${fallbackExt}`;
}

async function saveToSession(ctx, session, fileId, filename) {
  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(String(link));
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = path.join(session.working_dir, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, filename);
  fs.writeFileSync(dest, buf);
  return dest;
}

async function handleAttachment(ctx, { fileId, filename, fileSize }) {
  const session = currentSession(ctx.chat.id);
  if (!session) {
    return ctx.reply('No active session. Create one with /new <name> first.');
  }
  if (fileSize && fileSize > MAX_ATTACHMENT_BYTES) {
    return ctx.reply("That file is over 20 MB — Telegram won't let a bot download it.");
  }

  let dest;
  try {
    dest = await saveToSession(ctx, session, fileId, filename);
  } catch (err) {
    return ctx.reply(`Couldn't save the file: ${err.message}`);
  }

  const caption = (ctx.message.caption || '').trim();
  const promptText =
    `[The user attached a file, saved at: ${dest}]\n\n` +
    (caption || 'Open it, tell me what it contains, then wait for instructions.');

  await deliver(ctx, promptText);
}

async function handleVoice(ctx, voice) {
  const session = currentSession(ctx.chat.id);
  if (!session) {
    return ctx.reply('No active session. Create one with /new <name> first.');
  }
  if (voice.file_size && voice.file_size > MAX_ATTACHMENT_BYTES) {
    return ctx.reply("That voice note is over 20 MB — Telegram won't let a bot download it.");
  }

  const tmp = path.join(os.tmpdir(), `voice-in-${Date.now()}.oga`);
  let transcript;
  try {
    const link = await ctx.telegram.getFileLink(voice.file_id);
    const res = await fetch(String(link));
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    await ctx.sendChatAction('typing').catch(() => {});
    transcript = await transcribe(tmp);
  } catch (err) {
    await ctx.reply(`Couldn't transcribe that: ${err.message}`).catch(() => {});
    return;
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }

  if (!transcript) {
    return ctx.reply("Couldn't make out that audio — try again, closer to the mic, or just type it.");
  }
  await ctx.reply(`🎙️ ${transcript}`).catch(() => {});
  await deliver(ctx, transcript);
}

export function createBot() {
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  if (approvalGateOn()) startApprovalListener(bot);
  initReminder(bot);

  bot.use((ctx, next) => {
    const fromId = String(ctx.from?.id || '');
    if (fromId !== ALLOWED_USER_ID) {
      // Silently drop — don't reveal the bot's existence/behaviour to strangers.
      return;
    }
    return next();
  });

  bot.start((ctx) => ctx.reply(HELP));
  bot.help((ctx) => ctx.reply(HELP));
  bot.command('guide', (ctx) => ctx.reply(HELP));

  bot.command('new', async (ctx) => {
    // First line only — a pasted prompt on the next line isn't part of the name.
    const parts = ctx.message.text.split('\n')[0].split(/\s+/).slice(1).filter(Boolean);
    // An emoji as the first or last token is the session's emoji; the rest is the name.
    let emoji = null;
    if (parts.length && EMOJI_RE.test(parts[0])) emoji = parts.shift();
    else if (parts.length && EMOJI_RE.test(parts[parts.length - 1])) emoji = parts.pop();
    const name = parts.join(' ').trim();
    if (!name) return ctx.reply('Usage: /new [emoji] <session-name>');
    try {
      const session = newSession(name, emoji);
      switchSession(ctx.chat.id, name);
      await ctx.reply(
        `${session.emoji} Session "${name}" created and active.\nWorking dir: ${session.working_dir}`
      );
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.command('sessions', async (ctx) => {
    const sessions = listAllSessions();
    if (sessions.length === 0) return ctx.reply('No sessions yet. Use /new <name> to create one.');
    const lines = sessions.map(
      (s) =>
        `${s.emoji || '•'} ${s.name} — ${s.last_active} · ${s.active_provider} · ${s.model || 'default'}`
    );
    await ctx.reply(lines.join('\n'));
  });

  bot.command('switch', async (ctx) => {
    const name = ctx.message.text.split('\n')[0].split(' ').slice(1).join(' ').trim();
    if (!name) return ctx.reply('Usage: /switch <session-name>');
    try {
      switchSession(ctx.chat.id, name);
      await ctx.reply(`Switched to session "${name}".`);
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.command('kill', async (ctx) => {
    const name = ctx.message.text.split('\n')[0].split(' ').slice(1).join(' ').trim();
    if (!name) return ctx.reply('Usage: /kill <session-name>');
    try {
      const s = killSession(name);
      await ctx.reply(
        `${s.emoji || ''} Session "${s.name}" ended.\n` +
          `Files kept at ${s.working_dir} — /purge ${s.name} to delete them and free disk space.`
      );
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.command('renew', async (ctx) => {
    const arg = ctx.message.text.split('\n')[0].split(' ').slice(1).join(' ').trim();
    const target = arg || currentSession(ctx.chat.id)?.name;
    if (!target) return ctx.reply('Usage: /renew [session-name] (defaults to the active session)');
    try {
      const s = renewSession(target);
      await ctx.reply(
        `${s.emoji || ''} Conversation reset for "${s.name}" — files/git/node_modules untouched.\n` +
          `Your next message starts fresh, auto-seeded with a summary of recent history.`
      );
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  // Claude Code's own /compact — same mechanism as on a PC terminal: Claude
  // writes its own summary of the WHOLE conversation and keeps the same
  // --resume chain, so nothing about session state changes on the bot's side.
  // Much better continuity than /renew, which only reseeds from the last 20
  // raw messages. Just forwards the literal command as this session's prompt.
  bot.command('compact', (ctx) => {
    detach(deliver(ctx, '/compact'));
  });

  // Background servers/tunnels Claude started via scripts/daemon.sh.
  bot.command('servers', (ctx) => {
    const rest = ctx.message.text.split('\n')[0].split(/\s+/).slice(1);
    const sub = (rest[0] || 'list').toLowerCase();
    const daemonSh = fileURLToPath(new URL('../scripts/daemon.sh', import.meta.url));
    const run = (args) =>
      new Promise((res) => {
        const c = spawn('bash', [daemonSh, ...args]);
        let out = '';
        c.stdout.on('data', (d) => (out += d));
        c.stderr.on('data', (d) => (out += d));
        c.on('error', (e) => res(`error: ${e.message}`));
        c.on('close', () => res(out.trim() || '(no output)'));
      });

    detach(
      (async () => {
        if (sub === 'stop' && rest[1]) {
          return ctx.reply(await run(['stop', rest[1]]));
        }
        if (sub === 'logs' && rest[1]) {
          const t = await run(['logs', rest[1], rest[2] || '40']);
          return ctx.reply('```\n' + t.slice(0, 3500) + '\n```', { parse_mode: 'Markdown' }).catch(() =>
            ctx.reply(t.slice(0, 3800))
          );
        }
        const t = await run(['list']);
        await ctx.reply(
          `Background servers/tunnels:\n\n${t}\n\n` +
            `/servers stop <name> · /servers logs <name>`
        );
      })()
    );
  });

  bot.command('archived', async (ctx) => {
    const rows = listAllArchived();
    if (rows.length === 0) return ctx.reply('No archived sessions.');
    const lines = rows.map(
      (s) => `${s.emoji || '•'} ${s.name} — killed ${s.archived_at}`
    );
    await ctx.reply(lines.join('\n') + '\n\n/purge <name> to permanently delete one.');
  });

  bot.command('purge', (ctx) => {
    const arg = ctx.message.text.split('\n')[0].split(/\s+/).slice(1).join(' ').trim();
    const m = arg.match(/^(.*?)\s+confirm$/i);
    const name = (m ? m[1] : arg).trim();
    const confirmed = !!m;
    if (!name) return ctx.reply('Usage: /purge <archived-session-name>');

    detach(
      (async () => {
        try {
          if (!confirmed) {
            const { bytes } = await diskReport().then((r) => ({
              bytes: r.rows.find((x) => x.name.toLowerCase() === name.toLowerCase())?.bytes,
            }));
            const sizeStr = bytes ? ` (~${(bytes / 1024 / 1024).toFixed(0)} MB)` : '';
            return ctx.reply(
              `This permanently deletes "${name}"'s files${sizeStr} — cannot be undone.\n` +
                `Confirm: /purge ${name} confirm`
            );
          }
          const s = purgeSession(name);
          await ctx.reply(`🗑 Purged "${s.name}" — disk space freed.`);
        } catch (err) {
          await ctx.reply(`Error: ${err.message}`);
        }
      })()
    );
  });

  bot.command('disk', (ctx) => {
    detach(
      (async () => {
        await ctx.reply('📊 Checking disk usage…');
        try {
          const { disk, rows } = await diskReport();
          const gb = (n) => (n / 1024 ** 3).toFixed(1);
          const diskLine = disk
            ? `Disk: ${gb(disk.used)}GB used / ${gb(disk.size)}GB (${gb(disk.avail)}GB free)\n\n`
            : '';
          const top = rows
            .slice(0, 15)
            .map(
              (r) =>
                `${r.archived ? '💀' : r.emoji || '•'} ${r.name} — ${(r.bytes / 1024 / 1024).toFixed(0)} MB${r.archived ? ' (archived)' : ''}`
            )
            .join('\n');
          await ctx.reply(
            diskLine +
              (top || 'No sessions yet.') +
              (rows.length > 15 ? `\n…and ${rows.length - 15} more` : '') +
              '\n\n💀 = archived (killed) — /purge <name> to delete and reclaim space.'
          );
        } catch (err) {
          await ctx.reply(`Couldn't check disk usage: ${err.message}`);
        }
      })()
    );
  });

  bot.command('status', async (ctx) => {
    const session = currentSession(ctx.chat.id);
    if (!session) return ctx.reply('No active session. Use /new <name> first.');
    const running = sessionChains.has(session.id) ? '\nRunning: a task is in progress' : '';
    const ctx_k = session.context_tokens
      ? `\nContext: ~${Math.round(session.context_tokens / 1000)}k tokens${
          session.context_tokens >= CONTEXT_WARN_TOKENS ? ' (heavy — try /compact)' : ''
        }`
      : '';
    const waiting = pendingCount(String(ctx.chat.id));
    await ctx.reply(
      `${session.emoji || ''} Active session: ${session.name}\n` +
        `Provider last used: ${session.active_provider}\n` +
        `Model: ${effectiveModel(session)}\n` +
        `Working dir: ${session.working_dir}${ctx_k}${running}` +
        (waiting ? `\nApprovals waiting: ${waiting} (/approve · /deny)` : '')
    );
  });

  bot.command('model', async (ctx) => {
    const arg = ctx.message.text.split('\n')[0].split(' ').slice(1).join(' ').trim();
    const session = currentSession(ctx.chat.id);
    if (!session) return ctx.reply('No active session. Use /new <name> first.');
    if (!arg) {
      return ctx.reply(
        `Model for "${session.name}": ${effectiveModel(session)}\n\n` +
          `Set for this session: /model sonnet  (also opus, haiku, sonnet[1m], full claude-* id)\n` +
          `Reset this session: /model default\n` +
          `Default for ALL new sessions: put CLAUDE_MODEL=sonnet in .env (no per-session /model needed)\n\n` +
          `Subscription model only — the AgentRouter fallback uses AGENTROUTER_MODEL from .env.`
      );
    }
    const norm = normalizeModel(arg);
    if (norm.error) return ctx.reply(norm.error);
    setSessionModel(session.id, norm.value);
    return ctx.reply(
      norm.value
        ? `Model for "${session.name}" set to ${norm.value}. Applies to your next message.`
        : `Model for "${session.name}" reset to plan default.`
    );
  });

  bot.command('emoji', async (ctx) => {
    const arg = ctx.message.text.split('\n')[0].split(/\s+/).slice(1).join('').trim();
    if (/^all$/i.test(arg)) {
      const n = backfillEmojis();
      return ctx.reply(
        n ? `Assigned an emoji to ${n} session${n === 1 ? '' : 's'}.` : 'Every session already has one.'
      );
    }
    const session = currentSession(ctx.chat.id);
    if (!session) return ctx.reply('No active session. Use /new <name> first.');
    if (!arg) {
      return ctx.reply(
        `${session.emoji || '(none)'} is the emoji for "${session.name}".\n` +
          `Change it: /emoji 🐙   ·   Backfill all sessions: /emoji all`
      );
    }
    if (!EMOJI_RE.test(arg)) return ctx.reply('Send a single emoji, e.g. /emoji 🐙');
    setSessionEmoji(session.id, arg);
    return ctx.reply(`${arg} set for "${session.name}".`);
  });

  bot.command('cancel', async (ctx) => {
    const session = currentSession(ctx.chat.id);
    if (!session) return ctx.reply('No active session.');
    const killed = cancelRun(session.id) | cancelPersistent(session.id);
    return ctx.reply(
      killed ? 'Stopping the running task…' : 'Nothing is running for this session right now.'
    );
  });

  const decide = (approve, id, chatId) => resolveApproval({ id, chatId: String(chatId), approve });

  bot.command('approve', (ctx) => {
    const id = ctx.message.text.split('\n')[0].split(/\s+/)[1];
    const r = decide(true, id, ctx.chat.id);
    return ctx.reply(r.ok ? `✅ Approved ${r.toolName} in [${r.sessionName}].` : 'No approval request is waiting.');
  });
  bot.command('deny', (ctx) => {
    const id = ctx.message.text.split('\n')[0].split(/\s+/)[1];
    const r = decide(false, id, ctx.chat.id);
    return ctx.reply(r.ok ? `⛔ Denied ${r.toolName} in [${r.sessionName}].` : 'No approval request is waiting.');
  });
  bot.action(/^apv:(\d+)$/, (ctx) => {
    const r = decide(true, ctx.match[1], ctx.chat.id);
    return ctx.answerCbQuery(r.ok ? 'Approved' : 'Already handled');
  });
  bot.action(/^dny:(\d+)$/, (ctx) => {
    const r = decide(false, ctx.match[1], ctx.chat.id);
    return ctx.answerCbQuery(r.ok ? 'Denied' : 'Already handled');
  });

  bot.command('reauth', (ctx) => {
    const token = ctx.message.text.split('\n')[0].split(/\s+/).slice(1).join('').trim();
    if (!token) {
      return ctx.reply(
        'Refresh the Claude subscription token:\n\n' +
          '1. On any machine with a terminal, run:  claude setup-token\n' +
          '2. Open the URL it prints, approve, copy the token (starts sk-ant-oat…)\n' +
          '3. Send here:  /reauth sk-ant-oat01-…\n\n' +
          "It's long-lived (~1 year). I store it outside the repo and use it for every subscription run — no more silent expiry."
      );
    }
    if (!/^sk-ant-oat/.test(token)) {
      return ctx.reply("That doesn't look like a setup-token (should start with `sk-ant-oat`). Not saved.");
    }
    detach(
      (async () => {
        try {
          fs.mkdirSync(path.dirname(OAUTH_TOKEN_FILE), { recursive: true });
          fs.writeFileSync(OAUTH_TOKEN_FILE, token + '\n', { mode: 0o600 });
        } catch (e) {
          return ctx.reply(`Couldn't save the token: ${e.message}`);
        }
        ctx.deleteMessage().catch(() => {}); // best-effort: keep the token out of chat history
        await ctx.reply('Token saved — verifying…').catch(() => {});
        const r = await verifyAuth();
        await ctx
          .reply(
            r.ok
              ? `✅ Subscription auth is working again.`
              : `❌ Saved, but auth still failing:\n${r.detail}\n\nDouble-check the token from claude setup-token.`
          )
          .catch(() => {});
      })()
    );
  });

  bot.command('setuptoken', (ctx) => {
    const chatId = ctx.chat.id;
    endTokenSetup(chatId); // reset any prior attempt

    const env = { ...process.env };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    let child;
    try {
      child = spawn('claude', ['setup-token'], { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (e) {
      return ctx.reply(`Couldn't start setup-token: ${e.message}`);
    }

    const timer = setTimeout(() => {
      ctx.reply('setup-token timed out (10 min). Send /setuptoken to retry.').catch(() => {});
      endTokenSetup(chatId);
    }, 600000);
    tokenSetups.set(chatId, { child, timer });

    let buf = '';
    let urlSent = false;
    let captured = false;
    const onData = (d) => {
      const raw = d.toString();
      buf += raw;

      // Relay output so the flow is visible — but never leak the token itself.
      const shown = raw.replace(/sk-ant-oat[\w-]+/g, 'sk-ant-oat…').trim();
      if (shown) ctx.reply(shown.slice(0, 3500)).catch(() => {});

      if (!urlSent) {
        const m = buf.match(/https?:\/\/\S+/);
        if (m) {
          urlSent = true;
          ctx
            .reply(`Open this, approve, then send:\n/authcode <the code shown>\n\n${m[0]}`)
            .catch(() => {});
        }
      }

      const tok = buf.match(/sk-ant-oat[\w-]+/);
      if (tok && !captured) {
        captured = true;
        try {
          fs.mkdirSync(path.dirname(OAUTH_TOKEN_FILE), { recursive: true });
          fs.writeFileSync(OAUTH_TOKEN_FILE, tok[0] + '\n', { mode: 0o600 });
        } catch (e) {
          ctx.reply(`Got a token but couldn't save it: ${e.message}`).catch(() => {});
          endTokenSetup(chatId);
          return;
        }
        endTokenSetup(chatId);
        ctx.reply('✅ New token captured and saved — verifying…').catch(() => {});
        detach(
          verifyAuth().then((r) =>
            ctx.reply(
              r.ok ? '✅ Subscription auth is working.' : `❌ Saved but auth failing: ${r.detail}`
            )
          )
        );
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      ctx.reply(`setup-token error: ${e.message}`).catch(() => {});
      endTokenSetup(chatId);
    });
    child.on('close', () => {
      if (tokenSetups.has(chatId) && !captured) {
        ctx
          .reply('setup-token exited without a token. Send /setuptoken to retry.')
          .catch(() => {});
        endTokenSetup(chatId);
      }
    });

    ctx.reply("Starting claude setup-token — I'll send the approve link when it appears.").catch(() => {});
  });

  bot.command('authcode', (ctx) => {
    const s = tokenSetups.get(ctx.chat.id);
    if (!s) return ctx.reply('No /setuptoken in progress. Send /setuptoken first.');
    const code = ctx.message.text.split('\n')[0].split(/\s+/).slice(1).join('').trim();
    if (!code) return ctx.reply('Usage: /authcode <code from the approve page>');
    try {
      s.child.stdin.write(code + '\n');
      ctx.reply('Code sent — waiting for the token…').catch(() => {});
      ctx.deleteMessage().catch(() => {});
    } catch (e) {
      ctx.reply(`Couldn't send the code: ${e.message}`).catch(() => {});
    }
  });

  bot.command('preview', (ctx) => {
    const session = currentSession(ctx.chat.id);
    if (!session) return ctx.reply('No active session. Use /new <name> first.');
    const rest = ctx.message.text.split('\n')[0].split(' ').slice(1).join(' ').trim();
    let mode = 'static';
    let port;
    const devMatch = rest.match(/^dev(?:\s+(\d+))?$/i);
    if (devMatch) {
      mode = 'dev';
      if (devMatch[1]) port = Number(devMatch[1]);
    } else if (/^\d+$/.test(rest)) {
      mode = 'dev';
      port = Number(rest);
    }

    detach(
      (async () => {
        await ctx.reply(
          `📸 Rendering ${mode === 'dev' ? `dev server${port ? ` :${port}` : ''}` : 'static site'}…`
        );
        const busy = setInterval(() => ctx.sendChatAction('upload_photo').catch(() => {}), 4000);
        let png;
        try {
          png = await capturePreview(session.working_dir, { mode, port });
          await ctx.replyWithPhoto({ source: png });
        } catch (err) {
          await ctx.reply(`Preview failed: ${err.message}`);
        } finally {
          clearInterval(busy);
          if (png) fs.promises.unlink(png).catch(() => {});
        }
      })()
    );
  });

  bot.command('tunnel', (ctx) => {
    const session = currentSession(ctx.chat.id);
    if (!session) return ctx.reply('No active session. Use /new <name> first.');
    const rest = ctx.message.text.split('\n')[0].split(/\s+/).slice(1).join(' ').trim();

    if (/^stop$/i.test(rest)) {
      return ctx.reply(stopTunnel(session.id) ? '🔌 Tunnel closed.' : 'No tunnel open for this session.');
    }

    let mode = 'static';
    let port;
    const devMatch = rest.match(/^dev(?:\s+(\d+))?$/i);
    if (devMatch) {
      mode = 'dev';
      if (devMatch[1]) port = Number(devMatch[1]);
    } else if (/^\d+$/.test(rest)) {
      mode = 'dev';
      port = Number(rest);
    }

    detach(
      (async () => {
        await ctx.reply(
          `🌐 Opening a public tunnel to ${mode === 'dev' ? `the dev server${port ? ` :${port}` : ''}` : 'the static site'}…`
        );
        try {
          const { url, reused } = await openTunnel(session, {
            mode,
            port,
            onExpire: (reason) =>
              ctx
                .reply(
                  `🔌 [${session.emoji || ''} ${session.name}] tunnel closed (${reason === 'max' ? 'max lifetime' : 'idle'}). /tunnel to reopen.`
                )
                .catch(() => {}),
          });
          await ctx.reply(
            `${reused ? '♻️ Existing tunnel' : '✅ Live'}: ${url}\n\n` +
              `⚠️ Public link — anyone with it reaches this dev server. /tunnel stop when done. Auto-closes when idle.`
          );
        } catch (err) {
          await ctx.reply(`Tunnel failed: ${err.message}`);
        }
      })()
    );
  });

  bot.on('text', (ctx) => {
    if (ctx.message.text.startsWith('/')) {
      return ctx.reply('Unknown command. Send /help for the list.');
    }
    detach(deliver(ctx, ctx.message.text));
  });

  bot.on('photo', (ctx) => {
    const photos = ctx.message.photo || [];
    const largest = photos[photos.length - 1]; // last entry = highest resolution
    if (!largest) return;
    detach(
      handleAttachment(ctx, {
        fileId: largest.file_id,
        filename: `photo-${Date.now()}.jpg`,
        fileSize: largest.file_size,
      })
    );
  });

  bot.on('document', (ctx) => {
    const doc = ctx.message.document;
    if (!doc) return;
    detach(
      handleAttachment(ctx, {
        fileId: doc.file_id,
        filename: safeName(doc.file_name),
        fileSize: doc.file_size,
      })
    );
  });

  bot.on('voice', (ctx) => {
    const voice = ctx.message.voice;
    if (!voice) return;
    if (!voiceSupported()) {
      return ctx.reply('Voice notes need whisper.cpp on the VPS — not set up. Send text instead.');
    }
    detach(handleVoice(ctx, voice));
  });

  bot.telegram
    .setMyCommands([
      { command: 'new', description: 'Create a session and make it active' },
      { command: 'sessions', description: 'List all sessions' },
      { command: 'switch', description: 'Switch the active session' },
      { command: 'compact', description: 'Summarize this chat to cut cost' },
      { command: 'renew', description: 'Harder reset, keep files' },
      { command: 'kill', description: 'End a session (files kept)' },
      { command: 'archived', description: 'List killed sessions on disk' },
      { command: 'purge', description: 'Permanently delete a killed session' },
      { command: 'disk', description: 'Show disk usage per session' },
      { command: 'status', description: 'Show the active session' },
      { command: 'model', description: 'Show or set the model for this session' },
      { command: 'emoji', description: 'Set the emoji shown in this session tag' },
      { command: 'preview', description: 'Screenshot the site in this session' },
      { command: 'tunnel', description: 'Managed public URL for one site' },
      { command: 'servers', description: 'Background servers/tunnels Claude started' },
      { command: 'cancel', description: 'Stop the running task' },
      { command: 'approve', description: 'Approve a pending action' },
      { command: 'deny', description: 'Deny a pending action' },
      { command: 'reauth', description: 'Apply a Claude subscription token you have' },
      { command: 'setuptoken', description: 'Mint a new subscription token from phone' },
      { command: 'authcode', description: 'Send the approval code during /setuptoken' },
      { command: 'help', description: 'Show the guide' },
    ])
    .catch(() => {});

  return bot;
}
