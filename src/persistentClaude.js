// One long-lived `claude` process per session (like a PC terminal), instead of
// spawn-per-message. Keeps the system prompt + MCP tool definitions warm in
// Anthropic's prompt cache across turns, which is the main reason the bot
// burned the usage limit faster than interactive Claude Code.
//
// Opt-in: PERSISTENT_CLAUDE=1. Subscription path only — the AgentRouter
// fallback stays one-shot.
//
// UNVERIFIED against a live CLI at build time:
//  - the stream-json INPUT line shape ({"type":"user","message":{role,content}})
//  - that `-p --input-format stream-json` keeps the process alive for more
//    turns after emitting a `result` event
// If either is wrong the turn errors cleanly and you can flip the flag back off.

import { spawn } from 'child_process';
import { setCliSessionId } from './db.js';
import {
  parseStreamEvents,
  progressLabel,
  extractText,
  detectRunError,
  hitMaxTurns,
  contextFromEvents,
  ensureSubscriptionAuth,
  seedSettings,
  MAX_TURNS,
  SESSION_SYSTEM_NOTE,
} from './providerRouter.js';
import { approvalGateOn, approvalSpawnArgs } from './approvals.js';

const STALL_MS = Number(process.env.CLAUDE_STALL_TIMEOUT_MS) || 300000;
const MAX_RUNTIME_MS = Number(process.env.CLAUDE_MAX_RUNTIME_MS) || 2700000;
const IDLE_MS = Number(process.env.PERSISTENT_IDLE_MS) || 900000; // kill after 15 min idle
const PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions';
const STRICT_MCP = !!process.env.CLAUDE_STRICT_MCP;

export const persistentEnabled = () => !!process.env.PERSISTENT_CLAUDE;

const runtimes = new Map(); // sessionId -> Runtime

function mkTimerErr(code, ms) {
  const e = new Error(code);
  e.mins = Math.max(1, Math.round(ms / 60000));
  return e;
}

function failTurn(r, err) {
  const t = r.current;
  if (!t) return;
  clearTimeout(t.stallTimer);
  clearTimeout(t.maxTimer);
  r.current = null;
  err.provider = 'claude';
  t.reject(err);
}

function finishTurn(r) {
  const t = r.current;
  if (!t) return;
  clearTimeout(t.stallTimer);
  clearTimeout(t.maxTimer);
  r.current = null;

  const events = parseStreamEvents(t.raw);
  const runErr = detectRunError({ stdout: '', stderr: '', code: 0 }, events);
  if (runErr) {
    runErr.provider = 'claude';
    return t.reject(runErr);
  }
  t.resolve({
    text: extractText(events, t.raw),
    contextTokens: contextFromEvents(events),
    stoppedEarly: hitMaxTurns(events),
  });
}

function onData(r, chunk) {
  r.buf += chunk;
  let nl;
  while ((nl = r.buf.indexOf('\n')) >= 0) {
    const line = r.buf.slice(0, nl);
    r.buf = r.buf.slice(nl + 1);
    if (!line.trim()) continue;

    let evt = null;
    try {
      evt = JSON.parse(line);
    } catch {
      /* partial / non-JSON */
    }

    if (!r.gotInit && evt?.type === 'system' && evt.subtype === 'init' && evt.session_id) {
      r.gotInit = true;
      try {
        setCliSessionId(r.sessionId, 'claude', evt.session_id);
      } catch {
        /* best effort */
      }
    }

    const t = r.current;
    if (!t) continue; // between turns
    t.raw += line + '\n';

    clearTimeout(t.stallTimer);
    t.stallTimer = setTimeout(() => failTurn(r, mkTimerErr('STALLED', STALL_MS)), STALL_MS);

    if (t.onProgress && Date.now() - t.lastProgress > 12000) {
      const label = progressLabel(line);
      if (label) {
        t.lastProgress = Date.now();
        try {
          t.onProgress(label);
        } catch {
          /* reporting must not break the turn */
        }
      }
    }

    if (evt?.type === 'result') {
      finishTurn(r);
      return;
    }
  }
}

function spawnRuntime({ sessionId, cwd, configDir, model, extraEnv, resumeId }) {
  ensureSubscriptionAuth(configDir);
  seedSettings(configDir);

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}), // local time in claude's own messages
    CLAUDE_CONFIG_DIR: configDir,
    ...extraEnv,
  };
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', approvalGateOn() ? 'default' : PERMISSION_MODE,
  ];
  if (model) args.push('--model', model);
  if (MAX_TURNS > 0) args.push('--max-turns', String(MAX_TURNS));
  args.push('--append-system-prompt', SESSION_SYSTEM_NOTE);
  if (STRICT_MCP) args.push('--strict-mcp-config');
  args.push(...approvalSpawnArgs(sessionId));
  if (resumeId) args.push('--resume', resumeId);

  const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});

  const r = {
    sessionId,
    child,
    cwd,
    configDir,
    model: model || null,
    extraEnvKey: JSON.stringify(extraEnv || {}),
    buf: '',
    current: null,
    idleTimer: null,
    gotInit: false,
  };

  child.stdout.on('data', (d) => onData(r, d.toString()));
  child.stderr.on('data', () => {});
  child.on('error', (e) => failTurn(r, e));
  child.on('close', () => {
    if (r.current) failTurn(r, new Error('INTERRUPTED'));
    if (runtimes.get(sessionId) === r) runtimes.delete(sessionId);
  });

  runtimes.set(sessionId, r);
  return r;
}

function kill(sessionId) {
  const r = runtimes.get(sessionId);
  if (!r) return false;
  clearTimeout(r.idleTimer);
  const wasBusy = !!r.current;
  if (r.current) failTurn(r, new Error('INTERRUPTED'));
  try {
    r.child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  runtimes.delete(sessionId);
  return wasBusy;
}

// For /renew — drop any live process for this session so it can't keep
// resuming the conversation we just told the DB to forget. Safe if none exists.
export function dropPersistentRuntime(sessionId) {
  kill(sessionId);
}

// For /cancel — returns true if a turn was actually running.
export function cancelPersistent(sessionId) {
  return kill(sessionId);
}

export function shutdownAllPersistent() {
  for (const id of [...runtimes.keys()]) kill(id);
}

export async function runTurnPersistent({ session, prompt, model, extraEnv, onProgress }) {
  const sessionId = session.id;
  const wantModel = model || null;
  const wantEnvKey = JSON.stringify(extraEnv || {});

  let r = runtimes.get(sessionId);
  if (
    r &&
    (r.model !== wantModel || r.extraEnvKey !== wantEnvKey || r.cwd !== session.working_dir)
  ) {
    kill(sessionId); // config changed (e.g. /model) — recycle
    r = null;
  }
  if (!r) {
    r = spawnRuntime({
      sessionId,
      cwd: session.working_dir,
      configDir: session.claude_session_dir,
      model: wantModel,
      extraEnv,
      resumeId: session.claude_cli_session_id || null,
    });
  }
  if (r.current) throw new Error('busy'); // runQueued should prevent this

  clearTimeout(r.idleTimer);

  const result = await new Promise((resolve, reject) => {
    r.current = {
      resolve,
      reject,
      onProgress,
      raw: '',
      lastProgress: 0,
      stallTimer: setTimeout(() => failTurn(r, mkTimerErr('STALLED', STALL_MS)), STALL_MS),
      maxTimer: setTimeout(() => failTurn(r, mkTimerErr('MAX_RUNTIME', MAX_RUNTIME_MS)), MAX_RUNTIME_MS),
    };
    const msg =
      JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n';
    try {
      r.child.stdin.write(msg);
    } catch (e) {
      failTurn(r, e);
    }
  });

  r.idleTimer = setTimeout(() => kill(sessionId), IDLE_MS); // free RAM; respawn --resume next turn
  return result;
}
