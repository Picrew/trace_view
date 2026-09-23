/** Reproduce: scroll to bottom on the LIVE session, watch scrollTop move by itself. */
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
  await page.click('.session-item'); // first session = current live one
  await page.waitForSelector('.run-title', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1000));

  // Scroll to bottom like a user would.
  await page.evaluate(`(() => {
    const el = document.querySelector('.trajectory');
    el.scrollTop = el.scrollHeight;
  })()`);
  console.log('scrolled to bottom, observing 20s…');

  await page.evaluate(`(() => {
    window.__log = [];
    const el = document.querySelector('.trajectory');
    let last = el.scrollTop;
    setInterval(() => {
      const t = el.scrollTop;
      if (t !== last) { window.__log.push({ t, dt: Date.now() % 100000, bySelf: true }); last = t; }
    }, 200);
  })()`);

  // Also simulate the user scrolling UP mid-way (should stop following).
  await new Promise((r) => setTimeout(r, 8000));
  await page.evaluate(`(() => {
    const el = document.querySelector('.trajectory');
    el.scrollTop = el.scrollHeight / 2; // user scrolls up to middle
    window.__log.push({ note: 'USER SCROLLED UP to ' + el.scrollTop });
  })()`);
  await new Promise((r) => setTimeout(r, 8000));

  const log = await page.evaluate(`(() => window.__log)()`);
  console.log('self-inflicted scroll movements:', log.length);
  console.log(JSON.stringify(log.slice(0, 12), null, 0));
  await browser.close();
}
void main();
