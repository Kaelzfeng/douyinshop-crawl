/**
 * Persistent crawl loop - restarts app when needed, keeps crawling forever.
 * Run: MUMU_SERIAL=emulator-5554 node keep-crawling.mjs
 */
import { _android } from 'playwright';

const SERIAL = process.env.MUMU_SERIAL || 'emulator-5554';
const PKG = 'com.ss.android.ugc.livelite';
const OUTPUT = 'output/all-products-final.csv';
const MODE = 'ggdb'; // or 小脏鞋

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ensureAppRunning() {
  const devices = await _android.devices({ host: '127.0.0.1', port: 5037 });
  const device = devices.find(d => d.serial() === SERIAL);
  if (!device) throw new Error('Device not found');

  const pid = (await device.shell(`pidof ${PKG}`).catch(() => '')).toString().trim();
  if (!pid) {
    console.log('[loop] Starting app...');
    await device.shell(`am start -n ${PKG}/com.ss.android.ugc.aweme.main.MainActivity`);
    await sleep(5000);
  }

  // Navigate to search page
  await device.shell('input tap 90 1560'); await sleep(1500);
  await device.shell('input tap 198 96'); await sleep(1000);

  // Verify search input
  const { parseUiNodes } = await import('./src/ui.mjs');
  await device.shell('uiautomator dump /sdcard/pw-loop.xml');
  const xml = (await device.shell('cat /sdcard/pw-loop.xml')).toString();
  if (!xml.includes('<hierarchy')) {
    console.log('[loop] Dump failed, retrying...');
    await device.close();
    return false;
  }
  const nodes = parseUiNodes(xml);
  const hasInput = nodes.some(n => (n['resource-id'] || '').endsWith('id/or_') || (n['resource-id'] || '').endsWith('id/osw'));
  if (!hasInput) {
    console.log('[loop] Search input not found, retrying nav...');
    await device.shell('input tap 90 1560'); await sleep(1500);
    await device.shell('input tap 198 96'); await sleep(1000);
  }

  await device.close();
  return true;
}

async function runCrawl() {
  const { execSync } = await import('node:child_process');
  try {
    const result = execSync(
      `node src/cli.mjs --serial ${SERIAL} --all --gentle --output ${OUTPUT}`,
      { encoding: 'utf8', timeout: 600000, stdio: 'pipe', env: { ...process.env, MUMU_SERIAL: SERIAL } }
    );
    // Extract collected count
    const match = result.match(/"collected":\s*(\d+)/);
    if (match) console.log(`[loop] Collected: ${match[1]}`);
    return true;
  } catch (e) {
    const msg = e.stdout || e.message || '';
    // If search input not found or search failed, need to restart app
    if (/Could not locate|search results did not load/.test(msg)) {
      console.log('[loop] App state broken, restarting...');
      return false;
    }
    // Other errors, continue anyway
    const match = msg.match(/"collected":\s*(\d+)/);
    if (match) console.log(`[loop] Partial: ${match[1]}`);
    return true;
  }
}

let lastCount = 0;
let noNewCount = 0;
while (true) {
  console.log(`\n[loop] === Round starting at ${new Date().toLocaleTimeString()} ===`);

  const appOk = await ensureAppRunning();
  if (!appOk) {
    console.log('[loop] App setup failed, restarting app...');
    const devices = await _android.devices({ host: '127.0.0.1', port: 5037 });
    const device = devices.find(d => d.serial() === SERIAL);
    if (device) {
      await device.shell(`am force-stop ${PKG}`).catch(() => {});
      await sleep(2000);
      await device.close();
    }
    continue;
  }

  const ok = await runCrawl();

  // Check if we got new products
  try {
    const fs = await import('node:fs');
    const lines = fs.readFileSync(OUTPUT, 'utf8').trim().split('\n');
    const count = lines.length - 1; // minus header
    if (count === lastCount) {
      noNewCount++;
      console.log(`[loop] No new products (${count}). Streak: ${noNewCount}`);
      if (noNewCount >= 5) {
        console.log('[loop] 5 rounds with no new products. Done!');
        break;
      }
    } else {
      console.log(`[loop] New products! ${lastCount} -> ${count} (+${count - lastCount})`);
      lastCount = count;
      noNewCount = 0;
    }
  } catch {}

  if (!ok) {
    console.log('[loop] Waiting 30s before restart...');
    await sleep(30000);
  }
}

console.log('[loop] Finished.');
