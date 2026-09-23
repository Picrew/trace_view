/** Screenshot an HTML sheet for icon review. */
import puppeteer from 'puppeteer-core';
async function main(): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.goto('file:///tmp/final-sheet.html', { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: '/tmp/final-sheet.png', fullPage: true });
  await browser.close();
  console.log('sheet: /tmp/final-sheet.png');
}
void main();
