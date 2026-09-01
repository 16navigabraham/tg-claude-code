// Per-session public tunnel: serve the session's site locally, then expose it
// with a Cloudflare quick tunnel (`cloudflared tunnel --url ...`) — a random
// *.trycloudflare.com URL, no account/token needed. One tunnel per session;
// killed on /tunnel stop, session kill/renew, idle, or a max lifetime.
//
// ⚠️ The URL is PUBLIC (unguessable, not indexed, but anyone with the link
// reaches the dev server). Only for demos/sharing, never sensitive data.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { findSiteRoot, startStaticServer, portResponds } from './preview.js';

const CF_BIN = process.env.CLOUDFLARED_BIN || 'cloudflared';
const WAIT_MS = Number(process.env.TUNNEL_WAIT_MS) || 40000;
const IDLE_MS = Number(process.env.TUNNEL_IDLE_MS) || 2 * 60 * 60 * 1000; // 2h no /tunnel touch
const MAX_MS = Number(process.env.TUNNEL_MAX_MS) || 8 * 60 * 60 * 1000; // 8h hard cap
const STATIC_PORT_BASE = Number(process.env.TUNNEL_STATIC_PORT) || 4180;

export const tunnelSupported = () => {
  // `command -v` style check without a shell.
  const dirs = (process.env.PATH || '').split(path.delimiter);
  if (path.isAbsolute(CF_BIN)) return fs.existsSync(CF_BIN);
  return dirs.some((d) => {
    try {
      fs.accessSync(path.join(d, CF_BIN), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
};

// sessionId -> { url, kill, mode, port, startedAt, idleTimer, onExpire }
const tunnels = new Map();

export function getTunnel(sessionId) {
  return tunnels.get(sessionId) || null;
}

export function stopTunnel(sessionId) {
  const t = tunnels.get(sessionId);
  if (!t) return false;
  clearTimeout(t.idleTimer);
  clearTimeout(t.maxTimer);
  tunnels.delete(sessionId);
  t.kill();
  return true;
}

export function stopAllTunnels() {
  for (const id of [...tunnels.keys()]) stopTunnel(id);
}

// Touch on any /tunnel command for the session, to defer the idle kill.
export function touchTunnel(sessionId) {
  const t = tunnels.get(sessionId);
  if (!t) return;
  clearTimeout(t.idleTimer);
  t.idleTimer = setTimeout(() => {
    t.onExpire?.('idle');
    stopTunnel(sessionId);
  }, IDLE_MS);
}

async function startLocal(workdir, mode, wantPort) {
  const kills = [];
  let port;

  if (mode === 'dev') {
    let hasDev = false;
    try {
      hasDev = !!JSON.parse(fs.readFileSync(path.join(workdir, 'package.json'), 'utf8')).scripts?.dev;
    } catch {
      /* none */
    }
    if (!hasDev) throw new Error('no "dev" script in package.json — use plain /tunnel for a static site');

    const devPort = wantPort || 5173;
    const child = spawn('npm', ['run', 'dev'], {
      cwd: workdir,
      env: { ...process.env, PORT: String(devPort), BROWSER: 'none', CI: '1' },
      stdio: 'ignore',
    });
    kills.push(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    });

    const candidates = wantPort ? [wantPort] : [devPort, 3000, 4321, 8080, 5174];
    const deadline = Date.now() + WAIT_MS;
    while (!port && Date.now() < deadline) {
      for (const p of candidates) {
        if (await portResponds(p)) {
          port = p;
          break;
        }
      }
      if (!port) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!port) {
      kills.forEach((k) => k());
      throw new Error(`dev server didn't come up within ${Math.round(WAIT_MS / 1000)}s`);
    }
  } else {
    const root = findSiteRoot(workdir);
    if (!root) throw new Error('no index.html in this session — build one first, or use /tunnel dev');
    port = STATIC_PORT_BASE + Math.floor(Math.random() * 200);
    const server = await startStaticServer(root, port);
    kills.push(() => server.close());
  }

  return { port, kill: () => kills.forEach((k) => k()) };
}

function startCloudflared(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(CF_BIN, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      fn(arg);
    };
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      finish(reject, new Error('cloudflared did not produce a URL in time'));
    }, WAIT_MS);

    const scan = (d) => {
      buf += d.toString();
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m) {
        clearTimeout(t);
        finish(resolve, {
          url: m[0],
          kill: () => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* gone */
            }
          },
        });
      }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan); // cloudflared logs the URL to stderr
    child.on('error', (e) => {
      clearTimeout(t);
      finish(reject, e.code === 'ENOENT' ? new Error('cloudflared not installed on the VPS') : e);
    });
    child.on('close', () => {
      clearTimeout(t);
      finish(reject, new Error('cloudflared exited before yielding a URL'));
    });
  });
}

/**
 * Open (or return the existing) public tunnel for a session.
 * onExpire(reason) is called if the tunnel later dies on its own (idle | max | crash).
 */
export async function openTunnel(session, { mode = 'static', port, onExpire } = {}) {
  if (!tunnelSupported()) {
    throw new Error('Tunnelling needs cloudflared on the VPS — run scripts/tunnel-setup.sh once.');
  }
  const existing = tunnels.get(session.id);
  if (existing) {
    touchTunnel(session.id);
    return { url: existing.url, reused: true, mode: existing.mode };
  }

  const local = await startLocal(session.working_dir, mode, port);
  let cf;
  try {
    cf = await startCloudflared(local.port);
  } catch (e) {
    local.kill();
    throw e;
  }

  const rec = {
    url: cf.url,
    mode,
    port: local.port,
    startedAt: Date.now(),
    onExpire,
    kill: () => {
      cf.kill();
      local.kill();
    },
  };
  rec.maxTimer = setTimeout(() => {
    onExpire?.('max');
    stopTunnel(session.id);
  }, MAX_MS);
  tunnels.set(session.id, rec);
  touchTunnel(session.id);
  return { url: cf.url, reused: false, mode };
}
