/**
 * Real-data parse benchmark. Usage: npx tsx scripts/bench-parse.ts [files...]
 * Without args, scans a sample of the largest local claude/codex traces.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseTraceFile } from '../src/core/run-builder.js';

function collectJsonl(dir: string, out: string[], depth = 0): void {
  if (depth > 5) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) collectJsonl(p, out, depth + 1);
      else if (name.endsWith('.jsonl')) out.push(p);
    } catch {
      /* ignore */
    }
  }
}

async function main(): Promise<void> {
  let files: string[] = process.argv.slice(2);
  if (files.length === 0) {
    const all: string[] = [];
    collectJsonl(path.join(os.homedir(), '.claude', 'projects'), all);
    collectJsonl(path.join(os.homedir(), '.codex', 'sessions'), all);
    files = all
      .map((f) => ({ f, size: statSync(f).size }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 6)
      .map((x) => x.f);
  }
  console.log(`Parsing ${files.length} file(s)…`);
  let fail = 0;
  for (const f of files) {
    const t0 = Date.now();
    try {
      const { parsed } = await parseTraceFile(f);
      const ms = Date.now() - t0;
      const { run } = parsed;
      const mb = (run.fileSizeBytes / 1e6).toFixed(1);
      console.log(
        `[ok] ${path.basename(f).slice(0, 44)} ${mb}MB ${ms}ms | ev=${parsed.events.length} spans=${parsed.spans.length} ` +
          `req=${run.stats.requests} tools=${run.stats.toolCalls} synth=${run.stats.syntheticMessages} ` +
          `err=${run.stats.errors} unk=${run.stats.byKind['unknown'] ?? 0} tok=${run.usage.totalTokens}`,
      );
      console.log(`     title=${run.title.slice(0, 60)}`);
      if (run.warnings.length) console.log(`     warn: ${run.warnings.join(' | ').slice(0, 160)}`);
    } catch (e) {
      fail++;
      console.log(`[FAIL] ${f}: ${(e as Error).message}`);
    }
  }
  if (fail > 0) process.exitCode = 1;
}

main();
