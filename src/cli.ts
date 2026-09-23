#!/usr/bin/env node
/**
 * trace-review — local-first Agent Trace Review.
 * Starts a local server (127.0.0.1) and opens the web UI.
 */
import { exec } from 'node:child_process';
import { createTraceReviewServer } from './server/index.js';

interface CliArgs {
  port?: number;
  noOpen: boolean;
  claudeDir?: string;
  codexDir?: string;
  extraDirs: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { noOpen: false, extraDirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--port':
      case '-p':
        args.port = Number(argv[++i]);
        break;
      case '--no-open':
        args.noOpen = true;
        break;
      case '--claude-dir':
        args.claudeDir = argv[++i];
        break;
      case '--codex-dir':
        args.codexDir = argv[++i];
        break;
      case '--dir':
        args.extraDirs.push(argv[++i]);
        break;
      case '--help':
      case '-h':
        console.log(`trace-review — local-first Agent Trace Review

Usage:
  trace-review [options]

Options:
  --port, -p <n>        Port to listen on (default: random free port)
  --no-open             Do not open the browser
  --claude-dir <path>   Claude Code projects dir (default: ~/.claude/projects)
  --codex-dir <path>    Codex sessions dir (default: ~/.codex/sessions)
  --dir <path>          Extra directory to scan for traces (repeatable)
  -h, --help            Show this help

Everything runs locally on 127.0.0.1 — no telemetry, no uploads.`);
        process.exit(0);
        break;
      default:
        if (!a.startsWith('-')) args.extraDirs.push(a);
        else console.warn(`Unknown option: ${a}`);
    }
  }
  return args;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === 'darwin' ? `open "${url}"` : platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* opening the browser is best-effort */
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const port = args.port ?? 7860;

  // Single instance: if a trace-review server already answers on the port,
  // just open the browser instead of spawning a second one.
  if (!args.noOpen) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const body = (await res.json()) as { name?: string };
        if (body.name === 'trace-review') {
          console.log(`trace-review is already running on port ${port} — opening ${`http://127.0.0.1:${port}`}`);
          openBrowser(`http://127.0.0.1:${port}`);
          process.exit(0);
        }
      }
    } catch {
      /* not running — proceed */
    }
  }

  const server = await createTraceReviewServer({
    port: args.port,
    claudeDir: args.claudeDir,
    codexDir: args.codexDir,
    extraDirs: args.extraDirs,
  });
  const url = `http://127.0.0.1:${server.port}`;
  console.log(`trace-review serving on ${url}`);
  console.log(`  claude dir: ${server.library.getDirs().claudeDir}`);
  console.log(`  codex dir:  ${server.library.getDirs().codexDir}`);
  if (server.library.getDirs().extraDirs.length > 0) {
    console.log(`  extra dirs: ${server.library.getDirs().extraDirs.join(', ')}`);
  }
  console.log('  (scanning sessions in the background — press Ctrl+C to stop)');
  if (!args.noOpen) openBrowser(url);

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start trace-review:', err);
  process.exit(1);
});
