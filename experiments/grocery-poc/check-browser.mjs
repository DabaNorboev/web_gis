// Run with an existing Playwright installation; never installs packages/browsers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.dirname(fileURLToPath(import.meta.url));
const base = process.env.POC_URL || 'http://127.0.0.1:8765';
const cases = JSON.parse(await fs.readFile(path.join(root, '.runtime/cases.json'), 'utf8'));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1380, height: 1050 }, serviceWorkers: 'block' });
const external = [], errors = [], results = [];
await context.route('**/*', route => {
  const url = route.request().url();
  if (url.startsWith('http') && new URL(url).origin !== new URL(base).origin) {
    external.push(url);
    return route.abort();
  }
  return route.continue();
});
const page = await context.newPage();
page.on('pageerror', e => errors.push(e.message));
page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
const sorted = values => [...values].sort();

async function checkCurrent(label) {
  await page.waitForFunction(() => window.groceryPoc?.mapsReady() && window.groceryPoc.getResponse(), null, { timeout: 30000 });
  await page.waitForFunction(() => ['left','right'].every(side => {
    const expected = window.groceryPoc.getResponse()[side].collection.features.map(f => f.properties.id).sort().join('|');
    return window.groceryPoc.renderedIds(side).sort().join('|') === expected;
  }), null, { timeout: 20000 });
  const actual = await page.evaluate(() => {
    const response = window.groceryPoc.getResponse();
    return {
      radius: response.radius_m,
      sides: Object.fromEntries(['left','right'].map(side => [side, {
        address: response[side].address.id,
        expected: response[side].collection.features.map(f => f.properties.id),
        list: [...document.querySelectorAll('#'+side+'-result [data-osm-id]')].map(e => e.dataset.osmId),
        source: window.groceryPoc.mapIds(side), rendered: window.groceryPoc.renderedIds(side),
        links: [...document.querySelectorAll('#'+side+'-result a')].map(e => e.href),
      }])),
    };
  });
  for (const side of ['left','right']) {
    const v = actual.sides[side];
    assert.deepEqual(sorted(v.list), sorted(v.expected));
    assert.deepEqual(sorted(v.source), sorted(v.expected));
    assert.deepEqual(sorted(v.rendered), sorted(v.expected));
    for (const id of v.expected) assert(v.links.includes('https://www.openstreetmap.org/'+id));
  }
  results.push({ label, ...actual });
  return actual;
}

try {
  await page.goto(base);
  for (const [side, item] of [['left', cases[0]], ['right', cases[1]]]) {
    await page.locator('#'+side+'-search').fill(item.query);
    const option = page.locator('#'+side+'-options [data-address-id="'+item.id+'"]');
    await option.waitFor();
    await option.focus();
    await page.keyboard.press('Enter');
  }
  await page.locator('#compare').click();
  await checkCurrent('explicit keyboard address selection, 500 m');
  await page.screenshot({ path: path.join(root,'.runtime/desktop.png'), fullPage: true });

  for (const item of cases) {
    const params = new URLSearchParams({ left: cases[0].id, right: item.id, radius_m: '300' });
    await page.goto(base+'/?'+params);
    const a = await checkCurrent(item.label+', 300 m');
    await page.locator('input[name=radius][value="500"]').check();
    const b = await checkCurrent(item.label+', 500 m');
    assert.equal(a.radius,300); assert.equal(b.radius,500);
    for (const side of ['left','right']) for (const id of a.sides[side].expected) assert(b.sides[side].expected.includes(id));
    if (item.empty) {
      assert.equal(b.sides.right.expected.length,0);
      await page.locator('#right-result .empty').waitFor();
      assert.match(await page.locator('#right-result').innerText(),/не означает/);
    }
    if (item.duplicate_ids) {
      for (const id of item.duplicate_ids) {
        assert(a.sides.right.expected.includes(id));
        assert(b.sides.right.expected.includes(id));
      }
      await page.locator('#right-result .poi > button').first().click();
      assert.equal(await page.locator('#right-result .poi.selected').count(),1);
      await page.screenshot({ path: path.join(root,'.runtime/possible-duplicate.png'), fullPage: true });
    }
  }
  // Clear stale list AND map as soon as the address text changes.
  await page.locator('#right-search').fill('несуществующая строка');
  assert.equal(await page.locator('#right-result [data-osm-id]').count(),0);
  assert.deepEqual(await page.evaluate(() => window.groceryPoc.mapIds('right')),[]);
  await page.locator('#right-options').getByText(/не найдено/).waitFor();
  assert.equal(await page.locator('#compare').isDisabled(),true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base+'/?'+new URLSearchParams({ left: cases[0].id, right: cases[1].id, radius_m: '300' }));
  await checkCurrent('mobile direct URL, 300 m');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: path.join(root,'.runtime/mobile.png'), fullPage: true });

  const bad = await context.request.get(base+'/api/compare?left=way/404&right=way/404&radius_m=500');
  assert.equal(bad.status(),400);
  const radius = await context.request.get(base+'/api/compare?'+new URLSearchParams({ left: cases[0].id, right: cases[1].id, radius_m: '400' }));
  assert.equal(radius.status(),400);
  assert.deepEqual(external,[]);
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(root,'.runtime/browser-results.json'), JSON.stringify({ results, external, errors },null,2)+'\n');
  console.log(JSON.stringify({ comparisons: results.length, externalRequests: external.length, browserErrors: errors.length, mapListIdsEqual: true }));
} catch (error) {
  console.error(JSON.stringify({ external, errors, completed: results.length }));
  await page.screenshot({ path: path.join(root,'.runtime/browser-failure.png'), fullPage: true });
  throw error;
} finally {
  await browser.close();
}
