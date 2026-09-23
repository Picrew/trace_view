#!/usr/bin/env node
/**
 * Dev mode: run the API server via tsx and the vite dev server in parallel.
 * Vite proxies /api to the API server (see vite.config.ts).
 */
import { spawn } from 'node:child_process';

const children = [];

function run(name, cmd, args, color) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (line) => `${color}[${name}] ${line}\x1b[0m`;
  const onData = (buf) =>
    buf
      .toString()
      .split('\n')
      .filter((l) => l.length > 0)
      .forEach((l) => console.log(prefix(l)));
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => {
    console.log(prefix(`exited with ${code}`));
    if (children.some((c) => c.exitCode === null)) {
      children.filter((c) => c.exitCode === null).forEach((c) => c.kill());
      process.exit(code ?? 0);
    }
  });
  children.push(child);
  return child;
}

run('api', 'npx', ['tsx', 'src/cli.ts', '--no-open'], '\x1b[36m');
run('web', 'npx', ['vite'], '\x1b[35m');
