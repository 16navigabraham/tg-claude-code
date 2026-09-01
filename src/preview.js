import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const PREVIEW_PORT = Number(process.env.PREVIEW_PORT) || 4173;
const WAIT_MS = Number(process.env.PREVIEW_WAIT_MS) || 30000;

const MIME = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'coverage', '.cache']);

// The directory that holds an index.html — workdir root first, then shallow subdirs.
export function findSiteRoot(workdir) {
  if (fs.existsSync(path.join(workdir, 'index.html'))) return workdir;
  let hit = null;
  const walk = (dir, depth) => {
    if (hit || depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'index.html')) {
      hit = dir;
      return;
    }
    for (const e of entries) {
      if (hit) return;
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(workdir, 0);
  return hit;
}

export function startStaticServer(root, port) {
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let fp = path.normalize(path.join(root, urlPath));
      if (!fp.startsWith(root)) {
        res.writeHead(403);
        return res.end();
      }
      if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
      if (!fs.existsSync(fp)) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
      });
      fs.createReadStream(fp).pipe(res);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export function portResponds(port, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout }, (r) => {
      r.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function screenshot(url, outPath) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      'Playwright not installed on the VPS — run scripts/preview-setup.sh once.'
    );
  }
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: 'load', timeout: WAIT_MS });
    await page.waitForTimeout(1500); // let fonts / entrance animations settle
    await page.screenshot({ path: outPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

/**
 * Render a session's working dir and return a PNG path (caller deletes it).
 * mode 'static' — serve the dir that has index.html.
 * mode 'dev'    — `npm run dev`, wait for a port, screenshot, kill it.
 */
export async function capturePreview(workdir, { mode = 'static', port } = {}) {
  const out = path.join(os.tmpdir(), `preview-${Date.now()}.png`);
  let cleanup = async () => {};

  try {
    let url;
    if (mode === 'dev') {
      const pkgPath = path.join(workdir, 'package.json');
      let hasDev = false;
      try {
        hasDev = !!JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts?.dev;
      } catch {
        /* no package.json */
      }
      if (!hasDev) throw new Error('no "dev" script in package.json — use plain /preview for a static site');

      const devPort = port || 5173;
      const child = spawn('npm', ['run', 'dev'], {
        cwd: workdir,
        env: { ...process.env, PORT: String(devPort), BROWSER: 'none', CI: '1' },
        stdio: 'ignore',
      });
      cleanup = async () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      };

      const candidates = port ? [port] : [devPort, 3000, 4321, 8080, 4173, 5174];
      const deadline = Date.now() + WAIT_MS;
      let found = null;
      while (!found && Date.now() < deadline) {
        for (const p of candidates) {
          if (await portResponds(p)) {
            found = p;
            break;
          }
        }
        if (!found) await new Promise((r) => setTimeout(r, 1000));
      }
      if (!found) throw new Error(`dev server didn't respond within ${Math.round(WAIT_MS / 1000)}s`);
      url = `http://127.0.0.1:${found}/`;
    } else {
      const root = findSiteRoot(workdir);
      if (!root) {
        throw new Error('no index.html in this session — build one first, or use /preview dev');
      }
      const server = await startStaticServer(root, PREVIEW_PORT);
      cleanup = async () => new Promise((r) => server.close(() => r()));
      url = `http://127.0.0.1:${PREVIEW_PORT}/`;
    }

    await screenshot(url, out);
    return out;
  } catch (err) {
    fs.promises.unlink(out).catch(() => {});
    throw err;
  } finally {
    await cleanup();
  }
}
