'use strict';
// 纯离线自检：不调用 LLM、不发 QQ
const assert = require('node:assert');
const path = require('node:path');
const { estTokens, extractJson, localDate, isoWeek, localHHmm } = require('../src/util');
const { normalizeEvent } = require('../src/ingest');
const diary = require('../src/channels/diary');

let passed = 0;
function ok(name, fn) { try { fn(); passed++; console.log('✓ ' + name); } catch (e) { console.error('✗ ' + name + ': ' + e.message); process.exitCode = 1; } }

ok('estTokens 中文约 0.65/字', () => {
  const t = estTokens('你好世界'); // 4 汉字
  assert.ok(t >= 2 && t <= 4, 'got ' + t);
  assert.equal(estTokens(''), 0);
});

ok('extractJson 容忍围栏与废话', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('前缀 {"b":2} 后缀'), { b: 2 });
  assert.equal(extractJson('没有 json'), null);
});

ok('时区日期', () => {
  const ts = Date.parse('2026-10-23T13:30:00Z');
  assert.equal(localDate(ts, 'Asia/Shanghai'), '2026-10-23');
  assert.equal(localHHmm(ts, 'Asia/Shanghai'), '21:30');
  assert.equal(isoWeek(ts, 'Asia/Shanghai').year + '-W' + isoWeek(ts, 'Asia/Shanghai').week, '2026-W43');
});

ok('群聊事件解析', () => {
  const m = normalizeEvent({ id: 1, title: '超理论坛交流环(8条新消息)', text: '小明: 今天聊聊CUDA？', at: Date.now() }, ['超理论坛交流环']);
  assert.equal(m.kind, 'group');
  assert.equal(m.chat, '超理论坛交流环');
  assert.equal(m.sender, '小明');
  assert.equal(m.text, '今天聊聊CUDA？');
});

ok('私聊事件解析', () => {
  const m = normalizeEvent({ id: 2, title: 'Myself', text: '在吗', at: Date.now() }, ['超理论坛交流环']);
  assert.equal(m.kind, 'private');
  assert.equal(m.chat, 'Myself');
  assert.equal(m.text, '在吗');
});

ok('日记事件解析', () => {
  const md = '## 事件\n- 聊了 CUDA 话题 — 分数: 88\n- 群友发了梗图 — 分数: 42\n## 最终日记\n1. （88 分）聊了 CUDA 话题';
  const ev = diary.parseDiaryEvents(md);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].score, 88);
});

ok('周报事件解析', () => {
  const md = '1. （调整后 88 分）聊了 CUDA 话题\n2. （调整后 61.5 分）群友发了梗图';
  const ev = diary.parseWeeklyEvents(md);
  assert.equal(ev.length, 2);
  assert.equal(ev[1].score, 61.5);
});

ok('统计：μ/σ/T', () => {
  const r = diary.stats([100, 80, 60]);
  assert.equal(r.n, 3);
  assert.equal(Math.round(r.mean), 80);
  assert.ok(Math.abs(r.std - 16.3299) < 0.01, 'std=' + r.std);
  assert.ok(Math.abs(r.threshold - (80 - 0.842 * r.std)) < 1e-9);
});

ok('周报筛选：beta 衰减 + T 过滤 + 降序', () => {
  const last = [{ desc: '上周A', score: 90 }, { desc: '上周B', score: 40 }];
  const now = [{ desc: '本周A', score: 70 }, { desc: '本周B', score: 55 }];
  const r = diary.buildWeekly(last, now, 0.7);
  // 调整后：63, 28, 70, 55 → μ=54, σ≈16.4, T≈40.2 → 保留 63/70/55
  assert.equal(r.kept.length, 3);
  assert.ok(r.kept[0].adj >= r.kept[1].adj && r.kept[1].adj >= r.kept[2].adj);
  assert.equal(r.kept[0].desc, '本周A');
  assert.equal(r.removed, 1);
});

ok('ISO 周日期范围', () => {
  const dates = diary.weekDates('2026-W43', 'Asia/Shanghai');
  assert.equal(dates.length, 7);
  assert.equal(dates[0], '2026-10-19');
  assert.equal(dates[6], '2026-10-25');
});

ok('上一周 key 计算', () => {
  assert.equal(diary.prevWeekKey('2026-W43'), '2026-W42');
  assert.equal(diary.prevWeekKey('2026-W01'), '2025-W52');
});

console.log('\n' + passed + ' 项通过');
