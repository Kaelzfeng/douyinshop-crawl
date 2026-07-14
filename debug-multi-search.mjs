/**
 * Test: search with a different keyword to find NEW products
 */
import { _android } from 'playwright';
import { dumpUi, getScreenSize, bringDouyinMallToFront } from './src/android.mjs';
import { nodeValue } from './src/ui.mjs';
import { readFileSync, writeFileSync } from 'fs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ds = await _android.devices({ host: '127.0.0.1', port: 5037 });
const d = ds.find(c => c.serial() === '127.0.0.1:16384');
const screen = await getScreenSize(d);

// Load existing products to check for duplicates
const checkpoint = JSON.parse(readFileSync('data/checkpoint.json', 'utf8'));
const existingTitles = new Set(checkpoint.products.map(p => p.商品品名));
console.log(`Existing: ${existingTitles.size} products`);

// Search "golden goose 鞋" — broader term
console.log('\nSearching: golden goose 鞋');
await bringDouyinMallToFront(d, screen);

// Navigate to search
await d.shell('input tap ' + Math.round(screen.width * 0.22) + ' ' + Math.round(screen.height * 0.060));
await sleep(1000);
await d.shell('input keyevent 28'); await sleep(200);
await d.shell('input text golden%20goose%20%E9%9E%8B'); await sleep(300);
await d.shell('input keyevent 66'); await sleep(4000);

// Scroll and collect titles
let allTitles = [];
for (let scroll = 0; scroll < 10; scroll++) {
  const { nodes } = await dumpUi(d);
  const titles = nodes
    .filter(n => {
      const v = nodeValue(n);
      return n.bounds && v.length > 20 && n.bounds.y > 500
        && n.bounds.x > 200 && n.bounds.width > 300
        && v.toLowerCase().includes('golden');
    })
    .map(n => nodeValue(n));

  let newCount = 0;
  for (const t of titles) {
    if (!allTitles.includes(t)) {
      allTitles.push(t);
      newCount++;
    }
  }

  const newForCheckpoint = titles.filter(t => !existingTitles.has(t)).length;
  console.log(`Scroll ${scroll+1}: ${titles.length} visible, ${newForCheckpoint} NEW for checkpoint, ${newCount} new this run`);

  if (newCount === 0 && scroll >= 3) break;

  // Scroll
  await d.shell(`input swipe ${Math.round(screen.width/2)} ${Math.round(screen.height*0.82)} ${Math.round(screen.width/2)} ${Math.round(screen.height*0.28)} 400`);
  await sleep(1000);
}

const newForCheckpoint = allTitles.filter(t => !existingTitles.has(t));
console.log(`\nTotal unique titles: ${allTitles.length}, ${newForCheckpoint.length} not in checkpoint`);

await Promise.allSettled(ds.map(c => c.close()));
