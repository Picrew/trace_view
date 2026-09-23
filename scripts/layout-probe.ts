/** One-off layout probe: measures every layer of the app in a real browser. */
import puppeteer from 'puppeteer-core';

async function main(): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1050 });
  await page.goto('http://127.0.0.1:7860/', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.session-item', { timeout: 20000 });
  await page.click('.session-item');
  await page.waitForSelector('.tool-row, .message-row', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1000));
  // NOTE: pass the function as a string — tsx's esbuild transform injects
  // `__name` helpers that don't exist in the page context.
  const info = await page.evaluate(`(() => {
    const h = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { h: el.offsetHeight, minH: cs.minHeight, flex: cs.flex, disp: cs.display, overflow: cs.overflow, gridRows: cs.gridTemplateRows };
    };
    return {
      app: h('.app'), main: h('.main'), trajectory: h('.trajectory'),
      runHeader: h('.run-header'), timeline: h('.timeline-wrap'), filter: h('.filter-bar'),
      status: h('.statusbar'),
      cssHref: (document.querySelector('link[rel=stylesheet]') || {}).href,
    };
  })()`);
  console.log(JSON.stringify(info, null, 1));
  await browser.close();
}

void main();
