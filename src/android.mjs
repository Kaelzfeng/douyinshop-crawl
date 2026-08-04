import { _android as android } from 'playwright';
import { centerOf, findByResource, findByValue, findProductCandidates, nodeValue, parseUiNodes } from './ui.mjs';

export const PACKAGE_NAME = 'com.ss.android.ugc.livelite';

// Re-export app-health functions so all crawl modes get them from one import
export { isAppAlive, ensureAppAlive, softRestart, interProductCooldown } from './app-health.mjs';
const SEARCH_INPUT_SUFFIXES = [':id/or_', ':id/osw'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AccessDeniedError extends Error {
  constructor(message = 'Douyin denied access because operations were too frequent.') {
    super(message);
    this.name = 'AccessDeniedError';
    this.code = 'DOUYIN_ACCESS_DENIED';
  }
}

export function findAccessDenied(nodes) {
  return nodes.find((node) => /访问被拒绝|操作过于频繁/.test(`${node.text || ''} ${node.desc || ''}`));
}

function findSearchInput(nodes) {
  for (const suffix of SEARCH_INPUT_SUFFIXES) {
    const found = findByResource(nodes, suffix);
    if (found) return found;
  }
  // Fallback: any EditText near the top
  return nodes.find(n => n.class === 'android.widget.EditText' && n.bounds && n.bounds.y < 120 && n.bounds.width > 300);
}

export async function connectMuMu(serial) {
  const devices = await android.devices({ host: '127.0.0.1', port: 5037 });
  const device = devices.find((candidate) => candidate.serial() === serial);
  if (!device) {
    const found = devices.map((candidate) => candidate.serial()).join(', ') || 'none';
    await Promise.allSettled(devices.map((candidate) => candidate.close()));
    throw new Error(`MuMu serial ${serial} was not found. Detected: ${found}`);
  }
  device.setDefaultTimeout(8_000);
  return { device, devices };
}

export async function dumpUi(device, { maxAttempts = 12, throwOnFail = true, abortIfDead = true } = {}) {
  const remote = `/sdcard/pw-golden-goose-${Date.now()}.xml`;
  try {
    let lastStatus = '';
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      // Crash-aware early exit: if app process is dead, don't waste time on retries
      if (abortIfDead && attempt >= 3 && attempt % 3 === 0) {
        const { isAppAlive } = await import('./app-health.mjs');
        if (!(await isAppAlive(device))) {
          lastStatus = 'App process dead (pidof returned empty)';
          if (throwOnFail) throw new Error(`UI dump failed: ${lastStatus}`);
          return { xml: '', nodes: [], failed: true, error: lastStatus, appDead: true };
        }
      }

      let status;
      const usePlain = attempt % 2 === 1;
      try {
        status = (await device.shell(
          usePlain ? `uiautomator dump ${remote}` : `uiautomator dump --compressed ${remote}`,
        )).toString();
      } catch (e) {
        status = `${e?.message || e}`;
      }
      lastStatus = status;

      if (/dumped to/i.test(status)) {
        const xml = (await device.shell(`cat ${remote}`)).toString();
        if (xml.includes('<hierarchy') && xml.length > 500) return { xml, nodes: parseUiNodes(xml) };
      }

      // Handle "could not get idle state" — wait for animation; avoid Back (loses detail page)
      if (/could not get idle state/i.test(status)) {
        await sleep(1200 + attempt * 300);
        continue;
      }

      // null root: window transitioning — wait + light tap to attach focus (not Back)
      if (/null root node/i.test(status)) {
        await sleep(1500 + attempt * 400);
        if (attempt === 2 || attempt === 5) {
          await device.shell('input tap 450 900').catch(() => {});
          await sleep(800);
        }
        if (attempt === 7) {
          // nudge app to foreground without force-stop
          await device.shell(`am start -n ${PACKAGE_NAME}/com.ss.android.ugc.aweme.main.MainActivity`).catch(() => {});
          await sleep(2000);
        }
        continue;
      }

      await sleep(700 + attempt * 200);
    }
    if (throwOnFail) throw new Error(`UI dump failed after retries: ${lastStatus.trim()}`);
    return { xml: '', nodes: [], failed: true, error: lastStatus.trim() };
  } finally {
    await device.shell(`rm -f ${remote}`).catch(() => {});
  }
}

async function tap(device, point) {
  await device.shell(`input tap ${Math.round(point.x)} ${Math.round(point.y)}`);
}

async function press(device, key) {
  const keyCode = key === 'Back' ? 4 : key === 'Enter' ? 66 : key;
  await device.shell(`input keyevent ${keyCode}`);
}

async function typeText(device, text) {
  for (const char of text) {
    await device.shell(`input text ${char}`);
    await sleep(60);
  }
}

async function swipeUp(device, screen) {
  const from = { x: Math.round(screen.width / 2), y: Math.round(screen.height * 0.86) };
  const to = { x: from.x, y: Math.round(screen.height * 0.30) };
  await device.shell(`input swipe ${from.x} ${from.y} ${to.x} ${to.y} 450`);
  await sleep(900);
}

export async function getScreenSize(device) {
  const text = (await device.shell('wm size')).toString();
  const match = text.match(/(?:Override|Physical) size:\s*(\d+)x(\d+)/i);
  if (!match) throw new Error(`Unable to parse Android screen size: ${text.trim()}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

export async function bringDouyinMallToFront(device, screen) {
  // Pre-grant permissions to prevent dialogs
  const perms = ['RECORD_AUDIO', 'CAMERA', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE'];
  for (const perm of perms) {
    await device.shell(`pm grant ${PACKAGE_NAME} android.permission.${perm}`).catch(() => {});
  }

  const existingPid = (await device.shell(`pidof ${PACKAGE_NAME}`).catch(() => '')).toString().trim();
  if (!existingPid) {
    await device.shell(`am start -n ${PACKAGE_NAME}/com.ss.android.ugc.aweme.main.MainActivity`);
    await sleep(6_000);
  } else {
    await device.shell(`am start -n ${PACKAGE_NAME}/com.ss.android.ugc.aweme.main.MainActivity`);
    await sleep(2_000);
  }
  const runningPid = (await device.shell(`pidof ${PACKAGE_NAME}`)).toString().trim();
  if (!runningPid) throw new Error(`Douyin Mall package ${PACKAGE_NAME} is not running.`);

  // Dismiss dialogs and escape nested pages
  for (let i = 0; i < 8; i++) {
    let nodes;
    try {
      ({ nodes } = await dumpUi(device));
    } catch {
      await sleep(1000);
      continue;
    }

    // Permission dialogs
    const allowBtn = nodes.find((n) => /允许|始终允许/.test(nodeValue(n)) && n.bounds);
    const denyBtn = nodes.find((n) => /拒绝/.test(nodeValue(n)) && n.bounds && n.bounds.y > 400);
    if (allowBtn) { await tap(device, centerOf(allowBtn)); await sleep(600); continue; }
    if (denyBtn) { await tap(device, centerOf(denyBtn)); await sleep(600); continue; }

    // Update / network error dialogs
    const dismissBtn = nodes.find((n) => /以后再说|暂不|稍后|刷新|重试/.test(nodeValue(n)) && n.bounds);
    if (dismissBtn) { await tap(device, centerOf(dismissBtn)); await sleep(800); continue; }

    // Check if on main page
    const hasHomeTab = nodes.some((n) => nodeValue(n) === '首页' && n.bounds && n.bounds.y > screen.height - 200);
    const hasSearchBar = nodes.some((n) => {
      const v = nodeValue(n);
      return n.bounds && n.bounds.y < 160 && n.bounds.width >= 150 && v
        && !/^(搜索|首页|视频|消息|购物袋|我)$/.test(v);
    });

    if (hasHomeTab && i >= 2) break;
    if (hasSearchBar && i >= 1) break;

    await press(device, 'Back');
    await sleep(600);
  }

  // Navigate to mall search via bottom nav
  await tap(device, { x: Math.round(screen.width * 0.10), y: Math.round(screen.height * 0.975) });
  await sleep(1_500);
  await tap(device, { x: Math.round(screen.width * 0.22), y: Math.round(screen.height * 0.060) });
  await sleep(900);
}

async function waitForNodes(device, predicate, timeoutMs = 18_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    try {
      latest = (await dumpUi(device)).nodes;
      const value = predicate(latest);
      if (value) return { nodes: latest, value };
    } catch {}
    await sleep(600);
  }
  return { nodes: latest, value: null };
}

async function locateSearchInput(device, screen) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { nodes } = await dumpUi(device);
    const input = findSearchInput(nodes);
    if (input) return { nodes, input };

    const refresh = findByValue(nodes, /^刷新$/);
    if (refresh && nodes.some((node) => /网络错误|当前无网络/.test(node.text || node.desc))) {
      await tap(device, centerOf(refresh));
      await sleep(2_000);
      await tap(device, { x: Math.round(screen.width * 0.22), y: Math.round(screen.height * 0.060) });
      await sleep(900);
      continue;
    }

    if (attempt < 2) { await press(device, 'Back'); await sleep(800); continue; }

    const cancelBtn = nodes.find((n) => nodeValue(n) === '取消' && n.bounds);
    if (cancelBtn) { await tap(device, centerOf(cancelBtn)); await sleep(500); continue; }

    const visibleSearchBar = nodes.find((node) => {
      const value = node.desc || node.text;
      return node.bounds && node.bounds.y < 160 && node.bounds.width >= 150 && value
        && !/^(搜索|首页|视频|消息|购物袋|我)$/.test(value);
    });
    if (visibleSearchBar && attempt < 4) { await tap(device, centerOf(visibleSearchBar)); await sleep(900); continue; }

    await bringDouyinMallToFront(device, screen);
  }
  throw new Error('Could not locate the Douyin Mall search input.');
}

export async function searchGoldenGoose(device, screen, query = 'ggdb') {
  const q = String(query || '').trim();
  if (!q || q.length > 40 || /[\\/]|\.md|claude|plans|ctrl\+/i.test(q)) {
    throw new Error(`Refusing suspicious search keyword: ${JSON.stringify(q)}`);
  }

  const isChinese = /[一-鿿]/.test(q);
  console.log(`[search] keyword=${JSON.stringify(q)} chinese=${isChinese}`);

  // Always use mall search UI so we land on product results (not homepage feed).
  const { input } = await locateSearchInput(device, screen);
  await tap(device, centerOf(input));
  await device.shell('input keyevent 28'); // CLEAR
  await sleep(250);
  // Select-all + delete residual text
  await device.shell('input keyevent 29'); // A
  await device.shell('input keyevent 67'); // DEL — may not select-all; also:
  await device.shell('input keyevent 123'); // MOVE_END
  for (let i = 0; i < 30; i++) await device.shell('input keyevent 67'); // DEL
  await sleep(200);

  if (isChinese) {
    // ── Chinese keyword: clipboard paste (adb input text doesn't support CJK) ──
    // Strategy: set Android clipboard directly (cmd clipboard set), verify, retry.
    // Windows clipboard is a best-effort seed for MuMu sync, never required.
    const { setWindowsClipboard } = await import('./clipboard.mjs');
    setWindowsClipboard(q).catch((e) =>
      console.warn(`[search] Windows clipboard set failed (non-fatal): ${e.message.slice(0, 80)}`));

    const safe = q.replace(/"/g, '\\"');
    let clipboardOk = false;

    // Set Android clipboard with verification + retries
    for (let attempt = 0; attempt < 5; attempt++) {
      await device.shell(`cmd clipboard set --user 0 "${safe}"`).catch(() => {});
      await sleep(300);

      // Verify: read back what we just set
      try {
        const verify = (await device.shell('cmd clipboard get --user 0')).toString().trim();
        if (verify === q) { clipboardOk = true; break; }
        if (verify.length > 0 && verify !== 'null') {
          // Clipboard has SOMETHING but not our keyword — possibly stale sync.
          // Overwrite again after a short wait.
          console.warn(`[search] clipboard verify attempt ${attempt + 1}: got "${verify.slice(0, 30)}" want "${q}"`);
        }
      } catch {}
      await sleep(500);
    }

    if (!clipboardOk) {
      // Last resort: service call clipboard (older Android API)
      try {
        await device.shell(`service call clipboard 1 i32 1 i32 0 s16 "${safe}"`);
        await sleep(400);
      } catch {}
    }

    // Focus search field and paste
    await tap(device, centerOf(input));
    await sleep(300);
    await device.shell('input keyevent 279'); // KEYCODE_PASTE
    await sleep(600);

    // Verify paste: dump UI and check the EditText value
    try {
      const afterPaste = (await dumpUi(device, { maxAttempts: 3, throwOnFail: false })).nodes;
      const editTexts = afterPaste.filter((n) => n.class === 'android.widget.EditText');
      const pasted = editTexts.some((n) => {
        const v = (n.text || n.desc || '');
        return v.includes(q) || q.includes(v);
      });
      if (!pasted && editTexts.length > 0) {
        console.warn(`[search] paste verification failed — EditText values: ${editTexts.map((n) => JSON.stringify((n.text || n.desc || '').slice(0, 20))).join(', ')}`);
        // Retry: set clipboard again + paste again
        await device.shell(`cmd clipboard set --user 0 "${safe}"`).catch(() => {});
        await sleep(200);
        await tap(device, centerOf(input));
        await sleep(200);
        await device.shell('input keyevent 279');
        await sleep(600);
      }
    } catch {}
  } else {
    await typeText(device, q);
    await sleep(300);
  }

  const typedNodes = (await dumpUi(device)).nodes;
  const searchButton = typedNodes.find((node) => nodeValue(node) === '搜索' && node.bounds && node.bounds.y < 160);
  if (searchButton) await tap(device, centerOf(searchButton));
  else {
    // Fallback coordinate for orange 搜索 on 900x1600
    await device.shell(`input tap ${Math.round(screen.width * 0.9)} ${Math.round(screen.height * 0.055)}`);
  }
  await sleep(1500);

  // Quick diagnostic: what's visible after search button tap
  try {
    const diag = (await dumpUi(device, { maxAttempts: 2, throwOnFail: false })).nodes;
    const sample = [...new Set(diag.filter((n) => n.bounds && n.bounds.y < 900)
      .map((n) => (n.text || n.desc || '').trim()).filter(Boolean))]
      .slice(0, 30);
    const hasTabs = sample.filter((v) => /综合|销量|价格|筛选|全部|店铺|直播|视频|用户|商品/.test(v));
    console.log(`[search] post-tap sample: ${hasTabs.join(' ')} (${diag.length} nodes)`);
  } catch {}

  const loaded = await waitForNodes(device, (current) => {
    const candidates = findProductCandidates(current, q);
    if (candidates.length > 0) return { candidates };
    const values = current.map((node) => node.text || node.desc);
    if (values.includes('综合') && values.includes('销量') && values.some((value) => /^¥|^￥|券后价/.test(value))) {
      return { candidates: [] };
    }
    if (values.includes('全部') || values.includes('店铺') || values.some(v => /券后价|已售\d+|店铺销量/.test(v))) {
      return { candidates: [] };
    }
    // Empty-result page still means search ran (wrong keyword / no goods)
    if (values.some((v) => /搜索结果为空|没有找到相关/.test(v || ''))) {
      return { candidates: [], empty: true };
    }
    return null;
  }, 24_000);
  if (!loaded.value) {
    const refresh = findByValue(loaded.nodes, /刷新/);
    if (refresh) { await tap(device, centerOf(refresh)); await sleep(2_500); }
    const retry = await waitForNodes(device, (current) => {
      const candidates = findProductCandidates(current, q);
      if (candidates.length > 0) return { candidates };
      const values = current.map((node) => node.text || node.desc);
      if (values.includes('综合') && values.includes('销量')) return { candidates: [] };
      if (values.includes('全部') || values.includes('店铺')) return { candidates: [] };
      if (values.some((v) => /搜索结果为空|没有找到相关/.test(v || ''))) {
        return { candidates: [], empty: true };
      }
      return null;
    }, 24_000);
    if (!retry.value) throw new Error(`${q} search results did not load.`);
    loaded.value = retry.value;
    loaded.nodes = retry.nodes;
  }

  return loaded.nodes;
}

export async function readVisibleCandidates(device, query = '') {
  return findProductCandidates((await dumpUi(device)).nodes, query);
}

export async function scrollResults(device, screen) {
  await swipeUp(device, screen);
}

/**
 * Check whether the current UI looks like a product detail page.
 * Looks for: share button, price info, buy/cart buttons, or product-related nodes.
 */
function looksLikeProductPage(nodes) {
  // Has share button (strongest signal)
  if (nodes.some((n) => {
    const v = nodeValue(n);
    return v === '分享' || /分享/.test(v);
  })) return true;

  // Has price or buy/cart button
  if (nodes.some((n) => {
    const v = nodeValue(n);
    return /[¥￥]\s*\d/.test(v) || /立即购买|加入购物车|马上抢|去购买/.test(v);
  })) return true;

  // Has product detail sections (specs, reviews, store entry on detail page)
  let specCount = 0;
  for (const n of nodes) {
    const v = nodeValue(n);
    if (/规格|保障|说明|评价|店铺/.test(v)) specCount++;
    if (specCount >= 2) return true;
  }

  return false;
}

export async function openCandidate(device, candidate) {
  // Try primary tap point
  await tap(device, candidate.tapPoint);
  await sleep(2_000);

  // Verify we're on a product detail page
  let nodes;
  try {
    nodes = (await dumpUi(device)).nodes;
  } catch {
    nodes = [];
  }
  if (looksLikeProductPage(nodes)) return;

  // Not on product page — try fallback positions
  const fallbacks = [
    { x: candidate.tapPoint.x, y: Math.max(120, candidate.titleBounds.y - 120) },
    { x: candidate.tapPoint.x, y: Math.max(120, candidate.titleBounds.y - 160) },
    { x: Math.round(candidate.titleBounds.x + candidate.titleBounds.width * 0.3), y: Math.max(120, candidate.titleBounds.y - 200) },
  ];

  for (const pt of fallbacks) {
    // Press back to return from wherever we ended up
    await device.shell('input keyevent 4').catch(() => {});
    await sleep(800);

    // Re-verify we're back on search results; if not, keep going back
    for (let b = 0; b < 3; b++) {
      try {
        const check = (await dumpUi(device)).nodes;
        const hasSearch = check.some((n) => /搜索/.test(nodeValue(n)) && n.bounds && n.bounds.y < 200);
        if (hasSearch) break;
      } catch {}
      await device.shell('input keyevent 4').catch(() => {});
      await sleep(500);
    }

    await tap(device, pt);
    await sleep(2_000);

    try {
      nodes = (await dumpUi(device)).nodes;
    } catch {
      nodes = [];
    }
    if (looksLikeProductPage(nodes)) {
      console.log(`[open] fallback tap y=${pt.y} succeeded`);
      return;
    }
  }

  // All attempts failed — press back to return to search and let caller handle
  for (let b = 0; b < 4; b++) {
    await device.shell('input keyevent 4').catch(() => {});
    await sleep(400);
  }
}

/**
 * Find share button using multi-tier detection.
 * @returns {{ x: number, y: number } | null}
 */
function findShareButton(nodes, screen) {
  // Tier 1: exact text "分享" near top-right (y < 200)
  const tier1 = nodes.find((n) => nodeValue(n) === '分享' && n.bounds && n.bounds.y < 200);
  if (tier1) return centerOf(tier1);

  // Tier 2: text or desc containing "分享" anywhere visible
  const tier2 = nodes.find((n) => {
    const v = nodeValue(n);
    return v && /分享/.test(v) && n.bounds && n.bounds.width > 20;
  });
  if (tier2) return centerOf(tier2);

  // Tier 3: clickable node near top-right with share-like text
  const tier3 = nodes.find((n) => {
    if (!n.bounds || !n.clickable) return false;
    const xRatio = n.bounds.x / screen.width;
    const yRatio = n.bounds.y / screen.height;
    if (xRatio < 0.75 || yRatio > 0.15) return false;
    const v = nodeValue(n);
    return v && /分享|转发|share/i.test(v);
  });
  if (tier3) return centerOf(tier3);

  // Tier 4: fixed coordinate fallback
  return { x: Math.round(screen.width * 0.921), y: Math.round(screen.height * 0.0925) };
}

/**
 * Find "复制链接" button in share panel using multi-tier detection.
 */
function findCopyLinkNode(nodes) {
  // Tier 1: exact class + exact text at typical share panel position
  const tier1 = nodes.find((n) =>
    n.class === 'android.widget.TextView' &&
    n.text === '复制链接' &&
    n.bounds &&
    n.bounds.y > 700 &&
    n.bounds.y < 1300
  );
  if (tier1) return tier1;

  // Tier 2: exact text match anywhere
  const tier2 = findByValue(nodes, /^复制链接$/);
  if (tier2) return tier2;

  // Tier 3: fuzzy match
  let result = findByValue(nodes, /复制链接/);
  if (result) return result;

  // Tier 4: broader fuzzy fallback
  result = findByValue(nodes, /复制/);
  if (result) return result;

  return findByValue(nodes, /链接/);
}

/**
 * Wait for the share panel to appear after tapping the share button.
 * Returns the copy-link node if found, or null if the panel didn't open.
 */
async function waitForSharePanel(device) {
  const result = await waitForNodes(device, (nodes) => {
    if (findAccessDenied(nodes)) return { accessDenied: true };
    // Check for captcha
    if (nodes.some((n) => /验证码|拖拽|拼图|完成验证/.test(nodeValue(n)))) return { captcha: true };
    const copyLink = findCopyLinkNode(nodes);
    if (copyLink) return { copyLink, panelOpen: true };
    // Also check: is there a dismiss/cancel button (panel may be open without copy-link visible yet)
    const dismiss = nodes.find((n) => /取消|关闭/.test(nodeValue(n)) && n.bounds && n.bounds.y > 700);
    if (dismiss) return { panelOpen: true, copyLink: null };
    return null;
  }, 10_000);
  return result;
}

/**
 * Dismiss the share panel if open.
 */
async function dismissSharePanel(device) {
  await press(device, 'Back').catch(() => {});
  await sleep(400);
}

export async function copyCurrentProductShareLink(device, screen, waitForClipboard) {
  // Clear device clipboard first to prevent stale URL reads
  try {
    const { clearDeviceClipboard } = await import('./clipboard.mjs');
    await clearDeviceClipboard(device);
  } catch { /* best-effort */ }

  // Pre-share scroll with human-like jitter
  const midX = Math.round(screen.width / 2);
  const swipeDuration = 400 + Math.round(Math.random() * 300);
  await device.shell(
    `input swipe ${midX} ${Math.round(screen.height * 0.7)} ${midX} ${Math.round(screen.height * 0.55)} ${swipeDuration}`
  );
  // Human-like delay with ±50% jitter (triangular distribution)
  const jitteredDelay = (base) => {
    const u1 = Math.random(); const u2 = Math.random();
    const normalish = u1 + u2 - 1;
    return Math.max(0, Math.round(base + base * 0.5 * normalish));
  };
  await sleep(jitteredDelay(800));
  await sleep(jitteredDelay(500));

  for (let attempt = 0; attempt < 3; attempt++) {
    // Find share button with multi-tier detection
    let sharePt;
    try {
      const { nodes } = await dumpUi(device);
      sharePt = findShareButton(nodes, screen);
    } catch {
      sharePt = { x: Math.round(screen.width * 0.921), y: Math.round(screen.height * 0.0925) };
    }
    await tap(device, sharePt);

    // Wait for share panel to appear
    const panel = await waitForSharePanel(device);

    if (panel.value) {
      if (panel.value.accessDenied) throw new AccessDeniedError();
      if (panel.value.captcha) {
        console.warn('[captcha] Verification required — waiting 3 minutes before retry...');
        await dismissSharePanel(device);
        await sleep(180_000); // 3 min cooldown
        continue;
      }
      if (panel.value.copyLink) {
        await tap(device, centerOf(panel.value.copyLink));
        return waitForClipboard();
      }
      // Panel open but no copy-link found yet — wait a bit and re-scan
      await sleep(800);
      try {
        const { nodes } = await dumpUi(device);
        const copyLink = findCopyLinkNode(nodes);
        if (copyLink) {
          await tap(device, centerOf(copyLink));
          return waitForClipboard();
        }
      } catch { /* fall through to retry */ }
    }

    // Panel didn't open properly — on attempt 3, try long-press at share position
    if (attempt === 2) {
      console.warn('[share] Attempt 3 — trying long-press menu...');
      await device.shell(
        `input swipe ${sharePt.x} ${sharePt.y} ${sharePt.x} ${sharePt.y} 1500`
      );
      await sleep(800);
      try {
        const { nodes } = await dumpUi(device);
        const shareMenuItem = nodes.find((n) => /分享|复制链接/.test(nodeValue(n)) && n.bounds && n.bounds.y > 400);
        if (shareMenuItem) {
          await tap(device, centerOf(shareMenuItem));
          const panel2 = await waitForSharePanel(device);
          if (panel2.value?.copyLink) {
            await tap(device, centerOf(panel2.value.copyLink));
            return waitForClipboard();
          }
        }
      } catch { /* fall through */ }
    }

    await dismissSharePanel(device);
    await sleep(1000);
  }

  throw new Error('The product share panel did not expose "复制链接".');
}

export async function returnToResults(device, query = '') {
  for (let i = 0; i < 4; i++) {
    await press(device, 'Back');
    await sleep(500);
    const { nodes } = await dumpUi(device);
    if (findProductCandidates(nodes, query).length > 0 && findSearchInput(nodes)) {
      return;
    }
  }

  const result = await waitForNodes(
    device,
    (nodes) => findSearchInput(nodes) && findProductCandidates(nodes, query).length > 0,
    12_000,
  );
  if (!result.value) throw new Error('Could not return to the search results.');
}

export async function captureDeviceScreenshot(device, path) {
  await device.screenshot({ path });
}
