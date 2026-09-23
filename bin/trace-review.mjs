#!/usr/bin/env node
/**
 * trace-review launcher — prefers the built bundle, falls back to tsx in dev.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = path.join(root, 'dist', 'cli.js');
const args = process.argv.slice(2);

if (existsSync(built)) {
  const res = spawnSync(process.execPath, [built, ...args], { stdio: 'inherit' });
  process.exit(res.status ?? 0);
} else {
  // Dev fallback: run the TypeScript entry with tsx.
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const src = path.join(root, 'src', 'cli.ts');
  if (!existsSync(tsx)) {
    console.error('trace-review is not built. Run `npm install && npm run build` first.');
    process.exit(1);
  }
  const res = spawnSync(process.execPath, [tsx, src, ...args], { stdio: 'inherit' });
  process.exit(res.status ?? 0);
}
