/**
 * Visual regression snapshots (system Chrome via puppeteer-core).
 * Captures the main UI states of one run so before/after redesign shots can
 * be compared side by side. Never touches data — read-only API calls.
 * Usage: npx tsx scripts/visual-snapshot.ts <port> <runId> <outDir> [width] [height] [scale]
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const [PORT = '7860', RUN_ID = '', OUT = '/tmp/trace-review-shots', W = '1680', H = '1050', SCALE = '1'] = process.argv.slice(2);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!RUN_ID) throw new Error('runId required');
  mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: Number(W), height: Number(H), deviceScaleFactor: Number(SCALE) });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const shot = async (name: string) => {
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      console.log(`  ${file}`);
    };

    // 1. Empty state (library only).
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForSelector('.session-item', { timeout: 30000 });
    await sleep(300);
    await shot('01-empty');

    // 2. Run overview, scrolled into the body of the trajectory.
    await page.goto(`http://127.0.0.1:${PORT}/#run=${encodeURIComponent(RUN_ID)}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.tool-row, .message-row, .aggregate-row', { timeout: 60000 });
    await sleep(800);
    await shot('02-run-top');
    await page.evaluate(`(() => { const el = document.querySelector('.trajectory'); el.scrollTop = Math.min(4000, el.scrollHeight / 3); })()`);
    await sleep(500);
    await shot('03-run-scrolled');

    // 3. Expand a tool row + inspector.
    await page.evaluate(`(() => {
      const hdr = document.querySelector('.tool-row .tool-header') || document.querySelector('.aggregate-row .aggregate-header');
      if (hdr) hdr.click();
    })()`);
    await sleep(700);
    await shot('04-tool-expanded');

    // 4. Files panel.
    await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').startsWith('Files'));
      if (b) b.click();
    })()`);
    await sleep(500);
    await shot('05-files-panel');

    // 5. Search dropdown.
    await page.click('.search-box input');
    await page.keyboard.type('test');
    await sleep(1200);
    await shot('06-search');

    if (errors.length > 0) {
      console.error('page errors:\n' + errors.join('\n'));
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

void main();
