import { _android as android } from 'playwright';
import { centerOf, findByResource, findByValue, findProductCandidates, nodeValue, parseUiNodes } from './ui.mjs';

export const PACKAGE_NAME = 'com.ss.android.ugc.livelite';
const SEARCH_INPUT_SUFFIX = ':id/or_';

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

export async function dumpUi(device) {
  const remote = `/sdcard/pw-golden-goose-${Date.now()}.xml`;
  try {
    let lastStatus = '';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await device.shell(`uiautomator dump --compressed ${remote}`);
      lastStatus = result.toString();
      if (/dumped to/i.test(lastStatus)) {
        const xml = (await device.shell(`cat ${remote}`)).toString();
        if (xml.includes('<hierarchy') && xml.length > 500) return { xml, nodes: parseUiNodes(xml) };
      }
      // On null root node error, tap screen to wake UI then retry
      if (/null root node/i.test(lastStatus)) {
        await device.shell('input tap 450 800').catch(() => {});
        await sleep(1500);
      } else {
        await sleep(1000 + attempt * 300);
      }
    }
    throw new Error(`UI dump failed after retries: ${lastStatus.trim()}`);
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
  const safe = text.replace(/ /g, '%s').replace(/[^a-zA-Z0-9_%.-]/g, '');
  await device.shell(`input text ${safe}`);
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

  // Check if app is already running — only start if not
  const existingPid = (await device.shell(`pidof ${PACKAGE_NAME}`).catch(() => '')).toString().trim();
  if (!existingPid) {
    await device.shell(`am start -n ${PACKAGE_NAME}/com.ss.android.ugc.aweme.main.MainActivity`);
    await sleep(6_000);
  } else {
    // App is running — just bring to front
    await device.shell(`am start -n ${PACKAGE_NAME}/com.ss.android.ugc.aweme.main.MainActivity`);
    await sleep(2_000);
  }
  const runningPid = (await device.shell(`pidof ${PACKAGE_NAME}`)).toString().trim();
  if (!runningPid) throw new Error(`Douyin Mall package ${PACKAGE_NAME} is not running.`);

  // Dismiss any system dialogs and press Back to escape restored pages
  for (let i = 0; i < 8; i++) {
    let nodes;
    try {
      ({ nodes } = await dumpUi(device));
    } catch {
      // UI dump can fail during app startup — retry after a pause
      await sleep(1000);
      continue;
    }

    // Handle permission dialogs
    const allowBtn = nodes.find((n) => /允许|始终允许/.test(nodeValue(n)) && n.bounds);
    const denyBtn = nodes.find((n) => /拒绝/.test(nodeValue(n)) && n.bounds && n.bounds.y > 400);
    if (allowBtn) { await tap(device, centerOf(allowBtn)); await sleep(600); continue; }
    if (denyBtn) { await tap(device, centerOf(denyBtn)); await sleep(600); continue; }

    // Check if we're on the main page (has bottom nav)
    const hasHomeTab = nodes.some((n) => nodeValue(n) === '首页' && n.bounds && n.bounds.y > screen.height - 200);
    const hasSearchBar = nodes.some((n) => {
      const v = nodeValue(n);
      return n.bounds && n.bounds.y < 160 && n.bounds.width >= 150 && v
        && !/^(搜索|首页|视频|消息|购物袋|我)$/.test(v);
    });

    if (hasHomeTab && i >= 2) break; // On main page, done escaping
    if (hasSearchBar && i >= 1) break; // Search bar visible, likely on main page

    // Press Back to escape nested page
    await press(device, 'Back');
    await sleep(600);
  }

  // Navigate to mall search via bottom nav
  await tap(device, { x: Math.round(screen.width * 0.10), y: Math.round(screen.height * 0.975) });
  await sleep(1_500);
  // Tap the search bar at the top
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
    const input = findByResource(nodes, SEARCH_INPUT_SUFFIX);
    if (input) return { nodes, input };

    const refresh = findByValue(nodes, /^刷新$/);
    if (refresh && nodes.some((node) => /网络错误|当前无网络/.test(node.text || node.desc))) {
      await tap(device, centerOf(refresh));
      await sleep(2_000);
      await tap(device, { x: Math.round(screen.width * 0.22), y: Math.round(screen.height * 0.060) });
      await sleep(900);
      continue;
    }

    // First 2 attempts: try pressing Back to escape nested pages
    if (attempt < 2) {
      await press(device, 'Back');
      await sleep(800);
      continue;
    }

    // Dismiss any dialog
    const cancelBtn = nodes.find((n) => nodeValue(n) === '取消' && n.bounds);
    if (cancelBtn) {
      await tap(device, centerOf(cancelBtn));
      await sleep(500);
      continue;
    }

    // Look for search bar to tap
    const visibleSearchBar = nodes.find((node) => {
      const value = node.desc || node.text;
      return node.bounds
        && node.bounds.y < 160
        && node.bounds.width >= 150
        && value
        && !/^(搜索|首页|视频|消息|购物袋|我)$/.test(value);
    });
    if (visibleSearchBar && attempt < 4) {
      await tap(device, centerOf(visibleSearchBar));
      await sleep(900);
      continue;
    }

    // Final attempts: full reset via bringDouyinMallToFront (which presses Back 5x)
    await bringDouyinMallToFront(device, screen);
  }
  throw new Error('Could not locate the Douyin Mall search input.');
}

export async function searchGoldenGoose(device, screen, query = 'golden goose') {
  const { input } = await locateSearchInput(device, screen);
  await tap(device, centerOf(input));
  await device.shell('input keyevent 28');
  await sleep(200);
  await typeText(device, query);
  await sleep(250);
  const typedNodes = (await dumpUi(device)).nodes;
  const searchButton = typedNodes.find((node) => {
    const value = node.text || node.desc;
    return value === '搜索' && node.bounds && node.bounds.y < 160;
  });
  if (searchButton) await tap(device, centerOf(searchButton));
  else await press(device, 'Enter');

  const loaded = await waitForNodes(device, (current) => {
    const candidates = findProductCandidates(current);
    if (candidates.length > 0) return { candidates };
    const values = current.map((node) => node.text || node.desc);
    if (values.includes('综合') && values.includes('销量') && values.some((value) => /^¥|^￥/.test(value))) {
      return { candidates: [] };
    }
    return null;
  }, 24_000);
  if (!loaded.value) throw new Error('Golden Goose search results did not load.');

  if (loaded.value.candidates.length === 0) {
    await swipeUp(device, screen);
    const afterScroll = await waitForNodes(device, (current) => findProductCandidates(current).length > 0, 12_000);
    if (!afterScroll.value) throw new Error('Search results loaded, but no Golden Goose product cards became visible.');
    return afterScroll.nodes;
  }

  return loaded.nodes;
}

export async function readVisibleCandidates(device) {
  return findProductCandidates((await dumpUi(device)).nodes);
}

export async function scrollResults(device, screen) {
  await swipeUp(device, screen);
}

export async function openCandidate(device, candidate) {
  await tap(device, candidate.tapPoint);
  await sleep(1_800);
}

export async function copyCurrentProductShareLink(device, screen, waitForClipboard) {
  // Share button: left of three-dot menu, top-right action bar
  // UI dump bounds: [814,133][844,163] at 900x1600
  const sharePoint = {
    x: Math.round(screen.width * 0.921),   // 829/900
    y: Math.round(screen.height * 0.0925), // 148/1600
  };

  // Anti-detection: simulate human pre-share behavior
  // Scroll the product page slightly (human browsing pattern)
  const midX = Math.round(screen.width / 2);
  await device.shell(
    `input swipe ${midX} ${Math.round(screen.height * 0.7)} ${midX} ${Math.round(screen.height * 0.55)} ${400 + Math.round(Math.random() * 300)}`
  );
  await sleep(800 + Math.round(Math.random() * 1200));
  // Small random wait before tapping share
  await sleep(500 + Math.round(Math.random() * 1500));

  // Try up to 2 times — sometimes the share panel needs a moment
  for (let attempt = 0; attempt < 2; attempt++) {
    await tap(device, sharePoint);

    const panel = await waitForNodes(device, (nodes) => {
      if (findAccessDenied(nodes)) return { accessDenied: true };
      // Try exact match first, then broader search
      let copyLink = findByValue(nodes, /^复制链接$/);
      if (!copyLink) copyLink = findByValue(nodes, /复制链接/);
      if (!copyLink) copyLink = findByValue(nodes, /复制/);
      if (!copyLink) copyLink = findByValue(nodes, /链接/);
      return copyLink ? { copyLink } : null;
    }, 10_000);

    if (panel.value) {
      if (panel.value.accessDenied) throw new AccessDeniedError();
      await tap(device, centerOf(panel.value.copyLink));
      return waitForClipboard();
    }

    // Dismiss panel and retry
    await press(device, 'Back');
    await sleep(1000);
  }

  throw new Error('The product share panel did not expose “复制链接”.');
}

export async function returnToResults(device) {
  // Press Back multiple times to dismiss any panels, dialogs, or product pages
  for (let i = 0; i < 4; i++) {
    await press(device, 'Back');
    await sleep(500);
    // Check if we're already back at results
    const { nodes } = await dumpUi(device);
    if (findProductCandidates(nodes).length > 0 && findByResource(nodes, SEARCH_INPUT_SUFFIX)) {
      return;
    }
  }

  const result = await waitForNodes(
    device,
    (nodes) => findByResource(nodes, SEARCH_INPUT_SUFFIX) && findProductCandidates(nodes).length > 0,
    12_000,
  );
  if (!result.value) throw new Error('Could not return to the Golden Goose search results.');
}

export async function captureDeviceScreenshot(device, path) {
  await device.screenshot({ path });
}
