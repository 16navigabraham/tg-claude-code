// Minimal stdio MCP server exposing one tool: `approval_prompt`.
// Claude Code calls it (via --permission-prompt-tool) for any tool use not
// already settled by allow/deny rules. We forward the request over a Unix
// socket to the running bot, which asks the user on Telegram and sends back
// allow / deny. Spawned per `claude` run; APPROVAL_SOCKET + SESSION_ID in env.

import net from 'net';

const SOCKET = process.env.APPROVAL_SOCKET;
const SESSION_ID = process.env.APPROVAL_SESSION_ID || '';
const FALLBACK = (process.env.APPROVAL_FALLBACK || 'allow').toLowerCase(); // if the bot is unreachable

const TOOL = {
  name: 'approval_prompt',
  description: 'Ask the operator (via Telegram) to approve or deny a tool call.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
    },
    required: ['tool_name'],
  },
};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function askBot(toolName, toolInput) {
  return new Promise((resolve) => {
    if (!SOCKET) return resolve({ decision: FALLBACK });
    const sock = net.connect(SOCKET);
    let buf = '';
    const done = (d) => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(d);
    };
    const t = setTimeout(() => done({ decision: FALLBACK, message: 'approval timed out' }), 15 * 60 * 1000);
    sock.on('connect', () =>
      sock.write(JSON.stringify({ sessionId: SESSION_ID, tool_name: toolName, input: toolInput }) + '\n')
    );
    sock.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(t);
      try {
        done(JSON.parse(buf.slice(0, nl)));
      } catch {
        done({ decision: FALLBACK });
      }
    });
    sock.on('error', () => {
      clearTimeout(t);
      done({ decision: FALLBACK, message: 'bot unreachable' });
    });
  });
}

let inbuf = '';
process.stdin.on('data', async (chunk) => {
  inbuf += chunk.toString();
  let nl;
  while ((nl = inbuf.indexOf('\n')) >= 0) {
    const line = inbuf.slice(0, nl);
    inbuf = inbuf.slice(nl + 1);
    if (!line.trim()) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }

    if (req.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'approvals', version: '1.0.0' },
        },
      });
    } else if (req.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: req.id, result: { tools: [TOOL] } });
    } else if (req.method === 'tools/call' && req.params?.name === 'approval_prompt') {
      const a = req.params.arguments || {};
      const r = await askBot(a.tool_name || 'unknown', a.input || {});
      const payload =
        r.decision === 'deny'
          ? { behavior: 'deny', message: r.message || 'Denied by operator.' }
          : { behavior: 'allow', updatedInput: a.input || {} };
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      });
    } else if (req.id !== undefined) {
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } });
    }
  }
});
