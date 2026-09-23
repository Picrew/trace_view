/** Render the packaging icon SVG and screenshot it for review. */
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync } from 'node:fs';

async function main(): Promise<void> {
  const svg = readFileSync('/tmp/icon-preview.svg', 'utf8');
  const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:#333}</style></head><body>${svg.replace('width="1024" height="1024"', 'width="512" height="512"')}</body></html>`;
  writeFileSync('/tmp/icon-page.html', html);
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.goto('file:///tmp/icon-page.html', { waitUntil: 'load' });
  await page.setViewport({ width: 512, height: 512 });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: '/tmp/icon-render.png', clip: { x: 0, y: 0, width: 512, height: 512 } });
  await browser.close();
  console.log('rendered: /tmp/icon-render.png');
}
void main();
