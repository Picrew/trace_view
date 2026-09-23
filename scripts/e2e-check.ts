/**
 * Real-browser end-to-end check (system Chrome via puppeteer-core).
 * Covers: library render, run open, scroll, tool expand, inspector,
 * filters, search jump. Exits non-zero on any failure.
 * Usage: npx tsx scripts/e2e-check.ts [port]
 */
import puppeteer from 'puppeteer-core';

const PORT = process.argv[2] ?? '7860';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function check(name: string, ok: boolean, detail = ''): boolean {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

async function main(): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1680,1050'],
  });
  let failed = false;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1680, height: 1050 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForSelector('.session-item', { timeout: 30000 });
    failed = !check('library renders', true, `${await page.$$eval('.session-item', (e) => e.length)} sessions`) || failed;

    await page.click('.session-item');
    await page.waitForSelector('.tool-row, .message-row', { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 800));
    failed = !check('run opens (title + stats)', (await page.$('.run-title')) !== null) || failed;
    failed = !check('timeline canvas present', (await page.$('.timeline-canvas')) !== null) || failed;

    // Scroll
    const scrolled = await page.evaluate(`(() => {
      const el = document.querySelector('.trajectory');
      el.scrollTop = 2000;
      return el.scrollTop;
    })()`);
    failed = !check('trajectory scrolls', scrolled === 2000, `scrollTop=${scrolled}`) || failed;

    // Tool expand + inspector — scroll until a tool row or an aggregate row
    // (consecutive tool runs collapse into aggregates) is in view.
    let toolHeader: import('puppeteer-core').ElementHandle | null = null;
    for (let i = 0; i < 12 && !toolHeader; i++) {
      toolHeader = (await page.$('.tool-row .tool-header')) ?? (await page.$('.aggregate-row .aggregate-header'));
      if (!toolHeader) {
        await page.evaluate(`(() => {
          const el = document.querySelector('.trajectory');
          // Big steps: a single user message row can be thousands of px tall.
          el.scrollTop += 2000;
        })()`);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (toolHeader) {
      await toolHeader.click();
      await new Promise((r) => setTimeout(r, 500));
      // Aggregates expand to flat rows — click the first one to select it.
      const flat = await page.$('.aggregate-body .tool-row .tool-header');
      if (flat) await flat.click();
      await new Promise((r) => setTimeout(r, 400));
      const hasInspector = (await page.$('.inspector')) !== null;
      failed = !check('inspector opens on tool click', hasInspector) || failed;
      await page.waitForSelector('.raw-json', { timeout: 5000 }).catch(() => undefined);
      const hasRaw = (await page.$('.raw-json')) !== null;
      failed = !check('raw JSON loads on demand', hasRaw) || failed;
    } else {
      failed = !check('tool row found by scrolling', false) || failed;
    }

    // Filter chip
    const userChip = await page.evaluateHandle(
      `[...document.querySelectorAll('.filter-chip')].find((c) => c.textContent === 'User')`,
    );
    if (userChip && (userChip as unknown as { asElement: () => unknown }).asElement()) {
      await (userChip as unknown as { asElement: () => import('puppeteer-core').ElementHandle }).asElement()!.click();
      await new Promise((r) => setTimeout(r, 400));
      const userRows = await page.$$eval('.message-row.user', (e) => e.length);
      const toolRows = await page.$$eval('.tool-row', (e) => e.length);
      failed = !check('User filter hides tools', toolRows === 0 && userRows > 0, `${userRows} user rows, ${toolRows} tool rows`) || failed;
    }

    // Search
    await page.evaluate(`(() => {
      const chip = [...document.querySelectorAll('.filter-chip')].find((c) => c.textContent === 'All');
      if (chip) chip.click();
    })()`);
    await page.type('.search-box input', 'read');
    await new Promise((r) => setTimeout(r, 900));
    const results = await page.$$eval('.search-result', (e) => e.length);
    failed = !check('search returns results', results > 0, `${results} matches`) || failed;

    // Screenshot
    await page.screenshot({ path: '/tmp/tr-e2e-final.png' });
    failed = !check('no page errors', errors.length === 0, errors.slice(0, 3).join('; ')) || failed;
    console.log(failed ? '\nE2E: FAILED' : '\nE2E: ALL PASS');
    process.exitCode = failed ? 1 : 0;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('e2e failed:', e);
  process.exit(1);
});
