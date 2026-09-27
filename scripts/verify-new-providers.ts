/** Ad-hoc real-data verification for the pi / opencode adapters. */
import { parseTraceFile, summarizeTraceFile } from '../src/core/run-builder.js';
import { homedir } from 'node:os';
import path from 'node:path';

async function main() {
  // --- pi ---
  const piFile = path.join(
    homedir(),
    '.pi/agent/sessions/--Users-lijunjie-Downloads-cowork--/2026-09-18T08-22-02-191Z_01a0b39b-b8ce-714c-846d-83dc6ac18604.jsonl',
  );
  const piSum = await summarizeTraceFile(piFile);
  console.log('pi summary:', {
    title: piSum?.title?.slice(0, 60),
    project: piSum?.project,
    models: piSum?.models,
    provider: piSum?.provider,
  });
  const pi = await parseTraceFile(piFile);
  const kinds: Record<string, number> = {};
  for (const e of pi.parsed.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  console.log('pi kinds:', JSON.stringify(kinds));
  console.log('pi usage:', JSON.stringify(pi.parsed.run.usage));
  console.log('pi stats:', {
    requests: pi.parsed.run.stats.requests,
    toolCalls: pi.parsed.run.stats.toolCalls,
    errors: pi.parsed.run.stats.errors,
    files: pi.parsed.run.stats.filesChanged,
  });
  console.log('pi warnings:', pi.parsed.run.warnings);

  // raw JSON round-trip for one pi tool_call
  const tc = pi.parsed.events.find((e) => e.kind === 'tool_call');
  if (tc) {
    const raw = await import('../src/core/run-builder.js').then((m) =>
      m.readEventRaw(pi, tc),
    );
    console.log('pi raw ok:', raw !== null && (raw as any)?.type === 'message');
  }

  console.log('\n================\n');

  // --- opencode: all sessions ---
  const ocRoot = path.join(homedir(), '.local/share/opencode/storage/session');
  const fs = await import('node:fs/promises');
  const agg: Record<string, number> = {};
  let diffSampleShown = false;
  let reasoningSampleShown = false;
  const t0 = Date.now();
  for (const proj of await fs.readdir(ocRoot)) {
    for (const sesFile of await fs.readdir(path.join(ocRoot, proj))) {
      if (!sesFile.startsWith('ses_')) continue;
      const ocPath = path.join(ocRoot, proj, sesFile);
      let oc;
      try {
        oc = await parseTraceFile(ocPath, { provider: 'opencode' });
      } catch (err) {
        console.log('PARSE FAIL', sesFile, (err as Error).message);
        continue;
      }
      for (const e of oc.parsed.events) agg[e.kind] = (agg[e.kind] ?? 0) + 1;
      if (!diffSampleShown) {
        const tr = oc.parsed.events.find(
          (e) => e.kind === 'tool_result' && (e as any).structuredPatch,
        ) as any;
        if (tr) {
          diffSampleShown = true;
          console.log(
            'diff sample:', tr.toolName, tr.filePath,
            'patches:', tr.structuredPatch.length,
            'first hunk lines:', tr.structuredPatch[0]?.hunks?.[0]?.lines?.slice(0, 4),
          );
        }
      }
      if (!reasoningSampleShown) {
        const r = oc.parsed.events.find((e) => e.kind === 'reasoning') as any;
        if (r) {
          reasoningSampleShown = true;
          console.log('reasoning sample:', r.text.slice(0, 100));
        }
      }
    }
  }
  console.log(`all opencode sessions parsed in ${Date.now() - t0}ms`);
  console.log('opencode aggregate kinds:', JSON.stringify(agg));

  // raw JSON round-trip from the virtual stream
  const ocPath = path.join(
    ocRoot,
    (await fs.readdir(ocRoot)).find((p) => p !== 'global')!,
    (await fs.readdir(path.join(ocRoot, (await fs.readdir(ocRoot)).find((p) => p !== 'global')!))).find(
      (f) => f.startsWith('ses_'),
    )!,
  );
  const oc = await parseTraceFile(ocPath, { provider: 'opencode' });
  const ocTool = oc.parsed.events.find((e) => e.kind === 'tool_call');
  if (ocTool) {
    const raw = await import('../src/core/run-builder.js').then((m) => m.readEventRaw(oc, ocTool));
    const ok = raw !== null && (raw as any)?.type === 'oc_message';
    console.log('opencode raw (virtual slice) ok:', ok);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
