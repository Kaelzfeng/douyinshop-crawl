/**
 * Shop crawler — enters a shop from a product link, scrolls ALL products,
 * filters by keywords (ggdb / 小脏鞋), extracts data WITHOUT browser enrich.
 *
 * Adapted for Douyin Mall 39.6.0
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { _android as android } from 'playwright';
import {
  dumpUi, getScreenSize, PACKAGE_NAME, AccessDeniedError, findAccessDenied,
  searchGoldenGoose, readVisibleCandidates, openCandidate,
} from './android.mjs';
import { nodeValue, centerOf, findByValue } from './ui.mjs';
import { readCurrentDouyinShareUrl, waitForDouyinShareUrl, extractShareUrl } from './clipboard.mjs';
import { loadCheckpoint, productIdentityKey, writeArtifacts } from './output.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Foreground activity (more reliable than sparse a11y on Mall 39.6) ──

async function getForegroundComponent(device) {
  try {
    const out = (await device.shell('dumpsys window')).toString();
    const m = out.match(/mCurrentFocus=Window\{[^ ]+ u0 ([^}/]+)\/([^}]+)\}/)
      || out.match(/mFocusedApp=ActivityRecord\{[^ ]+ u0 ([^}/]+)\/([^ ]+)/);
    if (m) return { pkg: m[1], activity: m[2], raw: `${m[1]}/${m[2]}` };
  } catch {}
  try {
    const out = (await device.shell('dumpsys activity activities')).toString();
    const m = out.match(/topResumedActivity=ActivityRecord\{[^ ]+ u0 ([^}/]+)\/([^ ]+)/)
      || out.match(/mResumedActivity: ActivityRecord\{[^ ]+ u0 ([^}/]+)\/([^ ]+)/);
    if (m) return { pkg: m[1], activity: m[2], raw: `${m[1]}/${m[2]}` };
  } catch {}
  return { pkg: '', activity: '', raw: '' };
}

/**
 * True if shop/detail is the resumed top OR immediately under a risk/dialog overlay.
 * Do NOT scan full history — ProductDetail often remains below ECStore and false-positives.
 */
async function stackHas(device, re) {
  try {
    const out = (await device.shell('dumpsys activity activities')).toString();
    // Prefer top resumed line only
    const top = out.match(/topResumedActivity=ActivityRecord\{[^ ]+ u0 ([^}\s]+)/);
    if (top && re.test(top[1])) return true;
    const resumed = out.match(/mResumedActivity: ActivityRecord\{[^ ]+ u0 ([^}\s]+)/);
    if (resumed && re.test(resumed[1])) return true;
    // Overlay case: top is TuringLiveDetect, next hist is shop
    const focus = await getForegroundComponent(device);
    if (isRiskActivity(focus) || isTransientOverlay(focus)) {
      // First Hist entry under package that's not risk
      const hist = [...out.matchAll(/\* Hist\s+#\d+:\s*ActivityRecord\{[^ ]+ u0 ([^}\s]+)/g)]
        .map((m) => m[1]);
      for (const h of hist.slice(0, 3)) {
        if (isRiskActivity({ activity: h }) || isTransientOverlay({ activity: h })) continue;
        if (re.test(h)) return true;
        break;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function isDetailActivity(comp) {
  const a = comp?.activity || comp?.raw || '';
  // Pure product detail only (gallery/sku handled as transient overlay)
  return /ProductDetailActivity|GoodsDetail|anchorv4\.containers\.ProductDetail/i.test(a);
}

function isShopActivity(comp) {
  const a = comp?.activity || comp?.raw || '';
  // Include in-shop search results activity
  return /ECStoreActivity|store\.arch\.ECStore|ShopHome|ShopActivity|StoreActivity|ECShopSearch|store\.search/i.test(a);
}

function isRiskActivity(comp) {
  const a = comp?.activity || comp?.raw || '';
  return /TuringLiveDetect|LiveDetect|Verify|Captcha|bdturing|BdTuring|SecDialog|Risk/i.test(a);
}

/**
 * Dismiss captcha / face-verify overlays.
 * Drag-captcha WebView has an X button top-right of dialog (~[682,237]-[774,328] on 900x1600).
 */
async function dismissRiskOverlay(device, screen) {
  const dump = await softDump(device, 3);
  const nodes = dump.nodes || [];

  // Explicit cancel only — NEVER 帮助咨询 (opens web help) or 开始检测 (face scan)
  const cancel = nodes.find((n) => {
    const v = nodeValue(n);
    return n.bounds && /^(取消|关闭|稍后再说|跳过|暂不|以后再说)$/.test(v);
  });
  if (cancel) {
    console.log(`[shop] risk dismiss text=${nodeValue(cancel)}`);
    await device.shell(
      `input tap ${Math.round(cancel.bounds.x + cancel.bounds.width / 2)} ${Math.round(cancel.bounds.y + cancel.bounds.height / 2)}`,
    );
    await sleep(1200);
    return true;
  }

  // Captcha dialog close button: clickable empty Button near top-right of captcha box
  const closeBtn = nodes.find((n) => {
    if (!n.bounds || n.clickable !== 'true' && n.clickable !== true) return false;
    const b = n.bounds;
    // top-right of screen upper half, small square
    return b.y < 400 && b.x > (screen?.width || 900) * 0.65 && b.width < 120 && b.height < 120
      && !nodeValue(n);
  });
  if (closeBtn) {
    console.log('[shop] risk dismiss captcha X button');
    await device.shell(
      `input tap ${Math.round(closeBtn.bounds.x + closeBtn.bounds.width / 2)} ${Math.round(closeBtn.bounds.y + closeBtn.bounds.height / 2)}`,
    );
    await sleep(1200);
    return true;
  }

  // Face-verify guide often only has 开始检测 + 帮助咨询 — Back keeps shop underneath
  const comp = await getForegroundComponent(device);
  if (/TuringLiveDetect|LiveDetectGuide/i.test(comp.activity || '')) {
    console.log('[shop] risk dismiss face-guide → Back');
    await device.shell('input keyevent 4');
    await sleep(1500);
    if (!isRiskActivity(await getForegroundComponent(device))) return true;
  }

  // Fixed coords for drag-captcha X (dialog top-right) + outside dismiss
  const w = screen?.width || 900;
  const h = screen?.height || 1600;
  for (const [x, y] of [
    [0.81, 0.176], // ~728,282 on 900x1600
    [0.86, 0.16],
    [0.78, 0.19],
    [0.50, 0.12], // outside top of dialog
  ]) {
    console.log(`[shop] risk dismiss tap ${x},${y}`);
    await device.shell(`input tap ${Math.round(w * x)} ${Math.round(h * y)}`);
    await sleep(900);
    if (!isRiskActivity(await getForegroundComponent(device))) return true;
  }
  // Back as last resort
  console.log('[shop] risk dismiss → Back');
  await device.shell('input keyevent 4');
  await sleep(1000);
  return true;
}

function isTransientOverlay(comp) {
  const a = comp?.activity || comp?.raw || '';
  return /FullScreenGallery|GalleryDialog|SkuPanel|SpecPanel|DialogActivity/i.test(a);
}

/** Dismiss gallery / SKU overlays that block detail chrome (进店). */
async function dismissTransientOverlays(device, max = 4) {
  for (let i = 0; i < max; i++) {
    const comp = await getForegroundComponent(device);
    if (!isTransientOverlay(comp) && !isRiskActivity(comp)) return comp;
    if (isRiskActivity(comp)) {
      console.warn(`[shop] risk activity ${comp.activity?.split('.').pop()} — Back`);
      await device.shell('input keyevent 4');
      await sleep(1500);
      continue;
    }
    console.log(`[shop] dismiss overlay ${comp.activity?.split('.').pop()}`);
    await device.shell('input keyevent 4');
    await sleep(900);
  }
  return getForegroundComponent(device);
}

// ── Shop navigation ──

function pageTexts(nodes) {
  return (nodes || []).map((n) => nodeValue(n)).filter(Boolean);
}

function isRiskUi(nodes) {
  const vals = pageTexts(nodes);
  return vals.some((v) =>
    /验证码|拖拽|拼图|完成验证|请进行验证|开始检测|人脸信息|安全验证|为保障账号安全|请选择所有符合|访问被拒绝|操作过于频繁|核验身份/.test(v),
  );
}

/** Account hard-blocked: rate limit / access denied (often 12h cooldown). */
function isAccessDeniedUi(nodes) {
  const vals = pageTexts(nodes);
  return vals.some((v) => /访问被拒绝|操作过于频繁|核验身份立即恢复|预计\d+小时后即可正常访问/.test(v));
}

function isProductDetailUi(nodes) {
  const vals = pageTexts(nodes);
  if (isRiskUi(nodes)) return false;
  return (
    vals.some((v) => /分享|客服|加入购物车|领券购买|立即购买|规格|选规格|加入购物袋|现在下单|\+加购|^进店$/.test(v))
    || vals.some((v) => /进店逛逛/.test(v))
    || nodes.some((n) => {
      const v = nodeValue(n);
      return /(?:旗舰店|专卖店|专营店)/.test(v) && n.bounds && n.bounds.y > 80 && n.bounds.y < 500;
    })
  );
}

function isInsideShopUi(nodes) {
  if (isRiskUi(nodes)) return false;
  const vals = pageTexts(nodes);
  const hasGoodsTab = (nodes || []).some((n) => nodeValue(n) === '商品' && n.bounds && n.bounds.y < 600);
  const hasBottomShop = vals.some((v) => /全部商品|店铺动态|联系客服|店铺首页/.test(v));
  const hasSortBar = vals.includes('综合') && (vals.includes('销量') || vals.includes('新品') || vals.includes('双列'));
  const hasShopHeader = vals.some((v) => /粉丝/.test(v))
    && vals.some((v) => /关注|已关注/.test(v))
    && vals.some((v) => /旗舰店|专卖店|专营店|企业店/.test(v));
  // Sparse a11y shop: only shop name text like "ARTICLE NO.鞋类旗舰店"
  const sparseShopName = vals.some((v) => /旗舰店|专卖店|专营店/.test(v)) && vals.length <= 8;
  return hasGoodsTab || hasBottomShop || hasSortBar || hasShopHeader || sparseShopName;
}

function guessShopName(nodes) {
  const candidates = (nodes || [])
    .filter((n) => n.bounds && n.bounds.y < 400)
    .map((n) => nodeValue(n))
    .filter((v) =>
      v
      && v.length >= 2
      && v.length <= 40
      && /旗舰店|专卖店|专营店|企业店|工厂店|鞋|服|店$|ARTICLE|NO\./i.test(v)
      && !/搜索|关注|粉丝|验证|综合|销量|休闲/.test(v),
    );
  return candidates.sort((a, b) => b.length - a.length)[0] || '未知店铺';
}

/** Soft dump: never block long on failed a11y (shop pages often sparse). */
async function softDump(device, maxAttempts = 4) {
  return dumpUi(device, { maxAttempts, throwOnFail: false });
}

/** App-level "网络错误" — tap 刷新 if present. */
async function recoverNetworkIfNeeded(device, screen) {
  const dump = await softDump(device, 3);
  const nodes = dump.nodes || [];
  const vals = pageTexts(nodes);
  if (isAccessDeniedUi(nodes)) {
    console.error('[shop] ACCESS DENIED — 操作过于频繁 / 访问被拒绝（需核验身份或等约 12 小时）');
    const known = nodes.find((n) => nodeValue(n) === '知道了' && n.bounds);
    if (known) {
      await device.shell(
        `input tap ${Math.round(known.bounds.x + known.bounds.width / 2)} ${Math.round(known.bounds.y + known.bounds.height / 2)}`,
      );
      await sleep(800);
    }
    throw new AccessDeniedError('Douyin access denied: too frequent operations (try identity verify or wait ~12h).');
  }
  if (!vals.some((v) => /网络错误|当前无网络|请检查后重试/.test(v))) return false;
  console.warn('[shop] network error UI — tap 刷新');
  const refresh = nodes.find((n) => nodeValue(n) === '刷新' && n.bounds);
  if (refresh) {
    await device.shell(
      `input tap ${Math.round(refresh.bounds.x + refresh.bounds.width / 2)} ${Math.round(refresh.bounds.y + refresh.bounds.height / 2)}`,
    );
  } else if (screen) {
    await device.shell(`input tap ${Math.round(screen.width * 0.5)} ${Math.round(screen.height * 0.75)}`);
  }
  await sleep(4000);
  return true;
}

/** ProductDetailActivity often shows skeleton first — wait for bottom chrome / price. */
async function waitForDetailReady(device, screen, maxMs = 20_000) {
  const t0 = Date.now();
  let detailStreakMs = 0;
  let lastTick = t0;
  while (Date.now() - t0 < maxMs) {
    const now = Date.now();
    const comp = await getForegroundComponent(device);
    if (isShopActivity(comp)) return true;
    if (isRiskActivity(comp)) {
      await dismissRiskOverlay(device, screen);
      detailStreakMs = 0;
      lastTick = now;
      continue;
    }
    if (isTransientOverlay(comp)) {
      await dismissTransientOverlays(device, 2);
    }
    // Fast path: dwell on ProductDetailActivity — a11y often empty even when painted
    if (isDetailActivity(comp)) {
      detailStreakMs += now - lastTick;
      if (detailStreakMs >= 5000) {
        console.log('[shop] detail ready via activity dwell (sparse a11y)');
        return true;
      }
    } else {
      detailStreakMs = 0;
    }
    lastTick = now;

    // Cheap dump every other second only
    if (detailStreakMs < 2000 || detailStreakMs > 4500) {
      await recoverNetworkIfNeeded(device, screen);
      const dump = await softDump(device, 2);
      const vals = pageTexts(dump.nodes || []);
      if (vals.some((v) => /网络错误|当前无网络/.test(v))) {
        detailStreakMs = 0;
        await sleep(800);
        continue;
      }
      if (vals.some((v) => /进店|客服|购物袋|现在下单|加购|已售|领券|规格|品牌认证/.test(v))) {
        return true;
      }
      if (isDetailActivity(comp) && vals.join('').length > 60) return true;
    }
    await sleep(800);
  }
  const dump = await softDump(device, 2);
  const vals = pageTexts(dump.nodes || []);
  if (vals.some((v) => /进店|客服|购物袋|已售|加购/.test(v))) return true;
  return isDetailActivity(await getForegroundComponent(device));
}

/**
 * Risk handling — short waits; if a11y empty but activity is detail/shop, treat as clear.
 */
async function handleRiskIfAny(device, screen, { maxWaitMs = 20_000 } = {}) {
  const started = Date.now();
  let waited = false;
  let emptyStreak = 0;
  while (Date.now() - started < maxWaitMs) {
    let comp = await getForegroundComponent(device);

    // Face / captcha: dismiss X (keeps shop underneath); never start face scan
    if (isRiskActivity(comp)) {
      waited = true;
      const shopUnder = await stackHas(device, /ECStoreActivity|store\.arch\.ECStore/);
      console.warn(
        `[shop] risk activity: ${comp.activity?.split('.').pop()} shopUnder=${shopUnder}`,
      );
      await dismissRiskOverlay(device, screen);
      const after = await getForegroundComponent(device);
      if (isShopActivity(after)) return { cleared: true, waited, via: 'risk-dismiss-shop' };
      if (!isRiskActivity(after)) return { cleared: true, waited, via: 'risk-dismissed' };
      continue;
    }

    // Gallery overlays are not risk — leave for classify/dismiss
    if (isTransientOverlay(comp) || isDetailActivity(comp) || isShopActivity(comp)) {
      // still try soft dump for banner dismiss only once
      const dumpOk = await softDump(device, 2);
      if (!dumpOk.failed && dumpOk.nodes?.length && isRiskUi(dumpOk.nodes)) {
        waited = true;
        await device.shell('input keyevent 4');
        await sleep(1000);
        continue;
      }
      return { cleared: true, waited, via: 'activity-ok' };
    }

    const dump = await softDump(device, 3);
    if (dump.failed || !dump.nodes?.length) {
      emptyStreak += 1;
      if (emptyStreak >= 2) return { cleared: true, waited, via: 'empty-giveup' };
      await sleep(600);
      continue;
    }
    emptyStreak = 0;
    const nodes = dump.nodes;
    if (!isRiskUi(nodes)) {
      const dismiss = nodes.find((n) => {
        const v = nodeValue(n);
        return n.bounds && /以后再说|暂不|关闭|我知道了|跳过/.test(v);
      });
      if (dismiss) {
        await device.shell(
          `input tap ${Math.round(dismiss.bounds.x + dismiss.bounds.width / 2)} ${Math.round(dismiss.bounds.y + dismiss.bounds.height / 2)}`,
        );
        await sleep(600);
      }
      return { cleared: true, waited };
    }

    waited = true;
    const cancel = nodes.find((n) => {
      const v = nodeValue(n);
      return n.bounds && /取消|关闭|稍后再说|帮助咨询|反馈/.test(v) && !/开始检测|提交/.test(v);
    });
    if (cancel) {
      console.warn(`[shop] risk UI — tap dismiss: ${nodeValue(cancel)}`);
      await device.shell(
        `input tap ${Math.round(cancel.bounds.x + cancel.bounds.width / 2)} ${Math.round(cancel.bounds.y + cancel.bounds.height / 2)}`,
      );
      await sleep(1200);
    } else {
      console.warn('[shop] risk/captcha detected — Back + wait');
      await device.shell('input keyevent 4').catch(() => {});
      await sleep(3000);
    }
  }
  return { cleared: false, waited };
}

async function classifyPage(device, screen = { width: 900, height: 1600 }) {
  let comp = await getForegroundComponent(device);

  // Captcha/face over shop → close X, then re-read
  if (isRiskActivity(comp)) {
    const shopUnder = await stackHas(device, /ECStoreActivity|store\.arch\.ECStore/);
    console.log(`[shop] risk over UI shopUnder=${shopUnder} — dismiss`);
    await dismissRiskOverlay(device, screen);
    comp = await getForegroundComponent(device);
    if (isShopActivity(comp)) return { kind: 'shop', comp };
    if (isRiskActivity(comp)) return { kind: 'risk', comp };
  }

  // Dismiss full-screen gallery so bottom 进店 chrome is usable
  if (isTransientOverlay(comp)) {
    await dismissTransientOverlays(device, 3);
    comp = await getForegroundComponent(device);
  }

  if (isShopActivity(comp)) return { kind: 'shop', comp };
  if (isDetailActivity(comp)) return { kind: 'detail', comp };

  // Stack fallback (focus may be ambiguous)
  if (await stackHas(device, /ECStoreActivity/)) return { kind: 'shop', comp };
  if (await stackHas(device, /ProductDetailActivity/)) return { kind: 'detail', comp };

  const dump = await softDump(device, 3);
  const nodes = dump.nodes || [];
  if (isRiskUi(nodes)) return { kind: 'risk', comp, nodes };
  if (isInsideShopUi(nodes)) return { kind: 'shop', comp, nodes };
  if (isProductDetailUi(nodes)) return { kind: 'detail', comp, nodes };
  return { kind: 'other', comp, nodes };
}

/** Lightweight: start package only — do NOT navigate home/search (avoids long dump loops). */
async function ensureMallRunning(device) {
  const pid = (await device.shell(`pidof ${PACKAGE_NAME}`).catch(() => '')).toString().trim();
  if (!pid) {
    console.warn('[shop] App process dead — cold starting...');
    await device.shell(`am start -n ${PACKAGE_NAME}/com.ss.android.ugc.aweme.main.MainActivity`);
    await sleep(6000);
  } else {
    // Bring task to front without forcing MainActivity search UX
    await device.shell(`monkey -p ${PACKAGE_NAME} -c android.intent.category.LAUNCHER 1`).catch(async () => {
      await device.shell(`am start -n ${PACKAGE_NAME}/com.ss.android.ugc.aweme.main.MainActivity`);
    });
    await sleep(1200);
  }
  // Dismiss risk overlay if any (short)
  await handleRiskIfAny(device, null, { maxWaitMs: 6_000 });
}

/** True when ProductDetail is empty shell (no 进店/price chrome in a11y). */
function isDetailSkeleton(nodes) {
  const vals = pageTexts(nodes);
  if (vals.some((v) => /进店|客服|购物袋|已售|加购|现在下单|品牌认证|领券/.test(v))) return false;
  // only back / empty / loading
  return vals.length < 8;
}

/**
 * Search mall, prefer shop-card 「进店」 (skips product detail), else open first product.
 */
async function openProductViaSearch(device, screen, searchQuery) {
  const q = String(searchQuery || '').trim().slice(0, 24);
  if (!q || q.length < 2) return { ok: false, landed: 'unknown' };
  console.log(`[shop] open via search: ${JSON.stringify(q)}`);
  await device.shell(`am start -n ${PACKAGE_NAME}/com.ss.android.ugc.aweme.main.MainActivity`);
  await sleep(2500);
  await recoverNetworkIfNeeded(device, screen);
  try {
    await searchGoldenGoose(device, screen, q);
  } catch (e) {
    console.warn(`[shop] search fail: ${e.message}`);
    return { ok: false, landed: 'unknown' };
  }
  await sleep(2000);
  await handleRiskIfAny(device, screen, { maxWaitMs: 12_000 });

  // 1) Prefer shop-header 「进店」 on search results (pink button top-right of shop card)
  const dump0 = await softDump(device, 4);
  const enterShopBtn = (dump0.nodes || []).find((n) => {
    const v = nodeValue(n);
    return n.bounds && /^进店$|进店逛逛/.test(v)
      && n.bounds.y < screen.height * 0.45
      && n.bounds.x > screen.width * 0.55;
  });
  if (enterShopBtn) {
    console.log(`[shop] search: tap shop-card 进店 y=${enterShopBtn.bounds.y}`);
    await device.shell(
      `input tap ${Math.round(enterShopBtn.bounds.x + enterShopBtn.bounds.width / 2)} ${Math.round(enterShopBtn.bounds.y + enterShopBtn.bounds.height / 2)}`,
    );
    await sleep(3500);
    await handleRiskIfAny(device, screen, { maxWaitMs: 15_000 });
    // STRICT: only trust foreground activity (not historical stack)
    let fg = await getForegroundComponent(device);
    if (isShopActivity(fg) && !/ECSearchActivity$/i.test(fg.activity || '')) {
      console.log(`[shop] search 进店 → shop ${fg.activity?.split('.').pop()}`);
      return { ok: true, landed: 'shop', shopName: guessShopName((await softDump(device, 2)).nodes || []) };
    }
    // Coord fallback for pink 进店 (~0.88, 0.18 on 900x1600)
    await device.shell(`input tap ${Math.round(screen.width * 0.88)} ${Math.round(screen.height * 0.18)}`);
    await sleep(3500);
    await handleRiskIfAny(device, screen, { maxWaitMs: 12_000 });
    fg = await getForegroundComponent(device);
    if (isShopActivity(fg) && !/ECSearchActivity$/i.test(fg.activity || '')) {
      return { ok: true, landed: 'shop', shopName: guessShopName((await softDump(device, 2)).nodes || []) };
    }
  } else {
    // No a11y 进店 — try shop-card pink button coords once
    console.log('[shop] search: coord shop-card 进店 0.88,0.18');
    await device.shell(`input tap ${Math.round(screen.width * 0.88)} ${Math.round(screen.height * 0.18)}`);
    await sleep(3500);
    await handleRiskIfAny(device, screen, { maxWaitMs: 12_000 });
    const fg = await getForegroundComponent(device);
    if (isShopActivity(fg) && !/ECSearchActivity$/i.test(fg.activity || '')) {
      return { ok: true, landed: 'shop', shopName: guessShopName((await softDump(device, 2)).nodes || []) };
    }
  }

  // 2) Open first product card → later enterShop
  let candidates = [];
  try {
    candidates = await readVisibleCandidates(device, q);
  } catch {}
  if (!candidates.length) {
    console.log('[shop] search: no a11y cards — grid tap first result');
    await device.shell(`input tap ${Math.round(screen.width * 0.28)} ${Math.round(screen.height * 0.48)}`);
    await sleep(3000);
  } else {
    const card = candidates[0];
    console.log(`[shop] search open card: ${String(card.title || '').slice(0, 40)}`);
    try {
      await openCandidate(device, card);
    } catch {
      await device.shell(
        `input tap ${Math.round(card.tapPoint?.x || screen.width * 0.3)} `
        + `${Math.round(card.tapPoint?.y || screen.height * 0.48)}`,
      );
    }
    await sleep(3000);
  }
  await handleRiskIfAny(device, screen, { maxWaitMs: 12_000 });
  const ready = await waitForDetailReady(device, screen, 14_000);
  const page = await classifyPage(device, screen);
  if (page.kind === 'shop') {
    return { ok: true, landed: 'shop', shopName: guessShopName(page.nodes || []) };
  }
  if (page.kind === 'detail' && ready && !isDetailSkeleton(page.nodes || [])) {
    return { ok: true, landed: 'detail' };
  }
  if (isDetailActivity(page.comp)) {
    const dump = await softDump(device, 2);
    if (!isDetailSkeleton(dump.nodes || [])) return { ok: true, landed: 'detail' };
    return { ok: true, landed: 'detail', weak: true };
  }
  return { ok: false, landed: page.kind };
}

async function openProductInApp(device, screen, productId, productLink = '', productTitle = '') {
  await ensureMallRunning(device);
  await sleep(400);
  await recoverNetworkIfNeeded(device, screen);

  // Prefer search when title available — deeplink often lands blank skeleton on Mall 39.6
  if (productTitle && String(productTitle).trim().length >= 4) {
    const searchQ = String(productTitle)
      .replace(/[【】\[\]+\-·]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2)
      .slice(0, 3)
      .join(' ') || String(productTitle).slice(0, 16);
    const viaSearch = await openProductViaSearch(device, screen, searchQ);
    if (viaSearch.ok && !viaSearch.weak) return viaSearch;
    if (viaSearch.ok) {
      // weak detail still may work for 进店
      console.log('[shop] search open weak — still use for 进店');
      return viaSearch;
    }
  }

  // NOTE: shell treats bare `&` as background — always single-quote the URI.
  // Include promotion_id (same as product_id) — bare product_id often shows blank skeleton.
  const uris = [
    productLink && /^https?:\/\/v\.douyin\.com\//.test(productLink) ? productLink : null,
    `snssdk561124://ec_goods_detail?promotion_id=${productId}&product_id=${productId}&enter_from=copy`,
  ].filter(Boolean);

  for (const uri of uris) {
    console.log(`[shop] open ${uri.slice(0, 80)}...`);
    const q = uri.replace(/'/g, '');
    // Force Mall package for http(s) short links (otherwise Chrome steals intent)
    if (/^https?:\/\//i.test(q)) {
      await device.shell(
        `am start -a android.intent.action.VIEW -d '${q}' -p ${PACKAGE_NAME}`,
      ).catch(async () => {
        await device.shell(`am start -a android.intent.action.VIEW -d '${q}'`).catch(() => {});
      });
    } else {
      // snssdk scheme: do NOT force -p (can fail resolve); package-free works
      await device.shell(`am start -a android.intent.action.VIEW -d '${q}'`).catch(() => {});
    }
    await sleep(4000);
    // If Chrome opened, force back to Mall and try next scheme
    const focus = await getForegroundComponent(device);
    if (/chromium|chrome|browser/i.test(focus.raw || focus.activity || '')) {
      console.warn('[shop] browser stole intent — back to Mall');
      await device.shell(`am start -n ${PACKAGE_NAME}/com.ss.android.ugc.aweme.main.MainActivity`);
      await sleep(2000);
      continue;
    }
    await dismissTransientOverlays(device, 2);

    for (let w = 0; w < 5; w++) {
      await handleRiskIfAny(device, screen, { maxWaitMs: 8_000 });
      await dismissTransientOverlays(device, 2);
      const page = await classifyPage(device);
      console.log(`[shop] page=${page.kind} act=${(page.comp?.activity || '').split('.').pop() || '?'}`);

      if (page.kind === 'shop') {
        const name = guessShopName(page.nodes || []) || '未知店铺';
        console.log(`[shop] landed in shop: ${name}`);
        return { ok: true, landed: 'shop', shopName: name };
      }
      if (page.kind === 'detail') {
        const ready = await waitForDetailReady(device, screen, 12_000);
        const dump = await softDump(device, 2);
        const skeleton = isDetailSkeleton(dump.nodes || []);
        console.log(`[shop] product detail ready=${ready} skeleton=${skeleton}`);
        if (ready && !skeleton) return { ok: true, landed: 'detail' };
        // Blank skeleton: leave detail and try next URI / search (进店 coords will miss)
        console.warn('[shop] detail blank skeleton — abandon this open method');
        await device.shell('input keyevent 4').catch(() => {});
        await sleep(800);
        break;
      }
      if (page.kind === 'risk') {
        await sleep(1200);
        continue;
      }
      await sleep(900);
    }
  }

  // Search fallback when deeplink always skeleton
  if (productTitle || productId) {
    const searchQ = productTitle
      ? String(productTitle).replace(/[【】\[\]+\-·]/g, ' ').split(/\s+/).filter((w) => w.length >= 2).slice(0, 4).join(' ')
      : '';
    // Prefer brand/shop-ish tokens from title; else short product id tail
    const q = searchQ || productTitle?.slice(0, 16) || '';
    if (q) {
      const viaSearch = await openProductViaSearch(device, screen, q);
      if (viaSearch.ok) return viaSearch;
    }
  }

  const page = await classifyPage(device);
  if (page.kind === 'detail' || page.kind === 'shop') {
    return {
      ok: true,
      landed: page.kind,
      weak: page.kind === 'detail',
      shopName: page.kind === 'shop' ? guessShopName(page.nodes || []) : undefined,
    };
  }
  console.warn('[shop] product page signals weak — continue with best effort');
  return { ok: false, landed: 'unknown' };
}

async function enterShop(device, screen) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await handleRiskIfAny(device, screen, { maxWaitMs: 12_000 });
    const page = await classifyPage(device);

    if (page.kind === 'shop') {
      const name = guessShopName(page.nodes || []);
      console.log(`[shop] already inside shop: ${name} act=${(page.comp?.activity || '').split('.').pop()}`);
      return name;
    }

    const nodes = page.nodes || [];

    // 1) a11y 进店 if present
    const enterBtn = nodes.find((n) => {
      const v = nodeValue(n);
      return n.bounds
        && (/进店逛逛|^进店$|进店$/.test(v) || (n.desc && /进店/.test(n.desc)))
        && n.bounds.y > 80;
    });
    if (enterBtn) {
      console.log(`[shop] Entering via a11y 进店 y=${enterBtn.bounds.y}`);
      await device.shell(
        `input tap ${Math.round(enterBtn.bounds.x + enterBtn.bounds.width / 2)} ${Math.round(enterBtn.bounds.y + enterBtn.bounds.height / 2)}`,
      );
      await sleep(3500);
      const after = await classifyPage(device);
      if (after.kind === 'shop') return guessShopName(after.nodes || []);
      continue;
    }

    // 2) Shop name chip mid-page (brand bar)
    const shopNode = nodes.find((n) => {
      const v = nodeValue(n);
      return n.bounds
        && /(?:官方旗舰店|旗舰店|专卖店|专营店|企业店|ARTICLE\s*NO)/i.test(v)
        && n.bounds.y > 60
        && n.bounds.y < screen.height * 0.75;
    });
    if (shopNode && attempt <= 3) {
      console.log(`[shop] tap shop chip: ${nodeValue(shopNode)}`);
      await device.shell(
        `input tap ${Math.round(shopNode.bounds.x + shopNode.bounds.width / 2)} ${Math.round(shopNode.bounds.y + shopNode.bounds.height / 2)}`,
      );
      await sleep(3000);
      const after = await classifyPage(device);
      if (after.kind === 'shop') return nodeValue(shopNode);
    }

    // 3) On product detail: wait for ready, then bottom-left 「进店」
    // Screenshot: 进店 ~ (90, 1540) on 900x1600 → 0.10 / 0.96
    if (page.kind === 'detail' || isDetailActivity(page.comp)) {
      if (attempt === 0) await waitForDetailReady(device, screen, 12_000);
      const pts = [
        { x: 0.10, y: 0.955 },
        { x: 0.11, y: 0.96 },
        { x: 0.14, y: 0.95 },
        { x: 0.08, y: 0.95 },
        { x: 0.20, y: 0.955 },
      ];
      const p = pts[Math.min(attempt, pts.length - 1)];
      console.log(`[shop] detail bottom 进店 coord ${p.x},${p.y}`);
      await device.shell(`input tap ${Math.round(screen.width * p.x)} ${Math.round(screen.height * p.y)}`);
      await sleep(3500);
      // Face/captcha often overlays shop after 进店 — close X keeps ECStore
      for (let r = 0; r < 4; r++) {
        let afterComp = await getForegroundComponent(device);
        if (isRiskActivity(afterComp)) {
          const under = await stackHas(device, /ECStoreActivity/);
          console.log(`[shop] post-进店 risk, shopUnder=${under} dismiss (${r + 1})`);
          await dismissRiskOverlay(device, screen);
          await sleep(800);
          continue;
        }
        break;
      }
      await sleep(600);
      let confirm = await getForegroundComponent(device);
      console.log(`[shop] after 进店 focus=${(confirm.activity || '').split('.').pop()}`);
      // STRICT: only accept real shop activity (not historical stack)
      if (isShopActivity(confirm)) {
        const d = await softDump(device, 2);
        return guessShopName(d.nodes || []);
      }
      // Mid-page brand bar (ARTICLE NO. strip with chevron)
      if (attempt >= 1) {
        console.log('[shop] brand strip tap');
        await device.shell(`input tap ${Math.round(screen.width * 0.45)} ${Math.round(screen.height * 0.72)}`);
        await sleep(3000);
        if (isRiskActivity(await getForegroundComponent(device))) {
          await device.shell('input keyevent 4');
          await sleep(1200);
        }
        confirm = await getForegroundComponent(device);
        if (isShopActivity(confirm)) return guessShopName((await softDump(device, 2)).nodes || []);
      }
      continue;
    }

    // 4) Swipe then brand bar / 进店
    if (attempt <= 2) {
      await device.shell(
        `input swipe ${Math.round(screen.width / 2)} ${Math.round(screen.height * 0.72)} ${Math.round(screen.width / 2)} ${Math.round(screen.height * 0.35)} 320`,
      );
      await sleep(900);
    }

    // 5) Mid brand bar coord (blue strip with shop name on detail)
    if (attempt >= 2) {
      console.log('[shop] brand-bar coord tap');
      await device.shell(`input tap ${Math.round(screen.width * 0.50)} ${Math.round(screen.height * 0.78)}`);
      await sleep(2800);
      const after = await classifyPage(device);
      if (after.kind === 'shop') return guessShopName(after.nodes || []);
    }
  }
  // Accept ECStore even if a11y never says so
  const last = await classifyPage(device);
  if (last.kind === 'shop' || isShopActivity(last.comp)) {
    return guessShopName(last.nodes || []);
  }
  throw new Error(`Could not enter shop (last=${last.kind} act=${last.comp?.activity || ''})`);
}

async function ensureGoodsTab(device, screen) {
  const page = await classifyPage(device);
  const nodes = page.nodes || [];
  // Already on ECStore — default landing is goods grid; avoid blind bottom taps
  // (they can mis-hit and pop back to ProductDetail).
  if (page.kind === 'shop' || isShopActivity(page.comp)) {
    const goodsTab = nodes.find((n) => nodeValue(n) === '商品' && n.bounds && n.bounds.y < 550);
    if (goodsTab) {
      await device.shell(`input tap ${Math.round(goodsTab.bounds.x + goodsTab.bounds.width / 2)} ${Math.round(goodsTab.bounds.y + goodsTab.bounds.height / 2)}`);
      await sleep(1000);
      return;
    }
    const allGoods = nodes.find((n) => /全部商品/.test(nodeValue(n)) && n.bounds);
    if (allGoods) {
      console.log('[shop] tap 全部商品');
      await device.shell(`input tap ${Math.round(allGoods.bounds.x + allGoods.bounds.width / 2)} ${Math.round(allGoods.bounds.y + allGoods.bounds.height / 2)}`);
      await sleep(1200);
    }
    // sparse a11y: stay put — do not coord-tap bottom chrome
    return;
  }
}

/** Wait until shop product grid appears (not blank white body). */
async function waitForShopGrid(device, screen, maxMs = 12_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (!isShopActivity(await getForegroundComponent(device))) {
      await sleep(800);
      continue;
    }
    const dump = await softDump(device, 3);
    const vals = pageTexts(dump.nodes || []);
    // Any product-ish signal
    if (vals.some((v) => /¥|￥|已售|新人价|券后|综合|销量|双列|全部商品/.test(v))) {
      console.log('[shop] shop grid signals present');
      return true;
    }
    // Fixed wait slices — grid may render without a11y
    if (Date.now() - t0 > 4000) {
      console.log('[shop] shop wait elapsed — proceed to grid taps');
      return true;
    }
    await sleep(1000);
  }
  return false;
}

/**
 * In-shop search: clear category prefill (e.g. 休闲鞋), paste keyword via Windows clipboard + KEYCODE_PASTE.
 */
async function searchInsideShop(device, screen, keyword) {
  if (!keyword || !isShopActivity(await getForegroundComponent(device))) return false;
  console.log(`[shop] in-shop search: ${keyword}`);
  const q = String(keyword);
  try {
    const { setWindowsClipboard } = await import('./clipboard.mjs');
    await setWindowsClipboard(q);
  } catch (e) {
    console.warn(`[shop] clipboard seed fail: ${e.message}`);
  }
  const safe = q.replace(/"/g, '\\"');
  await device.shell(`cmd clipboard set --user 0 "${safe}"`).catch(() => {});
  await sleep(300);

  // Search bar ~ top center
  await device.shell(`input tap ${Math.round(screen.width * 0.50)} ${Math.round(screen.height * 0.055)}`);
  await sleep(1000);
  // Clear prefilled 休闲鞋
  await device.shell('input keyevent 123');
  for (let i = 0; i < 24; i++) await device.shell('input keyevent 67');
  await sleep(200);
  // KEYCODE_PASTE = 279
  await device.shell('input keyevent 279');
  await sleep(600);
  // Orange 搜索 button top-right
  await device.shell(`input tap ${Math.round(screen.width * 0.90)} ${Math.round(screen.height * 0.055)}`);
  await sleep(2800);
  return true;
}

// ── Product card extraction ──

function buildGridCards(screen, scrollOffset = 0) {
  // Two-column product grid under shop header + sort bar (900x1600)
  // First product image centers ~ y 0.52–0.58 after 综合/销量 bar
  const cards = [];
  const xs = [0.27, 0.73];
  const y0 = 0.55 + scrollOffset * 0.02;
  const dy = 0.28;
  for (let r = 0; r < 2; r++) {
    for (const xf of xs) {
      cards.push({
        title: `grid-s${scrollOffset}-r${r}-x${xf}`,
        price: '',
        sales: '',
        tapPoint: {
          x: Math.round(screen.width * xf),
          y: Math.round(screen.height * (y0 + r * dy)),
        },
        _grid: true,
      });
    }
  }
  return cards;
}

function extractCards(nodes, screen, { forceGrid = false, scrollIdx = 0 } = {}) {
  const h = screen?.height || 1600;
  const textCount = pageTexts(nodes).length;
  // Mall 39.6 shop pages often expose <10 a11y texts — always use grid
  if (forceGrid || textCount < 12) {
    return screen ? buildGridCards(screen, scrollIdx) : [];
  }

  const cards = [];
  const titleNodes = (nodes || []).filter((n) => {
    if (!n.bounds) return false;
    const v = nodeValue(n);
    if (v.length < 4 || v.length > 200) return false;
    if (n.bounds.y < 300 || n.bounds.y > h - 100) return false;
    if (n.bounds.width < 120 || n.bounds.height > 180) return false;
    return true;
  });
  for (const tn of titleNodes) {
    const title = nodeValue(tn);
    if (/^(GOLDEN|GOOSE|\d+万|现价|已售|退货|顺丰|抖音|关注|粉丝|该商家|券后价|官方正品|包邮|\d+件|首页|商品|分类|上新|客服|购物车|店铺|分享|综合|销量|新品|价格|双列|全部商品|店铺动态|联系客服|新人价|店铺新人)/i.test(title)) continue;
    if (/^¥|^￥|^\d+(\.\d+)?$|满\d+|减\d+|券/.test(title)) continue;
    if (/验证|检测|人脸|拖拽/.test(title)) continue;
    const nearby = nodes.filter((n) => {
      if (!n.bounds) return false;
      return n.bounds.y >= tn.bounds.y - 20 && n.bounds.y <= tn.bounds.y + 300
        && Math.abs(n.bounds.x - tn.bounds.x) < Math.max(tn.bounds.width, 220);
    });
    const priceNode = nearby.find((n) => /券后价|现价|新人价|¥|￥/.test(nodeValue(n)));
    let price = '';
    if (priceNode) {
      const m = nodeValue(priceNode).match(/([\d.]+)/);
      if (m) price = String(Number(m[1]));
    }
    if (!price) {
      const numNear = nearby.find((n) => /^\d+(\.\d+)?$/.test(nodeValue(n)) && Number(nodeValue(n)) > 1);
      if (numNear) price = nodeValue(numNear);
    }
    const salesNode = nearby.find((n) => /已售/.test(nodeValue(n)));
    let sales = '';
    if (salesNode) {
      const m = nodeValue(salesNode).match(/已售(\S+)/);
      if (m) sales = `${m[1]}件`;
    }
    cards.push({ title, price, sales, tapPoint: centerOf(tn) });
  }

  if (cards.length === 0 && screen) return buildGridCards(screen, scrollIdx);

  const seen = new Set();
  return cards.filter((c) => {
    if (seen.has(c.title)) return false;
    seen.add(c.title);
    return true;
  });
}

// ── Share link (39.6.0 compatible) ──

async function getShareLink(device, screen, card) {
  // Tap product card; retry nearby if still on shop
  const pts = [
    card.tapPoint,
    { x: card.tapPoint.x, y: card.tapPoint.y + 40 },
    { x: card.tapPoint.x, y: Math.max(500, card.tapPoint.y - 30) },
  ];
  let opened = false;
  for (const pt of pts) {
    await device.shell(`input tap ${Math.round(pt.x)} ${Math.round(pt.y)}`);
    await sleep(2500);
    await handleRiskIfAny(device, screen, { maxWaitMs: 8_000 });
    for (let i = 0; i < 5; i++) {
      const page = await classifyPage(device);
      if (page.kind === 'detail' || isDetailActivity(page.comp)) {
        opened = true;
        break;
      }
      if (page.kind === 'risk') {
        await handleRiskIfAny(device, screen, { maxWaitMs: 10_000 });
        continue;
      }
      await sleep(700);
    }
    if (opened) break;
  }
  if (!opened) {
    throw new Error(`Tap did not open product detail at ${card.tapPoint.x},${card.tapPoint.y}`);
  }
  await waitForDetailReady(device, screen, 10_000);
  // Must still be on detail after ready wait (captcha X may have closed the product)
  {
    const fg = await getForegroundComponent(device);
    if (!isDetailActivity(fg)) {
      throw new Error(`Lost product detail after open (now ${fg.activity?.split('.').pop() || '?'})`);
    }
  }

  const dump = await softDump(device, 4);
  const nodes = dump.nodes || [];
  if (findAccessDenied(nodes)) throw new AccessDeniedError();
  if (isAccessDeniedUi(nodes)) throw new AccessDeniedError();

  // Share: top-right icons on detail — 分享 is often 3rd icon ~0.82–0.88 x, y~0.05
  const shareNode = nodes.find((n) => /分享/.test(nodeValue(n)) && n.bounds && n.bounds.y < 220);
  const sharePts = shareNode
    ? [centerOf(shareNode)]
    : [
        { x: Math.round(screen.width * 0.82), y: Math.round(screen.height * 0.055) },
        { x: Math.round(screen.width * 0.88), y: Math.round(screen.height * 0.055) },
        { x: Math.round(screen.width * 0.76), y: Math.round(screen.height * 0.055) },
      ];
  console.log(`[shop] share tap ${sharePts[0].x},${sharePts[0].y}`);
  await device.shell(`input tap ${sharePts[0].x} ${sharePts[0].y}`);
  await sleep(1800);

  const previousUrl = await readCurrentDouyinShareUrl();

  for (let panelAttempt = 0; panelAttempt < 12; panelAttempt++) {
    const fg = await getForegroundComponent(device);
    if (isRiskActivity(fg)) {
      console.warn('[captcha] on share — dismiss/back');
      await dismissRiskOverlay(device, screen);
      throw new Error('Share blocked by captcha');
    }
    // If we fell out of detail without panel, fail fast
    if (!isDetailActivity(fg) && panelAttempt >= 2) {
      throw new Error(`Share panel lost (now ${fg.activity?.split('.').pop() || '?'})`);
    }
    const d = await softDump(device, 2);
    const pn = d.nodes || [];
    if (isAccessDeniedUi(pn)) throw new AccessDeniedError();
    if (isRiskUi(pn)) {
      console.warn('[captcha] on share UI — back out');
      await device.shell('input keyevent 4').catch(() => {});
      throw new Error('Share blocked by captcha');
    }
    const copyLink = pn.find((n) => /复制链接|复制口令/.test(nodeValue(n)) && n.bounds);
    if (copyLink) {
      await device.shell(`input tap ${Math.round(copyLink.bounds.x + copyLink.bounds.width / 2)} ${Math.round(copyLink.bounds.y + copyLink.bounds.height / 2)}`);
      return waitForDouyinShareUrl({ previousUrl });
    }
    // Share panel coords: 复制链接 often bottom row
    if (panelAttempt === 6) {
      await device.shell(`input tap ${Math.round(screen.width * 0.72)} ${Math.round(screen.height * 0.88)}`);
    }
    if (panelAttempt === 8) {
      await device.shell(`input tap ${Math.round(screen.width * 0.50)} ${Math.round(screen.height * 0.88)}`);
    }
    await sleep(400);
  }
  throw new Error('Share panel: no 复制链接');
}

/** Pull product_id / promotion_id from current ProductDetail intent extras. */
async function productIdFromDetailActivity(device) {
  try {
    const out = (await device.shell('dumpsys activity activities')).toString();
    const m =
      out.match(/product_id[=:](\d{10,})/i)
      || out.match(/promotion_id[=:](\d{10,})/i)
      || out.match(/"product_id"\s*[=:]\s*"?(\d{10,})/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** When share is blocked, harvest title/price/sales from detail a11y. */
function extractDetailFromUi(nodes, shopName, cardData) {
  const vals = pageTexts(nodes);
  let title = '';
  for (const v of vals) {
    if (v.length < 10 || v.length > 120) continue;
    if (/^(ARTICLE|NO\.|EST\.|品牌|旗舰|客服|购物|加购|已售|入会|退货|抖音|官方|正品)/i.test(v)) continue;
    if (/¥|￥|^\d+$|已售|券|包邮|旗舰店/.test(v)) continue;
    if (/鞋|靴|款|鞋面|设计师|复古|厚底|帆布|板鞋|脏脏/.test(v) || v.length >= 14) {
      title = v;
      break;
    }
  }
  if (!title) {
    const long = vals.filter((v) => v.length >= 12 && v.length <= 100 && !/¥|已售|客服|加购/.test(v))
      .sort((a, b) => b.length - a.length)[0];
    title = long || cardData.title || '';
  }
  let price = cardData.price || '';
  for (const v of vals) {
    const m = v.match(/[¥￥]\s*([\d.]+)/) || v.match(/^([\d.]+)$/);
    if (m && Number(m[1]) > 10) {
      price = String(Number(m[1]));
      break;
    }
  }
  let sales = cardData.sales || '';
  for (const v of vals) {
    const m = v.match(/已售(\S+)/);
    if (m) {
      sales = `${m[1]}件`;
      break;
    }
  }
  return {
    商品id: '',
    商品品名: title,
    店铺名: shopName || '',
    价格: price,
    销量: sales,
    分享的链接: '',
    _source: 'detail-ui',
  };
}

// ── Parse product data directly from URL (no browser enrich) ──

function parseFromUrl(urlString, shopName, cardData) {
  try {
    const decoded = decodeURIComponent(urlString);
    const url = new URL(decoded);
    const goodsRaw = url.searchParams.get('goods_detail');
    if (goodsRaw) {
      const goods = JSON.parse(decodeURIComponent(goodsRaw));
      const productId = url.searchParams.get('id') || url.searchParams.get('product_id') || '';
      const min = Number(goods.min_price) / 100;
      const max = Number(goods.max_price) / 100;
      let price = '';
      if (Number.isFinite(min) && Number.isFinite(max) && min !== max) price = min + '-' + max;
      else if (Number.isFinite(min)) price = String(min);
      return {
        商品id: productId,
        商品品名: String(goods.title || cardData.title).trim(),
        店铺名: shopName || '',
        价格: price || cardData.price || '',
        销量: Number.isFinite(Number(goods.sales)) ? Number(goods.sales) + '件' : cardData.sales || '',
        分享的链接: urlString,
      };
    }
  } catch {}
  // Fallback: use card data
  return {
    商品id: '',
    商品品名: cardData.title,
    店铺名: shopName,
    价格: cardData.price || '',
    销量: cardData.sales || '',
    分享的链接: urlString || '',
  };
}

// ── Main ──

export async function crawlShop(config) {
  const {
    productLink,
    productId: productIdArg = '',
    productTitle: productTitleArg = '',
    serial = 'emulator-5554',
    keyword = '',
    outputPath,
    checkpointPath,
    summaryPath,
    fresh,
    maxScrolls = 50,
    maxProducts = Number.POSITIVE_INFINITY,
  } = config;
  const startedAt = new Date().toISOString();
  const products = fresh ? [] : await loadCheckpoint(checkpointPath);
  const errors = [];
  const seenTitles = new Set(products.map((p) => p.商品品名));
  const productKeys = new Set(products.map(productIdentityKey));

  const androidDevices = await android.devices({ host: '127.0.0.1', port: 5037 });
  const device = androidDevices.find((c) => c.serial() === serial);
  if (!device) throw new Error(`Device ${serial} not found`);

  try {
    const screen = await getScreenSize(device);

    // Prefer explicit productId (path B seeds); else parse URL; else resolve v.douyin via browser
    let productId = String(productIdArg || '').trim();
    if (!productId) {
      try {
        const u = new URL(productLink);
        productId = u.searchParams.get('id') || u.searchParams.get('product_id') || '';
      } catch {}
    }
    if (!productId && productLink && /v\.douyin\.com/.test(productLink)) {
      console.log('[shop] resolving short link for product_id...');
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ channel: 'msedge', headless: true });
      try {
        const page = await (await browser.newContext({ viewport: { width: 430, height: 932 } })).newPage();
        await page.goto(productLink, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.locator('body').waitFor({ state: 'visible', timeout: 10_000 });
        const url = new URL(page.url());
        productId = url.searchParams.get('id') || url.searchParams.get('product_id') || '';
      } finally { await browser.close().catch(() => {}); }
    }
    if (!productId) throw new Error('Could not extract product_id from link');
    console.log(`[shop] product_id=${productId}`);

    console.log('[shop] Opening product...');
    const opened = await openProductInApp(
      device,
      screen,
      productId,
      productLink,
      productTitleArg || '',
    );
    let shopName = opened.shopName || '';
    if (opened.landed !== 'shop') {
      console.log('[shop] Entering shop...');
      shopName = await enterShop(device, screen);
    } else {
      console.log(`[shop] Skip enter — already in shop: ${shopName}`);
    }
    await ensureGoodsTab(device, screen);
    await handleRiskIfAny(device, screen, { maxWaitMs: 12_000 });
    // Shop grid often blank for a few seconds after ECStore opens
    await waitForShopGrid(device, screen, 12_000);
    // In-shop search (Chinese paste) is flaky and often lands on empty ECShopSearch —
    // skip by default; enable with config.searchInShop=true when clipboard paste is solid.
    if (keyword && config.searchInShop) {
      await searchInsideShop(device, screen, keyword).catch((e) => {
        console.warn(`[shop] in-shop search soft-fail: ${e.message}`);
      });
    }

    // Scroll and collect cards (grid-first: shop a11y is usually empty)
    console.log('[shop] Scanning products...');
    const allCards = [];
    const seenCardTitles = new Set();
    let sparseA11y = false;
    for (let scrollIdx = 0; scrollIdx < maxScrolls; scrollIdx++) {
      await handleRiskIfAny(device, screen, { maxWaitMs: 8_000 });
      const page = await classifyPage(device);
      if (page.kind === 'risk') {
        console.warn(`[shop] Scroll ${scrollIdx + 1}: risk UI`);
        await sleep(1500);
        continue;
      }
      if (page.kind !== 'shop' && !isShopActivity(page.comp) && scrollIdx === 0) {
        console.warn(`[shop] not on shop page (kind=${page.kind}) — still try grid`);
      }
      const nodes = page.nodes || [];
      if (pageTexts(nodes).length < 12) sparseA11y = true;
      const cards = extractCards(nodes, screen, { forceGrid: sparseA11y, scrollIdx });
      let newCards = 0;
      for (const card of cards) {
        if (!seenCardTitles.has(card.title)) {
          seenCardTitles.add(card.title);
          allCards.push(card);
          newCards++;
        }
      }
      console.log(
        `[shop] Scroll ${scrollIdx + 1}: +${newCards} total=${allCards.length} `
        + `nodes=${nodes.length} texts=${pageTexts(nodes).length} grid=${cards.every((c) => c._grid)}`,
      );
      const realTotal = allCards.filter((c) => !c._grid).length;
      // With grid mode: collect 2–3 scroll pages of taps then process
      if (sparseA11y && scrollIdx >= Math.min(2, maxScrolls - 1)) {
        console.log('[shop] grid pages collected');
        break;
      }
      if (!sparseA11y && newCards === 0 && scrollIdx >= 3 && realTotal > 0) {
        console.log('[shop] Done scanning.');
        break;
      }
      await device.shell(
        `input swipe ${Math.round(screen.width / 2)} ${Math.round(screen.height * 0.80)} `
        + `${Math.round(screen.width / 2)} ${Math.round(screen.height * 0.30)} 400`,
      );
      await sleep(1100);
    }
    console.log(`[shop] Total cards: ${allCards.length} (sparseA11y=${sparseA11y})`);

    // Filter by keyword (grid cards always pass — filter after open/enrich by title)
    const kw = String(keyword || '').toLowerCase();
    const matching = kw
      ? allCards.filter((c) => {
          if (c._grid) return true;
          const t = c.title.toLowerCase();
          if (t.includes(kw)) return true;
          if (kw === 'ggdb' && (t.includes('goldengoose') || t.includes('golden goose') || t.includes('脏脏鞋'))) return true;
          // 小脏鞋: exact + generic 脏脏鞋 excluding GG brand
          if ((kw === '小脏鞋' || keyword === '\u5c0f\u810f\u978b') && (t.includes('小脏鞋') || t.includes('\u5c0f\u810f\u978b'))) return true;
          if ((kw === '小脏鞋' || keyword === '\u5c0f\u810f\u978b') && t.includes('脏脏鞋') && !/golden\s*goose|goldengoose|\bggdb\b/i.test(t)) return true;
          return false;
        })
      : allCards;
    console.log(`[shop] Matching '${keyword}': ${matching.length}/${allCards.length}`);

    // Process matching cards (cap for smoke / rate-limit friendliness)
    let newCards = matching.filter((c) => !seenTitles.has(c.title));
    if (Number.isFinite(maxProducts) && maxProducts > 0) {
      newCards = newCards.slice(0, maxProducts);
    }
    console.log(`[shop] Processing ${newCards.length} new products (cap=${maxProducts})...`);

    for (let i = 0; i < newCards.length; i++) {
      if (products.length >= maxProducts) break;
      const card = newCards[i];
      try {
        // Health check: stop processing if app crashed
        const { isAppAlive } = await import('./app-health.mjs');
        if (!(await isAppAlive(device))) {
          console.error('[shop] App crashed during card processing — stopping');
          break;
        }

        // Prefer stay on shop; if on mall search results still allow grid opens
        const fgNow = await getForegroundComponent(device);
        if (
          !isShopActivity(fgNow)
          && !isDetailActivity(fgNow)
          && !/ECSearchActivity|search\.common/i.test(fgNow.activity || '')
        ) {
          console.warn(`[shop] left commerce UI (${fgNow.activity?.split('.').pop()}) — stop processing`);
          break;
        }
        console.log(`[${i + 1}/${newCards.length}] ${card.title.slice(0, 50)}...`);
        let product;
        try {
          const share = await getShareLink(device, screen, card);
          const url = extractShareUrl(share.url) || share.url;
          product = parseFromUrl(url, shopName, card);
        } catch (shareErr) {
          // Captcha often blocks 复制链接 — harvest detail UI + product_id instead
          console.warn(`  share-fail: ${String(shareErr.message || shareErr).slice(0, 60)}`);
          const fg = await getForegroundComponent(device);
          if (!isDetailActivity(fg)) {
            // try open again briefly
            await device.shell(`input tap ${Math.round(card.tapPoint.x)} ${Math.round(card.tapPoint.y)}`);
            await sleep(2500);
          }
          if (isDetailActivity(await getForegroundComponent(device))) {
            await waitForDetailReady(device, screen, 8_000);
            const dump = await softDump(device, 3);
            product = extractDetailFromUi(dump.nodes || [], shopName, card);
            const pid = await productIdFromDetailActivity(device);
            if (pid) {
              product.商品id = pid;
              product.分享的链接 = `https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=${pid}&origin_type=open_url`;
            }
            console.log(`  detail-fallback: ${String(product.商品品名).slice(0, 36)} | ${product.价格}`);
          } else {
            throw shareErr;
          }
        }
        if (!product.商品品名 || product.商品品名.startsWith('grid-')) {
          if (!product.商品品名 || product.商品品名.startsWith('grid-')) product.商品品名 = card.title;
        }

        // Keyword gate after enrich (important for grid opens)
        // Note: shop seed crawl may collect all in-shop goods; filter loosely for 小脏鞋
        if (kw) {
          const t = String(product.商品品名 || '').toLowerCase();
          const ok =
            t.includes(kw)
            || t.startsWith('grid-') // keep grid until we have real title (already handled above)
            || (kw === 'ggdb' && (t.includes('goldengoose') || t.includes('脏脏鞋') || t.includes('article')))
            || ((kw === '小脏鞋' || keyword === '\u5c0f\u810f\u978b')
              && (t.includes('小脏鞋') || t.includes('\u5c0f\u810f\u978b')
                || t.includes('脏脏鞋')
                || t.includes('article') // brand shops often omit keyword in title
                || (product._source === 'detail-ui' && !/golden\s*goose|goldengoose|\bggdb\b/i.test(t))));
          if (!ok) {
            console.log(`  skip-kw ${String(product.商品品名).slice(0, 36)}`);
            await device.shell('input keyevent 4');
            await sleep(1200);
            await ensureGoodsTab(device, screen);
            continue;
          }
        }

        const key = productIdentityKey(product);
        if (!productKeys.has(key)) {
          products.push(product);
          productKeys.add(key);
          seenTitles.add(card.title);
          console.log(`  -> ${product.商品品名.slice(0,40)} | ${product.价格} | ${product.销量}`);
          await writeArtifacts({ products, outputPath, checkpointPath, summaryPath,
            summary: { query: 'shop-' + keyword, requested: newCards.length, collected: products.length,
              completed: false, startedAt, updatedAt: new Date().toISOString(), errors } });
        }

        await device.shell('input keyevent 4');
        await sleep(1500);
        await ensureGoodsTab(device, screen);
      } catch (error) {
        errors.push({ title: card.title, message: error.message, at: new Date().toISOString() });
        console.warn(`  x ${error.message.slice(0,80)}`);
        await device.shell('input keyevent 4').catch(() => {});
        await sleep(1000);
      }
    }

    const completed = true;
    await writeArtifacts({ products, outputPath, checkpointPath, summaryPath,
      summary: { query: 'shop-' + keyword, requested: newCards.length, collected: products.length,
        completed, startedAt, updatedAt: new Date().toISOString(), errors } });
    return { products, errors, completed };
  } finally {
    await Promise.allSettled(androidDevices.map((c) => c.close()));
  }
}
