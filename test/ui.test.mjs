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
    <node text="¥4400 已售776件" content-desc="" bounds="[10,850][430,890]" />
    <node text="" content-desc="Golden Goose男女True Star双鞋带薄底脏脏鞋GGDB" bounds="[460,800][880,840]" />
    <node text="¥3500 已售31件" content-desc="" bounds="[460,850][880,890]" />
  </hierarchy>`;
  const candidates = findProductCandidates(parseUiNodes(xml));
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].isLive, true);
  assert.equal(candidates[1].isLive, false);
  assert.deepEqual(candidates[1].tapPoint, { x: 670, y: 580 });
});

test('finds ggdb and 小脏鞋 search result product cards with keyword precision', () => {
  const xml = `<hierarchy>
    <node text="" content-desc="95新 GOLDEN GOOSE 36码 ggdb黑白星星板鞋 休闲鞋" bounds="[10,800][430,850]" />
    <node text="¥1200 已售8件" content-desc="" bounds="[10,850][430,890]" />
    <node text="" content-desc="女款小脏鞋厚底休闲板鞋" bounds="[460,800][880,850]" />
    <node text="¥498 已售35件" content-desc="" bounds="[460,850][880,890]" />
  </hierarchy>`;

  // ggdb query matches only the ggdb card via compact keyword match + isGoldenGooseTitle
  assert.equal(findProductCandidates(parseUiNodes(xml), 'ggdb').length, 1);
  // 小脏鞋 query matches both: card1 via isGoldenGooseTitle, card2 via 小脏鞋 keyword + price match
  assert.equal(findProductCandidates(parseUiNodes(xml), '小脏鞋').length, 2);
  // Without query, both match via Golden Goose + 小脏鞋 signals
  assert.equal(findProductCandidates(parseUiNodes(xml)).length, 2);
});
