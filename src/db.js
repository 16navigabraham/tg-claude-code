import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.DB_PATH || './data/bot.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE,
  working_dir TEXT NOT NULL,
  claude_session_dir TEXT NOT NULL,
  fallback_session_dir TEXT NOT NULL,
  active_provider TEXT DEFAULT 'claude',
  claude_cli_session_id TEXT,        -- Claude Code's own session id for the subscription-side conversation (for --resume)
  fallback_cli_session_id TEXT,   -- ditto for the fallback-provider-side conversation
  created_at TEXT DEFAULT (datetime('now')),
  last_active TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  provider_used TEXT,
  timestamp TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS chat_active_session (
  chat_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL
);

-- One row per prompt currently being processed. Written when a run starts,
-- deleted when it finishes. Anything left here at startup was killed by a
-- crash/restart mid-task.
CREATE TABLE IF NOT EXISTS inflight (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  started_at TEXT DEFAULT (datetime('now'))
);
`);

// Migrate DBs created before later columns existed.
{
  const cols = db.prepare(`PRAGMA table_info(sessions)`).all().map((c) => c.name);
  if (!cols.includes('claude_cli_session_id')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN claude_cli_session_id TEXT`);
  }
  if (!cols.includes('fallback_cli_session_id')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN fallback_cli_session_id TEXT`);
  }
  if (!cols.includes('model')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN model TEXT`); // subscription --model override; null = plan default
  }
  if (!cols.includes('context_tokens')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN context_tokens INTEGER`); // approx context size on the last turn
  }
  if (!cols.includes('emoji')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN emoji TEXT`); // per-session identifier in the [tag]
  }
  if (!cols.includes('archived_at')) {
    // /kill archives (state dirs removed, workdir kept, name reusable) instead
    // of hard-deleting — otherwise there was no way to find/purge a killed
    // session's leftover workdir (node_modules, clones) by name later.
    db.exec(`ALTER TABLE sessions ADD COLUMN archived_at TEXT`);
  }
}

export function createSession({
  id,
  name,
  working_dir,
  claude_session_dir,
  fallback_session_dir,
  emoji,
}) {
  db.prepare(`
    INSERT INTO sessions (id, name, working_dir, claude_session_dir, fallback_session_dir, emoji)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, working_dir, claude_session_dir, fallback_session_dir, emoji || null);
}

export function setSessionEmoji(id, emoji) {
  db.prepare(`UPDATE sessions SET emoji = ? WHERE id = ?`).run(emoji || null, id);
}

export function getSessionByName(name) {
  return db.prepare(`SELECT * FROM sessions WHERE name = ? AND archived_at IS NULL`).get(name);
}

export function getSessionById(id) {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
}

export function listSessions() {
  return db
    .prepare(`SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY last_active DESC`)
    .all();
}

export function listArchivedSessions() {
  return db
    .prepare(`SELECT * FROM sessions WHERE archived_at IS NOT NULL ORDER BY archived_at DESC`)
    .all();
}

export function archiveSession(id) {
  db.prepare(`UPDATE sessions SET archived_at = datetime('now') WHERE id = ?`).run(id);
}

// Drop the --resume chain on both providers (next turn starts a fresh Claude
// conversation, auto-seeded from recent plain-text history) without touching
// working_dir — the actual project files, git clone, node_modules stay put.
export function clearCliSessionIds(id) {
  db.prepare(
    `UPDATE sessions SET claude_cli_session_id = NULL, fallback_cli_session_id = NULL, context_tokens = NULL WHERE id = ?`
  ).run(id);
}

export function touchSession(id, provider) {
  db.prepare(`
    UPDATE sessions SET last_active = datetime('now'), active_provider = ? WHERE id = ?
  `).run(provider, id);
}

// Record Claude Code's own conversation id for one provider so the next turn
// on that provider can `--resume` it. `provider` is 'claude' or 'fallback'.
export function setCliSessionId(id, provider, cliSessionId) {
  const col =
    provider === 'fallback' ? 'fallback_cli_session_id' : 'claude_cli_session_id';
  db.prepare(`UPDATE sessions SET ${col} = ? WHERE id = ?`).run(cliSessionId, id);
}

export function setSessionModel(id, model) {
  db.prepare(`UPDATE sessions SET model = ? WHERE id = ?`).run(model || null, id);
}

export function setSessionContextTokens(id, n) {
  db.prepare(`UPDATE sessions SET context_tokens = ? WHERE id = ?`).run(n | 0, id);
}

export function deleteSession(id) {
  db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id);
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM chat_active_session WHERE session_id = ?`).run(id);
  db.prepare(`DELETE FROM inflight WHERE session_id = ?`).run(id);
}

// --- in-flight task tracking (for restart recovery) ---
export function addInflight({ chat_id, session_id, prompt }) {
  return db
    .prepare(`INSERT INTO inflight (chat_id, session_id, prompt) VALUES (?, ?, ?)`)
    .run(String(chat_id), session_id, prompt).lastInsertRowid;
}

export function removeInflight(id) {
  db.prepare(`DELETE FROM inflight WHERE id = ?`).run(id);
}

export function takeAllInflight() {
  const rows = db.prepare(`SELECT * FROM inflight ORDER BY id`).all();
  db.prepare(`DELETE FROM inflight`).run();
  return rows;
}

export function setActiveSessionForChat(chatId, sessionId) {
  db.prepare(`
    INSERT INTO chat_active_session (chat_id, session_id) VALUES (?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id
  `).run(String(chatId), sessionId);
}

export function getActiveSessionForChat(chatId) {
  const row = db.prepare(`SELECT session_id FROM chat_active_session WHERE chat_id = ?`).get(String(chatId));
  if (!row) return null;
  return getSessionById(row.session_id);
}

export function logMessage({ session_id, role, content, provider_used }) {
  db.prepare(`
    INSERT INTO messages (session_id, role, content, provider_used)
    VALUES (?, ?, ?, ?)
  `).run(session_id, role, content, provider_used || null);
}

// Plain-text recent history for seeding a fresh provider-side session.
// Deliberately returns conversation text only — never raw Claude Code transcript state.
export function getRecentPlainHistory(session_id, limit = 20) {
  const rows = db.prepare(`
    SELECT role, content FROM messages
    WHERE session_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(session_id, limit);
  return rows.reverse();
}

export default db;
