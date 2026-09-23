import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseUrl } from 'node:url';
import type { Server } from 'node:http';
import { Library, defaultDirs } from './scanner.js';
import { RunCache, RunWatcher } from './run-cache.js';
import { parseTraceFile, readEventRaw } from '../core/run-builder.js';
import type { SessionSummary } from '../core/schema.js';
import {
  eventBySeq,
  readBody,
  searchEvents,
  sendError,
  sendJson,
  stripForTransport,
} from './api.js';
import { APP_VERSION } from '../version.js';

// Works both in ESM (tsc output: import.meta.url) and in a CJS bundle
// (esbuild for the single-executable build: __dirname).
function thisDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return typeof __dirname === 'string' ? __dirname : process.cwd();
  }
}
const __dirname = thisDir();

// Web bundle location depends on how the server runs:
//   dev/build (dist/server/index.js)      → ../web       (dist/web)
//   single-file bundle (SEA, this file)   → ../web       (dist/web, exe in dist/)
//   macOS .app (Contents/MacOS/<bin>)     → ../Resources/app/web
const WEB_ROOT_CANDIDATES = [
  path.resolve(__dirname, '../web'),
  path.resolve(__dirname, 'web'),
  path.resolve(__dirname, '../Resources/app/web'),
];
const WEB_ROOT = WEB_ROOT_CANDIDATES.find((p) => existsSync(p)) ?? WEB_ROOT_CANDIDATES[0];

export const DEFAULT_PORT = 7860;

export interface ServerOptions {
  port?: number;
  host?: string;
  claudeDir?: string;
  codexDir?: string;
  extraDirs?: string[];
}

export interface TraceReviewServer {
  server: Server;
  port: number;
  library: Library;
  cache: RunCache;
  close(): void;
}


export function createTraceReviewServer(opts: ServerOptions = {}): Promise<TraceReviewServer> {
  const dirs = defaultDirs();
  if (opts.claudeDir) dirs.claudeDir = opts.claudeDir;
  if (opts.codexDir) {
    dirs.codexDir = opts.codexDir;
    dirs.archivedCodexDir = path.join(path.dirname(path.resolve(opts.codexDir)), 'archived_sessions');
  }
  dirs.extraDirs = opts.extraDirs ?? [];

  const library = new Library(dirs);
  const cache = new RunCache(6);

  const server = http.createServer((req, res) => {
    handleRequest(req, res, { library, cache }).catch((err) => {
      if (!res.headersSent) {
        sendError(res, 500, (err as Error).message || 'Internal error');
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    });
  });

  return new Promise((resolve, reject) => {
    const listen = (port: number, allowFallback: boolean) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('error', onError);
        if (allowFallback && err.code === 'EADDRINUSE') {
          listen(0, false); // fall back to a random free port
        } else {
          reject(err);
        }
      };
      server.once('error', onError);
      server.listen(port, opts.host ?? '127.0.0.1', () => {
        server.removeListener('error', onError);
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        // Initial scan runs in the background; /api/library waits for it.
        void library.loadCache().then(() => library.scan());
        resolve({
          server,
          port: actualPort,
          library,
          cache,
          close() {
            server.close();
          },
        });
      });
    };
    listen(opts.port ?? DEFAULT_PORT, opts.port === undefined);
  });
}

interface Ctx {
  library: Library;
  cache: RunCache;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx): Promise<void> {
  const url = parseUrl(req.url ?? '/', true);
  const pathname = decodeURIComponent(url.pathname ?? '/');
  const method = req.method ?? 'GET';

  // --- API ---
  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, name: 'trace-review', version: APP_VERSION });
  }

  if (pathname === '/api/library' && method === 'GET') {
    const refresh = url.query.refresh === '1';
    const scanning = ctx.library.ensureFresh(30_000, refresh);
    if (scanning) await scanning;
    const sessions = ctx.library.all();
    return sendJson(res, 200, {
      sessions,
      dirs: ctx.library.getDirs(),
      lastScan: ctx.library.lastScan,
    });
  }

  if (pathname === '/api/import' && method === 'POST') {
    const body = JSON.parse(await readBody(req)) as { path?: string };
    const inputPath = body.path;
    if (!inputPath || typeof inputPath !== 'string') return sendError(res, 400, 'Missing "path"');
    const summary = await ctx.library.importPath(path.resolve(inputPath));
    return sendJson(res, 200, { imported: summary.length, sessions: summary });
  }

  const runMatch = /^\/api\/runs\/([^/]+)(?:\/(events|stream|search|raw))?(?:\/([^/]+))?$/.exec(pathname);
  if (runMatch && method === 'GET') {
    const runId = runMatch[1];
    const sub = runMatch[2];
    const arg = runMatch[3];

    const entry = await loadRun(ctx, runId);
    if (!entry) return sendError(res, 404, `Run not found: ${runId} — try refreshing the library`);
    const handle = entry.handle;

    if (!sub) {
      return sendJson(res, 200, {
        run: handle.parsed.run,
        spans: handle.parsed.spans,
        fileChanges: handle.parsed.fileChanges,
      });
    }
    if (sub === 'events') {
      return sendJson(res, 200, { events: handle.parsed.events.map(stripForTransport) });
    }
    if (sub === 'raw' && arg) {
      const event = eventBySeq(handle, arg);
      if (!event) return sendError(res, 404, 'Event not found');
      const raw = await readEventRaw(handle, event);
      return sendJson(res, 200, { event: stripForTransport(event), raw });
    }
    if (sub === 'search') {
      const q = String(url.query.q ?? '');
      const limit = Math.min(500, Number(url.query.limit ?? 200) || 200);
      return sendJson(res, 200, { query: q, matches: searchEvents(handle.parsed.events, q, limit) });
    }
    if (sub === 'stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      if (!entry.watcher) entry.watcher = new RunWatcher(handle);
      entry.watcher.addClient(res);
      // Initial delta: send everything after the cursor if provided.
      const cursor = Number(url.query.cursor);
      if (Number.isInteger(cursor) && cursor >= 0) {
        const fresh = handle.parsed.events.filter((e) => e.seq > cursor);
        if (fresh.length > 0) {
          res.write(
            `data: ${JSON.stringify({
              type: 'batch',
              events: fresh.map(stripForTransport),
              run: handle.parsed.run,
              spans: handle.parsed.spans,
              fileChanges: handle.parsed.fileChanges,
            })}\n\n`,
          );
        }
      }
      return; // keep connection open
    }
  }

  // --- Static web app ---
  if (method === 'GET' && !pathname.startsWith('/api/')) {
    return serveStatic(pathname, res);
  }

  sendError(res, 404, 'Not found');
}

async function loadRun(ctx: Ctx, runId: string) {
  const cached = ctx.cache.get(runId);
  if (cached) return cached;
  const summary: SessionSummary | undefined = ctx.library.get(runId);
  if (!summary) return null;
  const handle = await parseTraceFile(summary.filePath, { provider: summary.provider });
  return ctx.cache.put(handle);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  let rel = pathname === '/' ? '/index.html' : pathname;
  // Prevent path traversal.
  const resolved = path.resolve(WEB_ROOT, `.${rel}`);
  if (!resolved.startsWith(WEB_ROOT + path.sep) && resolved !== WEB_ROOT) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const st = await stat(resolved);
    if (st.isDirectory()) {
      rel = '/index.html';
    }
  } catch {
    // SPA-ish fallback for unknown routes.
    rel = '/index.html';
  }
  try {
    const content = await readFile(path.resolve(WEB_ROOT, `.${rel}`));
    const ext = path.extname(rel);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=86400' : 'no-store',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      'trace-review web bundle not found.\n' +
        'This server only serves the API until the frontend is built.\n' +
        'Run `npm run build` (or use `npm run dev` for the vite dev server).',
    );
  }
}
