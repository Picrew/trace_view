/** Probe: watch a live session for 25s and record what "jumps". */
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

  // Open the FIRST session (the live one = this very session).
  await page.click('.session-item');
  await page.waitForSelector('.run-title', { timeout: 30000 });
  console.log('run opened');

  // Observe for 25s: scrollTop, run-title visibility (reload loops), SSE messages.
  await page.evaluate(`(() => {
    window.__obs = { scrollJumps: 0, lastTop: -1, titleDisappears: 0, sseBatches: 0, resets: 0, lastTitleVisible: true, tops: [] };
    const el = document.querySelector('.trajectory');
    setInterval(() => {
      const t = el ? el.scrollTop : -1;
      if (window.__obs.lastTop >= 0 && Math.abs(t - window.__obs.lastTop) > 50) {
        window.__obs.scrollJumps++;
        window.__obs.tops.push(window.__obs.lastTop + '->' + t);
      }
      window.__obs.lastTop = t;
      const vis = !!document.querySelector('.run-title');
      if (window.__obs.lastTitleVisible && !vis) window.__obs.titleDisappears++;
      window.__obs.lastTitleVisible = vis;
    }, 400);
  })()`);

  // Count SSE frames via performance resources is unreliable; patch EventSource instead.
  await page.evaluate(`(() => {
    const OrigES = window.EventSource;
    window.EventSource = class extends OrigES {
      constructor(...a) { super(...a); window.__es = this; }
    };
  })()`);

  await new Promise((r) => setTimeout(r, 25000));
  const obs = await page.evaluate(`(() => {
    const o = window.__obs;
    const es = window.__es;
    return { ...o, esReady: !!es, esUrl: es ? es.url.slice(0, 60) : null, tops: o.tops.slice(0, 10) };
  })()`);
  console.log(JSON.stringify(obs, null, 1));
  await browser.close();
}
void main();
