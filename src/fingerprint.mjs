/**
 * Randomized browser fingerprint generation for anti-detection.
 * Each call to generateFingerprint() returns a coherent fingerprint
 * that mimics a real Android Chrome mobile browser.
 */

const UA_POOL = [
  // Samsung Galaxy S24 Ultra — Chrome 135
  'Mozilla/5.0 (Linux; Android 15; SM-S9280) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.7049.121 Mobile Safari/537.36',
  // Samsung Galaxy S23 — Chrome 134
  'Mozilla/5.0 (Linux; Android 14; SM-S9180) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.135 Mobile Safari/537.36',
  // Xiaomi 14 Ultra — Chrome 135
  'Mozilla/5.0 (Linux; Android 15; 24030PN60C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.7049.121 Mobile Safari/537.36',
  // Xiaomi 13 — Chrome 133
  'Mozilla/5.0 (Linux; Android 14; 2211133C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.137 Mobile Safari/537.36',
  // Huawei P60 Pro — Chrome 134
  'Mozilla/5.0 (Linux; Android 14; ALN-AL80) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.108 Mobile Safari/537.36',
  // OPPO Find X7 — Chrome 135
  'Mozilla/5.0 (Linux; Android 15; PHY110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.7049.121 Mobile Safari/537.36',
  // vivo X100 Pro — Chrome 134
  'Mozilla/5.0 (Linux; Android 14; V2324A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.135 Mobile Safari/537.36',
  // OnePlus 12 — Chrome 135
  'Mozilla/5.0 (Linux; Android 15; PJD110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.7049.95 Mobile Safari/537.36',
  // Google Pixel 8 Pro — Chrome 135
  'Mozilla/5.0 (Linux; Android 15; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.7049.121 Mobile Safari/537.36',
  // Google Pixel 9 — Chrome 136
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.49 Mobile Safari/537.36',
  // Realme GT5 Pro — Chrome 133
  'Mozilla/5.0 (Linux; Android 14; RMX3888) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6943.137 Mobile Safari/537.36',
  // Honor Magic6 Pro — Chrome 134
  'Mozilla/5.0 (Linux; Android 14; BVL-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.108 Mobile Safari/537.36',
];

const VIEWPORT_PRESETS = [
  { width: 412, height: 915 },   // Pixel 9 / many Androids
  { width: 430, height: 932 },   // iPhone-alike (common Douyin rendering)
  { width: 393, height: 851 },   // Pixel 8 Pro
  { width: 412, height: 892 },   // Samsung S24
  { width: 390, height: 844 },   // Common compact
  { width: 428, height: 926 },   // Common tall
];

const PLATFORMS = ['Linux armv8l', 'Linux aarch64'];

/**
 * Returns a random element from an array.
 */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Returns a random integer in [min, max].
 */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generates a fresh, self-consistent browser fingerprint.
 * Designed to bypass Douyin's bot-detection heuristics.
 *
 * @returns {object} fingerprint with userAgent, viewport, and device properties
 */
export function generateFingerprint() {
  const userAgent = pick(UA_POOL);
  const viewport = { ...pick(VIEWPORT_PRESETS) };
  const deviceScaleFactor = pick([2.75, 3, 3.25, 3.5]);
  const hardwareConcurrency = randInt(4, 8);
  const deviceMemory = randInt(4, 8);

  return {
    userAgent,
    viewport,
    deviceScaleFactor,
    hasTouch: true,
    isMobile: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    hardwareConcurrency,
    deviceMemory,
    platform: pick(PLATFORMS),
  };
}

export { UA_POOL, VIEWPORT_PRESETS };
