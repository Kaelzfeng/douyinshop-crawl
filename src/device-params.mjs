/**
 * Device / app common query params for Douyin Mall search API.
 * Prefer values exported from the live app over committed fixtures.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_DEVICE_PARAMS_PATH = 'output/device-params.json';

/** Fallback snapshot (legacy capture). Prefer live export. */
export const FALLBACK_STATIC_PARAMS = {
  iid: '3454002414781424',
  device_id: '3700291608266259',
  ac: 'wifi',
  channel: 'huawei_561124_64',
  aid: '561124',
  app_name: 'douyinecommerce',
  version_code: '390600',
  version_name: '39.6.0',
  device_platform: 'android',
  os: 'android',
  ssmix: 'a',
  device_type: 'MI 5s',
  device_brand: 'Xiaomi',
  language: 'zh',
  os_api: '35',
  os_version: '15',
  manifest_version_code: '390601',
  resolution: '900*1600',
  dpi: '240',
  update_version_code: '39609900',
  package: 'com.ss.android.ugc.livelite',
  mcc_mnc: '46000',
  first_launch_timestamp: '1784347027',
  last_deeplink_update_version_code: '39609900',
  cpu_support64: 'true',
  host_abi: 'arm64-v8a',
  is_guest_mode: '0',
  app_type: 'normal',
  minor_status: '0',
  appTheme: 'light',
  is_preinstall: '0',
  need_personal_recommend: '1',
  is_android_pad: '0',
  is_android_fold: '0',
};

export const FALLBACK_SESSION_PARAMS = {
  cdid: '1921388f-1cdc-4639-b4da-7cccbfe0dcae',
  klink_egdi: 'AAKnjetLF-f7tX5bmBTodVF8RbvQmjJ-iCJck8FNYiUF3JqrpadUdDrm',
};

/**
 * Map messy SharedPreferences keys onto search query param names.
 * @param {Record<string, string>} candidates
 */
export function mapDeviceCandidates(candidates = {}) {
  const out = {};
  for (const [rawKey, rawVal] of Object.entries(candidates)) {
    const k = String(rawKey).toLowerCase();
    const v = String(rawVal ?? '').trim();
    if (!v) continue;
    if (k === 'device_id' || k === 'deviceid' || k.endsWith('_device_id')) out.device_id = v;
    else if (k === 'iid' || k === 'install_id' || k.includes('install_id')) out.iid = v;
    else if (k === 'cdid' || k.includes('clientudid') || k === 'client_udid') out.cdid = v;
    else if (k.includes('klink') || k.includes('egdi')) out.klink_egdi = v;
    else if (k.includes('openudid')) out.openudid = v;
  }
  return out;
}

export function loadDeviceParams(filePath = DEFAULT_DEVICE_PARAMS_PATH) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return null;
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

export function saveDeviceParams(params, filePath = DEFAULT_DEVICE_PARAMS_PATH) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const payload = {
    exported_at: params.exported_at || Date.now(),
    static: { ...FALLBACK_STATIC_PARAMS, ...(params.static || params) },
    session: { ...FALLBACK_SESSION_PARAMS, ...(params.session || {}) },
    source: params.source || 'manual',
  };
  // Keep session-ish keys out of static if nested properly
  if (params.static || params.session) {
    payload.static = { ...FALLBACK_STATIC_PARAMS, ...(params.static || {}) };
    payload.session = { ...FALLBACK_SESSION_PARAMS, ...(params.session || {}) };
  }
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}

/**
 * Resolve static + session params for URL building.
 * @param {object} [opts]
 * @param {string} [opts.deviceParamsPath]
 * @param {object|null} [opts.session] — may carry device_candidates
 * @param {object} [opts.overrides]
 */
export function resolveDeviceParams({
  deviceParamsPath = DEFAULT_DEVICE_PARAMS_PATH,
  session = null,
  overrides = {},
} = {}) {
  const fromFile = loadDeviceParams(deviceParamsPath);
  const fromSession = mapDeviceCandidates(session?.device_candidates || {});

  const staticParams = {
    ...FALLBACK_STATIC_PARAMS,
    ...(fromFile?.static || {}),
    ...fromSession,
    ...(overrides.static || {}),
  };

  const sessionParams = {
    ...FALLBACK_SESSION_PARAMS,
    ...(fromFile?.session || {}),
    ...(fromSession.cdid ? { cdid: fromSession.cdid } : {}),
    ...(fromSession.klink_egdi ? { klink_egdi: fromSession.klink_egdi } : {}),
    ...(overrides.session || {}),
  };

  // device_id / iid belong in static query string
  if (fromSession.device_id) staticParams.device_id = fromSession.device_id;
  if (fromSession.iid) staticParams.iid = fromSession.iid;

  const usedFallback = !fromFile && !Object.keys(fromSession).length;
  return {
    staticParams,
    sessionParams,
    usedFallback,
    source: fromFile?.source || (Object.keys(fromSession).length ? 'session_export' : 'fallback_fixture'),
  };
}
