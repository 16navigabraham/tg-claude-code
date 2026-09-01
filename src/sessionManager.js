import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import {
  createSession,
  getSessionByName,
  getSessionById,
  listSessions,
  listArchivedSessions,
  archiveSession,
  clearCliSessionIds,
  setSessionEmoji,
  deleteSession as dbDeleteSession,
  setActiveSessionForChat,
  getActiveSessionForChat,
} from './db.js';
import { dropPersistentRuntime } from './persistentClaude.js';
import { stopTunnel } from './tunnel.js';

const DAEMON_SH = fileURLToPath(new URL('../scripts/daemon.sh', import.meta.url));
function stopDaemonsUnder(dir) {
  try {
    spawn('bash', [DAEMON_SH, 'stop-under', dir], { stdio: 'ignore' });
  } catch {
    /* best effort */
  }
}

export { getSessionById, setSessionEmoji };

const SESSIONS_ROOT = process.env.SESSIONS_ROOT || './sessions';

// Visually distinct, single-glyph-ish emoji for auto-tagging sessions.
const EMOJI_PALETTE = [
  '🚀', '🐙', '🦊', '🤖', '🌵', '🐳', '🍄', '⚡', '🔮', '🧩',
  '🛰', '🦉', '🐝', '🌊', '🔥', '🍁', '🎯', '🧠', '🦁', '🐧',
  '🌙', '🍋', '🧵', '🪐', '🦋', '🐢', '🌻', '🥁', '🧊', '🦕',
  '🎨', '🔗', '🧭', '🐆', '🍀', '🫐', '🪁', '🦩', '🌶', '🧲',
];

// Deterministic-ish pick from the session id, skipping emoji already in use.
function pickEmoji(id) {
  const used = new Set(listSessions().map((s) => s.emoji).filter(Boolean));
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  for (let i = 0; i < EMOJI_PALETTE.length; i++) {
    const e = EMOJI_PALETTE[(h + i) % EMOJI_PALETTE.length];
    if (!used.has(e)) return e;
  }
  return EMOJI_PALETTE[h % EMOJI_PALETTE.length];
}

export function newSession(name, emoji) {
  if (listSessions().some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`Session "${name}" already exists (names are case-insensitive).`);
  }
  const id = crypto.randomUUID();
  const base = path.join(SESSIONS_ROOT, id);
  const working_dir = path.join(base, 'workdir');
  // Separate .claude/ state directories per provider — this is the fix for the
  // cross-provider 400 error: a session's conversation history must never be
  // resumed under a different provider than the one that produced it.
  const claude_session_dir = path.join(base, 'claude-state');
  const agentrouter_session_dir = path.join(base, 'agentrouter-state');

  fs.mkdirSync(working_dir, { recursive: true });
  fs.mkdirSync(claude_session_dir, { recursive: true });
  fs.mkdirSync(agentrouter_session_dir, { recursive: true });

  createSession({
    id,
    name,
    working_dir,
    claude_session_dir,
    agentrouter_session_dir,
    emoji: emoji || pickEmoji(id),
  });
  return getSessionByName(name);
}

export function listAllSessions() {
  return listSessions();
}

// Give every emoji-less session a distinct one. Returns how many were set.
export function backfillEmojis() {
  let n = 0;
  for (const s of listSessions()) {
    if (!s.emoji) {
      setSessionEmoji(s.id, pickEmoji(s.id));
      n++;
    }
  }
  return n;
}

// Match a session: exact name → case-insensitive exact → unique
// case-insensitive prefix. Prefix + case-insensitive matching keeps commands
// usable when a name has odd casing or junk (e.g. a pasted prompt after /new).
function resolveSession(name) {
  const q = name.trim();
  const all = listSessions();
  const exact = all.find((s) => s.name === q);
  if (exact) return exact;
  const ci = all.filter((s) => s.name.toLowerCase() === q.toLowerCase());
  if (ci.length === 1) return ci[0];
  const pref = all.filter((s) => s.name.toLowerCase().startsWith(q.toLowerCase()));
  if (pref.length === 1) return pref[0];
  if (pref.length > 1) {
    throw new Error(`"${q}" matches ${pref.length} sessions — use a longer prefix.`);
  }
  throw new Error(`No session named "${q}".`);
}

export function switchSession(chatId, name) {
  const session = resolveSession(name);
  setActiveSessionForChat(chatId, session.id);
  return session;
}

export function currentSession(chatId) {
  return getActiveSessionForChat(chatId);
}

export function killSession(name) {
  const session = resolveSession(name);
  stopTunnel(session.id);
  stopDaemonsUnder(session.working_dir); // dev servers / tunnels Claude started via daemon.sh
  dropPersistentRuntime(session.id);
  // Free the (small) Claude state dirs now; keep the working dir (code,
  // node_modules, uploads) and the DB row (marked archived) so the session is
  // still findable by name for /purge later, and so a name can't silently
  // collide with in-progress work.
  fs.rmSync(session.claude_session_dir, { recursive: true, force: true });
  fs.rmSync(session.agentrouter_session_dir, { recursive: true, force: true });
  archiveSession(session.id);
  return session;
}

export function listAllArchived() {
  return listArchivedSessions();
}

// Reset the Claude conversation for a session while keeping its working_dir
// intact (files, git clone, node_modules untouched) — the fix for "context is
// heavy" that doesn't also throw away the actual project. The next message
// starts a fresh --resume chain, auto-seeded from recent plain-text history
// (routePrompt already does this whenever claude_cli_session_id is null).
export function renewSession(name) {
  const session = resolveSession(name);
  dropPersistentRuntime(session.id); // a live process would just keep --resume-ing the old chat
  fs.rmSync(session.claude_session_dir, { recursive: true, force: true });
  fs.rmSync(session.agentrouter_session_dir, { recursive: true, force: true });
  clearCliSessionIds(session.id);
  return session;
}

// Find an archived session by exact/case-insensitive/prefix name match, same
// rules as resolveSession but scoped to the archived set.
function resolveArchived(name) {
  const q = name.trim();
  const all = listArchivedSessions();
  const exact = all.find((s) => s.name === q);
  if (exact) return exact;
  const ci = all.filter((s) => s.name.toLowerCase() === q.toLowerCase());
  if (ci.length === 1) return ci[0];
  const pref = all.filter((s) => s.name.toLowerCase().startsWith(q.toLowerCase()));
  if (pref.length === 1) return pref[0];
  if (pref.length > 1) throw new Error(`"${q}" matches ${pref.length} archived sessions.`);
  throw new Error(`No archived session named "${q}". Use /archived to list.`);
}

// Permanently delete an archived session's working dir + DB row. Irreversible.
export function purgeSession(name) {
  const session = resolveArchived(name);
  fs.rmSync(path.dirname(session.working_dir), { recursive: true, force: true }); // whole session base dir
  dbDeleteSession(session.id);
  return session;
}

function du(dir) {
  return new Promise((resolve) => {
    const child = spawn('du', ['-sb', dir]);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(0));
    child.on('close', () => resolve(Number(out.split(/\s+/)[0]) || 0));
  });
}

function df(dir) {
  return new Promise((resolve) => {
    const child = spawn('df', ['-B1', dir]);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const line = out.trim().split('\n')[1];
      if (!line) return resolve(null);
      const [, size, used, avail] = line.split(/\s+/);
      resolve({ size: Number(size), used: Number(used), avail: Number(avail) });
    });
  });
}

// Disk usage summary: overall filesystem + per-session working-dir sizes
// (active and archived), for deciding what to /purge.
export async function diskReport() {
  const disk = await df(SESSIONS_ROOT);
  const active = listSessions();
  const archived = listArchivedSessions();
  const rows = await Promise.all(
    [...active, ...archived].map(async (s) => ({
      name: s.name,
      emoji: s.emoji,
      archived: !!s.archived_at,
      bytes: await du(s.working_dir),
    }))
  );
  rows.sort((a, b) => b.bytes - a.bytes);
  return { disk, rows };
}
