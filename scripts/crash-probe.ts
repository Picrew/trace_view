/** Watch the live run for page errors / unmounts. */
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
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 200)); });
  await page.goto('http://127.0.0.1:7860/', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.session-item', { timeout: 20000 });
  await page.click('.session-item');
  await page.waitForSelector('.run-title', { timeout: 30000 });
  console.log('run opened, watching 15s…');
  await new Promise((r) => setTimeout(r, 15000));
  const state = await page.evaluate(`(() => ({
    hasRunTitle: !!document.querySelector('.run-title'),
    hasSearch: !!document.querySelector('.search-box input'),
    hasStatus: !!document.querySelector('.statusbar'),
    bodyLen: document.body.textContent.length,
  }))()`);
  console.log('state:', JSON.stringify(state));
  console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
  await browser.close();
}
void main();
