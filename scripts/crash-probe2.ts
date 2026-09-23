/** Click a tool row on the live run, watch what happens. */
import puppeteer from 'puppeteer-core';

async function main(): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1050 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message).split('\n').slice(0, 6).join(' | ')));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 300)); });
  await page.goto('http://127.0.0.1:7860/', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.session-item', { timeout: 20000 });
  await page.click('.session-item');
  await page.waitForSelector('.run-title', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1000));

  // scroll until a tool/aggregate row is visible, then click it
  let clicked = false;
  for (let i = 0; i < 15 && !clicked; i++) {
    clicked = await page.evaluate(`(() => {
      const el = document.querySelector('.trajectory');
      const hdr = document.querySelector('.tool-row .tool-header') || document.querySelector('.aggregate-row .aggregate-header');
      if (!hdr) { el.scrollTop += 2000; return false; }
      hdr.click();
      return true;
    })()`);
    if (!clicked) await new Promise((r) => setTimeout(r, 250));
  }
  console.log('clicked tool row:', clicked);
  await new Promise((r) => setTimeout(r, 3000));
  const state = await page.evaluate(`(() => ({
    hasRunTitle: !!document.querySelector('.run-title'),
    hasSearch: !!document.querySelector('.search-box input'),
    hasInspector: !!document.querySelector('.inspector'),
    hasLoading: !!document.querySelector('.loading-state'),
    hasErrorBanner: !!document.querySelector('.error-banner'),
    errText: (document.querySelector('.error-banner')||{}).textContent || '',
  }))()`);
  console.log('state after click:', JSON.stringify(state, null, 1));
  console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
  await browser.close();
}
void main();
