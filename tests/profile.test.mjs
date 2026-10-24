import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProfile, updateProfile} from '../src/profile.mjs';

const manual = '# 阅读画像\r\n\r\n手动备注：中文哨兵 — 我的实验问题不能被覆盖。\r\n- 身份：研究生\r\n- 研究方向：肠道菌群\r\n- 感兴趣的主题：NAD+，烟酰胺、PncA\r\n\r\n';
const original = manual + '<!-- readerd:auto:start -->\r\n## 最近阅读记录\r\n\r\n暂无记录。\r\n<!-- readerd:auto:end -->\r\n\r\n末尾手动备注：保留。\r\n';

test('reads Chinese canonical fields and comma-separated interests', () => {
  assert.deepEqual(parseProfile(original), {identity: '研究生', direction: '肠道菌群', interests: ['NAD+', '烟酰胺', 'PncA'], history: []});
  assert.deepEqual(parseProfile('- 兴趣关键词: metabolism, nicotinamide').interests, ['metabolism', 'nicotinamide']);
});

test('history-only updates preserve all manual bytes and Chinese sentinels', () => {
  const history = [{title: '烟酰胺代谢', readAt: '2026-10-24', topics: ['PncA']}];
  const updated = updateProfile(original, {identity: '不应保存', history}, {historyOnly: true});
  assert.equal(updated.slice(0, updated.indexOf('<!-- readerd:auto:start -->')), manual);
  assert.ok(updated.endsWith('\r\n\r\n末尾手动备注：保留。\r\n'));
  assert.deepEqual(parseProfile(updated).history, history);
  assert.equal(parseProfile(updated).identity, '研究生');
});

test('settings update edits existing fields without appending duplicate profiles', () => {
  const updated = updateProfile(original, {identity: '博士生', direction: '微生物 NAD+', interests: ['NA', 'NAM'], history: []});
  assert.equal(updated.match(/身份[：:]/g).length, 1);
  assert.equal(updated.match(/感兴趣的主题[：:]/g).length, 1);
  assert.equal(parseProfile(updated).identity, '博士生');
  assert.deepEqual(parseProfile(updated).interests, ['NA', 'NAM']);
  assert.ok(updated.includes('手动备注：中文哨兵 — 我的实验问题不能被覆盖。'));
  assert.ok(!updated.includes('readerd:profile:start'));
});

test('appends an auto region without disturbing user document and reads legacy history', () => {
  const custom = '自定义中文记录，无末尾换行';
  const updated = updateProfile(custom, {history: [{title: 'Paper'}]}, {historyOnly: true});
  assert.ok(updated.startsWith(custom));
  assert.deepEqual(parseProfile(updated).history, [{title: 'Paper'}]);
  const legacy = '<!-- readerd:history:start -->\n```json\n[{"title":"旧论文"}]\n```\n<!-- readerd:history:end -->';
  assert.equal(parseProfile(legacy).history[0].title, '旧论文');
  assert.deepEqual(parseProfile(updateProfile(legacy, {}, {historyOnly: true})).history, [{title: '旧论文'}]);
});

test('corrupt automatic JSON fails safely and missing manual fields are added once', () => {
  const updated = updateProfile('用户说明\n<!-- readerd:auto:start -->\n```json\nbroken\n```\n<!-- readerd:auto:end -->', {direction: '中文研究'});
  assert.deepEqual(parseProfile(updated).history, []);
  const again = updateProfile(updated, {identity: '研究生'});
  assert.equal(again.match(/研究方向：/g).length, 1);
  assert.equal(parseProfile(again).direction, '中文研究');
});

test('PDF text cannot terminate the owned region or JSON code fence', () => {
  const history = [{title: '``` <!-- readerd:auto:end -->', annotations: ['```json']}];
  const updated = updateProfile(original, {history}, {historyOnly: true});
  assert.equal(updated.match(/<!-- readerd:auto:end -->/g).length, 1);
  assert.deepEqual(parseProfile(updated).history, history);
});
