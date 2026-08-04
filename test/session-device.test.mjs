import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeSession, saveSession, loadSession, sessionRequestHeaders } from '../src/session.mjs';
import { mapDeviceCandidates, resolveDeviceParams, saveDeviceParams } from '../src/device-params.mjs';
import { createNativeSignClient } from '../src/native-sign.mjs';

test('normalizeSession merges cookie header into map', () => {
  const s = normalizeSession({
    cookie_header: 'a=1; b=2',
    cookies: { c: '3' },
  });
  assert.equal(s.cookies.a, '1');
  assert.equal(s.cookies.b, '2');
  assert.equal(s.cookies.c, '3');
  assert.match(s.cookie_header, /a=1/);
});

test('session round-trip on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
  const file = path.join(dir, 'session.json');
  saveSession({ cookie_header: 'sid=xyz', cookies: { sid: 'xyz' } }, file);
  const loaded = loadSession(file);
  assert.equal(loaded.cookies.sid, 'xyz');
  assert.equal(sessionRequestHeaders(loaded).Cookie, loaded.cookie_header);
});

test('mapDeviceCandidates maps common pref keys', () => {
  const mapped = mapDeviceCandidates({
    device_id: '111',
    install_id: '222',
    cdid: 'ccc',
    klink_egdi: 'kkk',
  });
  assert.equal(mapped.device_id, '111');
  assert.equal(mapped.iid, '222');
  assert.equal(mapped.cdid, 'ccc');
  assert.equal(mapped.klink_egdi, 'kkk');
});

test('resolveDeviceParams falls back when no files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-'));
  const r = resolveDeviceParams({
    deviceParamsPath: path.join(dir, 'missing.json'),
    session: null,
  });
  assert.equal(r.usedFallback, true);
  assert.ok(r.staticParams.aid);
  assert.ok(r.sessionParams.cdid);
});

test('saveDeviceParams then resolve prefers file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev2-'));
  const file = path.join(dir, 'device-params.json');
  saveDeviceParams({
    source: 'test',
    static: { device_id: '999' },
    session: { cdid: 'live-cdid' },
  }, file);
  const r = resolveDeviceParams({ deviceParamsPath: file });
  assert.equal(r.usedFallback, false);
  assert.equal(r.staticParams.device_id, '999');
  assert.equal(r.sessionParams.cdid, 'live-cdid');
});

test('native-sign client health fails closed when offline', async () => {
  const client = createNativeSignClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
  const h = await client.health();
  assert.equal(h.ok, false);
});
