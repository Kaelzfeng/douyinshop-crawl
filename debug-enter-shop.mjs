/**
 * Debug: test entering shop via search → product → shop
 */
import { _android } from 'playwright';
import { dumpUi, getScreenSize, bringDouyinMallToFront, searchGoldenGoose } from './src/android.mjs';
import { nodeValue, centerOf } from './src/ui.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ds = await _android.devices({ host: '127.0.0.1', port: 5037 });
const d = ds.find(c => c.serial() === '127.0.0.1:16384');
const screen = await getScreenSize(d);

try {
  // Step 1: Search golden goose (proven to work)
  console.log('1. Searching golden goose...');
  await bringDouyinMallToFront(d, screen);
  await searchGoldenGoose(d, screen);

  // Step 2: Find first product card
  const { nodes } = await dumpUi(d);
  const candidates = nodes.filter(n => {
    const v = nodeValue(n);
    return n.bounds && v.includes('Golden Goose') && v.length > 20
      && n.bounds.y > 500 && n.bounds.x > 200 && n.bounds.width > 300;
  });
  if (candidates.length === 0) { console.log('No products in search'); process.exit(1); }

  const first = candidates[0];
  const title = nodeValue(first);
  console.log('2. Tapping product: ' + title.slice(0, 60));
  await d.shell(`input tap ${Math.round(first.bounds.x + first.bounds.width/2)} ${Math.round(first.bounds.y - 150)}`);
  await sleep(3000);

  // Step 3: On product detail page, find shop entry
  const detailNodes = (await dumpUi(d)).nodes;
  const allTexts = detailNodes
    .filter(n => { const v = nodeValue(n); return v.length > 0 && v.length < 100 && n.bounds; })
    .sort((a,b) => a.bounds.y - b.bounds.y);

  console.log('3. Product page content:');
  allTexts.forEach(t => {
    const v = nodeValue(t);
    if (!v.includes('png') && !v.includes('tplv') && !v.includes('sx_') && !v.includes('webp') && !v.includes('resize') && !v.includes('jpeg')) {
      console.log(' y='+t.bounds.y+' x='+t.bounds.x+' w='+t.bounds.width+' \"'+v+'\"');
    }
  });

  // Find shop name - ALL patterns
  const shopPatterns = ['旗舰店', '专卖店', '专营店', '企业店', '个体店', '进店', '店铺'];
  for (const pat of shopPatterns) {
    const found = detailNodes.filter(n => nodeValue(n).includes(pat) && n.bounds);
    if (found.length > 0) {
      console.log('');
      console.log('Pattern \"' + pat + '\": ' + found.length + ' matches');
      found.forEach(f => {
        console.log(' y='+f.bounds.y+' x='+f.bounds.x+' \"'+nodeValue(f)+'\"');
      });
    }
  }

} finally {
  await Promise.allSettled(ds.map(c => c.close()));
}
