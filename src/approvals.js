// Bot-side half of the Telegram approval gate. Listens on a Unix socket that
// the per-run approvalServer.js connects to; each request is turned into a
// Telegram message and parked until the user runs /approve or /deny.

import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSessionById } from './db.js';

export const APPROVAL_SOCKET = path.join(os.tmpdir(), `tg-claude-approvals.sock`);
export const approvalGateOn = () => !!process.env.APPROVAL_GATE;

// By default the 🔐 prompt is DELETED once you answer — like a terminal
// permission prompt it just vanishes and doesn't clutter the chat. Set
// APPROVAL_KEEP_LOG=1 to instead leave a "✅ Approved — …" line behind.
const KEEP_LOG = !!process.env.APPROVAL_KEEP_LOG;

const SERVER_JS = fileURLToPath(new URL('./approvalServer.js', import.meta.url));

// Extra `claude` args to route permission prompts through Telegram.
export function approvalSpawnArgs(sessionId) {
  if (!approvalGateOn()) return [];
  const cfg = JSON.stringify({
    mcpServers: {
      approvals: {
        command: process.execPath,
        args: [SERVER_JS],
        env: { APPROVAL_SOCKET, APPROVAL_SESSION_ID: String(sessionId || '') },
      },
    },
  });
  return ['--mcp-config', cfg, '--permission-prompt-tool', 'mcp__approvals__approval_prompt'];
}

let botRef = null;
let seq = 0;
// id -> { chatId, sessionName, toolName, summary, respond, timer }
const pending = new Map();

function summarize(toolName, input) {
  const i = input || {};
  let hint = '';
  if (i.command) hint = String(i.command).replace(/\s+/g, ' ').slice(0, 300);
  else if (i.file_path || i.path) {
    hint = String(i.file_path || i.path).split('/').filter(Boolean).pop() || '';
  } else if (i.url) hint = String(i.url).slice(0, 200);
  else if (i.pattern) hint = String(i.pattern).slice(0, 120);
  else if (typeof i === 'string') hint = i.slice(0, 300);
  return `${toolName}${hint ? ` — ${hint}` : ''}`;
}

function handleConn(sock) {
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString();
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    let msg;
    try {
      msg = JSON.parse(buf.slice(0, nl));
    } catch {
      sock.end(JSON.stringify({ decision: 'allow' }) + '\n');
      return;
    }

    const session = msg.sessionId ? getSessionById(msg.sessionId) : null;
    // Single-user bot: the owner's DM chat id === their user id.
    const chatId = process.env.ALLOWED_TELEGRAM_USER_ID;
    if (!botRef || !chatId) {
      sock.end(JSON.stringify({ decision: 'allow' }) + '\n');
      return;
    }

    const id = ++seq;
    const summary = summarize(msg.tool_name, msg.input);
    let msgId = null;
    const respond = (decision, message) => {
      const p = pending.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(id);
      try {
        sock.end(JSON.stringify({ decision, message }) + '\n');
      } catch {
        /* socket gone */
      }
      if (msgId) {
        if (KEEP_LOG) {
          botRef.telegram
            .editMessageText(
              chatId,
              msgId,
              undefined,
              `${decision === 'allow' ? '✅ Approved' : '⛔ Denied'} - ${summary}`
            )
            .catch(() => {});
        } else {
          // Vanish, like a terminal prompt once answered.
          botRef.telegram.deleteMessage(chatId, msgId).catch(() => {});
        }
      }
    };
    const timer = setTimeout(() => respond('deny', 'No response — auto-denied after 15 min.'), 15 * 60 * 1000);
    pending.set(id, {
      chatId,
      sessionName: session?.name || '?',
      toolName: msg.tool_name,
      summary,
      respond,
      timer,
      get msgId() {
        return msgId;
      },
    });

    botRef.telegram
      .sendMessage(
        chatId,
        `🔐 [${session?.emoji || ''} ${session?.name || 'session'}] wants to run:\n\n${summary}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve', callback_data: `apv:${id}` },
                { text: '⛔ Deny', callback_data: `dny:${id}` },
              ],
            ],
          },
        }
      )
      .then((m) => {
        msgId = m.message_id;
      })
      .catch(() => {});
  });
  sock.on('error', () => {});
}

export function startApprovalListener(bot) {
  botRef = bot;
  try {
    if (fs.existsSync(APPROVAL_SOCKET)) fs.unlinkSync(APPROVAL_SOCKET);
  } catch {
    /* ignore */
  }
  const server = net.createServer(handleConn);
  server.on('error', (e) => console.error('approval listener error:', e.message));
  server.listen(APPROVAL_SOCKET);
  return server;
}

// Called by the bot's /approve and /deny command handlers.
export function resolveApproval({ id, chatId, approve, alwaysToolName }) {
  let target = id ? pending.get(Number(id)) : null;
  if (!target) {
    // newest pending for this chat
    for (const [, p] of [...pending].reverse()) {
      if (p.chatId === chatId) {
        target = p;
        break;
      }
    }
  }
  if (!target || target.chatId !== chatId) return { ok: false };
  target.respond(approve ? 'allow' : 'deny', approve ? undefined : 'Denied by operator.');
  return { ok: true, toolName: target.toolName, sessionName: target.sessionName, always: !!alwaysToolName };
}

export function pendingCount(chatId) {
  let n = 0;
  for (const [, p] of pending) if (p.chatId === chatId) n++;
  return n;
}
