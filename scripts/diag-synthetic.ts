/** Find user messages misclassified as synthetic in recent real sessions. */
import { parseTraceFile } from '../src/core/run-builder.js';
import { readLineAt } from '../src/core/reader.js';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function main(): Promise<void> {
  const projDir = path.join(os.homedir(), '.claude/projects');
  const sessions: Array<{ f: string; m: number }> = [];
  for (const d of readdirSync(projDir)) {
    const dir = path.join(projDir, d);
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(dir, f);
        sessions.push({ f: p, m: statSync(p).mtimeMs });
      }
    } catch { /* skip */ }
  }
  sessions.sort((a, b) => b.m - a.m);

  for (const { f } of sessions.slice(0, 5)) {
    const { parsed } = await parseTraceFile(f);
    const synths = parsed.events.filter((e) => e.kind === 'synthetic_message');
    console.log(`\n=== ${path.basename(f)} (${parsed.run.stats.userMessages} user / ${synths.length} synthetic) ===`);
    for (const s of synths.slice(0, 10)) {
      const k = (s as any).syntheticKind as string;
      const text = ((s as any).text as string).slice(0, 60).replace(/\n/g, ' ');
      // pull the raw line to inspect fields
      const raw = (await readLineAt(f, s.loc!.offset, s.loc!.length)) as any;
      const flags = [
        raw?.origin ? `origin=${JSON.stringify(raw.origin)}` : 'no-origin',
        raw?.isMeta ? 'isMeta' : '',
        raw?.isCompactSummary ? 'compact' : '',
        raw?.promptSource ? `src=${raw.promptSource}` : '',
        raw?.isVisibleInTranscriptOnly ? 'transcriptOnly' : '',
        Array.isArray(raw?.message?.content) ? `contentTypes=${raw.message.content.map((c: any) => c.type).join('+')}` : 'str',
      ].filter(Boolean).join(' ');
      console.log(`  [${k}] "${text}"`);
      console.log(`        ${flags}`);
    }
  }
}
void main();
