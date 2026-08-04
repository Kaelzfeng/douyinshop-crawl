/**
 * Session store for pure/L2 HTTP crawls.
 * Holds cookies and tokens exported from the live app (or loaded from disk).
 * Never commit real session files to git.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SESSION_PATH = 'output/session.json';

/**
 * @param {object} raw
 * @returns {object}
 */
export function normalizeSession(raw = {}) {
  const cookies = { ...(raw.cookies || {}) };
  let cookieHeader = String(raw.cookie_header || raw.cookie || '').trim();

  if (!cookieHeader && Object.keys(cookies).length) {
    cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  // Merge cookie header into map when possible
  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k && cookies[k] === undefined) cookies[k] = v;
    }
  }

  return {
    exported_at: raw.exported_at || raw.exportedAt || null,
    package: raw.package || 'com.ss.android.ugc.livelite',
    cookie_header: cookieHeader,
    cookies,
    tokens: {
      msToken: raw.tokens?.msToken || raw.msToken || cookies.msToken || '',
      verifyFp: raw.tokens?.verifyFp || raw.verifyFp || process.env.DOUYIN_VERIFY_FP || '',
      xTtToken: raw.tokens?.xTtToken || raw['x-tt-token'] || cookies['x-tt-token'] || '',
      ...((raw.tokens && typeof raw.tokens === 'object') ? raw.tokens : {}),
    },
    device_candidates: raw.device_candidates || {},
    raw,
  };
}

export function loadSession(filePath = DEFAULT_SESSION_PATH) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return null;
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  return normalizeSession(raw);
}

export function saveSession(session, filePath = DEFAULT_SESSION_PATH) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const normalized = normalizeSession(session);
  const payload = {
    exported_at: normalized.exported_at || Date.now(),
    package: normalized.package,
    cookie_header: normalized.cookie_header,
    cookies: normalized.cookies,
    tokens: normalized.tokens,
    device_candidates: normalized.device_candidates,
  };
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}

/**
 * Build request headers from session for Node-side fetch.
 * @param {object|null} session
 * @param {object} [extra]
 */
export function sessionRequestHeaders(session, extra = {}) {
  const headers = { ...extra };
  if (!session) return headers;
  if (session.cookie_header) headers.Cookie = session.cookie_header;
  if (session.tokens?.xTtToken) headers['x-tt-token'] = session.tokens.xTtToken;
  return headers;
}

export function sessionAgeMs(session) {
  if (!session?.exported_at) return null;
  return Date.now() - Number(session.exported_at);
}
