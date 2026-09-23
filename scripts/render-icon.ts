/**
 * Render the app icon SVG to a 1024px PNG with a TRANSPARENT background.
 *
 * qlmanage (the previous renderer) fills transparent SVG areas with opaque
 * white — which showed up as a white frame around the icon in the Dock and
 * made it look oversized next to system apps.
 */
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main(): Promise<void> {
  const svg = readFileSync('build/icon.svg', 'utf8');
  const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}</style></head><body>${svg}</body></html>`;
  mkdirSync('build', { recursive: true });
  writeFileSync('build/icon-page.html', html);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 1024 });
    await page.goto('file://' + process.cwd() + '/build/icon-page.html', { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: 'build/icon.svg.png', omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
    console.log('icon rendered: build/icon.svg.png (transparent background)');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('icon render failed:', e);
  process.exit(1);
});
