import test from 'node:test';
import assert from 'node:assert/strict';
import { findAccessDenied } from '../src/android.mjs';
import { cleanUiText, findProductCandidates, parseUiNodes } from '../src/ui.mjs';

test('cleans zero-width accessibility text', () => {
  assert.equal(cleanUiText('I\u200bG\u200bo\u200bl\u200bd\u200be\u200bn\u200b \u200bG\u200bo\u200bo\u200bs\u200be男女鞋'), 'Golden Goose男女鞋');
});

test('detects Douyin operation-frequency access denial', () => {
  const nodes = parseUiNodes(`<hierarchy>
    <node text="您的访问被拒绝" content-desc="" bounds="[100,600][800,700]" />
    <node text="操作过于频繁，请稍后再试" content-desc="" bounds="[100,700][800,760]" />
  </hierarchy>`);

  assert.ok(findAccessDenied(nodes));
});

test('finds Golden Goose product cards and skips live cards', () => {
  const xml = `<hierarchy>
    <node text="直播中" content-desc="" bounds="[10,400][100,430]" />
    <node text="" content-desc="Golden Goose男女Super Star脏脏鞋GGDB" bounds="[10,800][430,840]" />
    <node text="" content-desc="Golden Goose男女True Star双鞋带薄底脏脏鞋GGDB" bounds="[460,800][880,840]" />
  </hierarchy>`;
  const candidates = findProductCandidates(parseUiNodes(xml));
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].isLive, true);
  assert.equal(candidates[1].isLive, false);
  assert.deepEqual(candidates[1].tapPoint, { x: 670, y: 580 });
});
