'use strict';
const fs = require('node:fs');
const path = require('node:path');
const logger = require('../logger');
const { localDate, isoWeek, localHHmm, estTokens, readJson, writeJson } = require('../util');

/** 解析日记文件里的「事件」行：`- 描述 — 分数: N` */
function parseDiaryEvents(markdown) {
  const out = [];
  for (const line of String(markdown || '').split('\n')) {
    const m = /^-\s*(.+?)\s*[—–-]\s*分数[:：]\s*(\d+(?:\.\d+)?)\s*$/.exec(line.trim());
    if (m) out.push({ desc: m[1].trim(), score: Number(m[2]) });
  }
  return out;
}

/** 解析周报里的「调整后分数」行 */
function parseWeeklyEvents(markdown) {
  const out = [];
  for (const line of String(markdown || '').split('\n')) {
    const m = /^\d+\.\s*（调整后\s*([\d.]+)\s*分）\s*(.+)$/.exec(line.trim());
    if (m) out.push({ desc: m[2].trim(), score: Number(m[1]) });
  }
  return out;
}

function stats(scores) {
  const n = scores.length;
  if (!n) return { n: 0, mean: 0, std: 0, threshold: 0 };
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  return { n, mean, std, threshold: mean - 0.842 * std };
}

/** 周报筛选：上周事件×beta 与本周事件合并 → μ/σ → T=μ-0.842σ → 保留 ≥T */
function buildWeekly(lastWeekEvents, thisWeekEvents, beta) {
  const merged = [
    ...lastWeekEvents.map(e => ({ desc: e.desc, raw: e.score, adj: e.score * beta, source: 'last' })),
    ...thisWeekEvents.map(e => ({ desc: e.desc, raw: e.score, adj: e.score, source: 'this' })),
  ];
  const s = stats(merged.map(e => e.adj));
  const kept = merged.filter(e => e.adj >= s.threshold).sort((a, b) => b.adj - a.adj);
  return { ...s, beta, kept, removed: merged.length - kept.length, total: merged.length };
}

/** 取某个 ISO 周的周一到周日日期（YYYY-MM-DD） */
function weekDates(weekKey, timeZone) {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!m) throw new Error('bad weekKey ' + weekKey);
  const year = Number(m[1]), week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (week - 1) * 7);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    out.push(localDate(d.getTime(), timeZone));
  }
  return out;
}

function prevWeekKey(weekKey) {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  let year = Number(m[1]), week = Number(m[2]) - 1;
  if (week < 1) { year--; week = 52; }
  return year + '-W' + String(week).padStart(2, '0');
}

class DiaryChannel {
  constructor(cfg, store, llm, qq) {
    this.cfg = cfg;
    this.store = store;
    this.llm = llm;
    this.qq = qq;
  }

  dayTranscript(dateKey, opts = {}) {
    const includePrivate = opts.includePrivate !== false;
    const msgs = this.store.messagesOfDay(dateKey).filter(m => m.kind === 'group' || includePrivate);
    if (!msgs.length) return { text: '', msgs };
    const budget = 9000;
    let rows = msgs.map(m => {
      const hhmm = localHHmm(m.ts, this.cfg.timeZone);
      const where = m.kind === 'group' ? m.chat + ' / ' + m.sender : m.sender;
      return { hhmm, where, text: String(m.text).slice(0, 300), tokens: 0 };
    });
    const tok = r => estTokens(r.hhmm + ' ' + r.where + '：' + r.text);
    let total = rows.reduce((a, r) => a + tok(r), 0);
    if (total > budget) {
      const keep = Math.max(60, Math.floor(rows.length * budget / total));
      const stride = Math.ceil(rows.length / keep);
      rows = rows.filter((_, i) => i % stride === 0);
      total = rows.reduce((a, r) => a + tok(r), 0);
    }
    return { text: rows.map(r => r.hhmm + ' ' + r.where + '：' + r.text).join('\n'), msgs, tokens: total };
  }

  async runDaily(dateKey) {
    dateKey = dateKey || this.store.dateKey;
    const file = path.join(this.cfg.paths.diary, dateKey + '.md');
    if (fs.existsSync(file)) logger.info('日记已存在: ' + file);
    const { text, msgs } = this.dayTranscript(dateKey, { includePrivate: this.cfg.channels.diary.includePrivate });
    if (!msgs.length) { logger.info('今天没有消息，跳过日记'); return null; }
    const prompt = [
      '下面是 ' + dateKey + ' 这一天 QQ 群和私聊里的消息记录（已压缩）：',
      '',
      text,
      '',
      '请把它整理成当天的日记：',
      '1. 提炼出所有值得记录的事件（合并重复话题，一个人一天的闲聊可以合并成一件事件）；',
      '2. 每个事件用一句话客观描述，并给 0~100 分（重要性/信息量/情绪强度综合）；',
      '3. 另写一段 2~4 句的口语总结：挑最重要的 3~5 件事说给主人听，**不要出现任何公式、统计量、术语**（如 μ、σ、T、beta、阈值），像聊天一样。',
      '',
      '严格输出 JSON：{"events":[{"desc":"事件描述","score":82}],"summary":"给主人看的口语总结"}'
    ].join('\n');
    const out = await this.llm.askJson({ system: this.cfg.persona + '\n你在写当天的日记。只输出 JSON。', prompt, maxTokens: 2500 });
    const events = (out.events || []).filter(e => e && e.desc).map(e => ({ desc: String(e.desc).trim(), score: Math.max(0, Math.min(100, Number(e.score) || 0)) }));
    if (!events.length) { logger.warn('模型没有产出事件，跳过日记'); return null; }
    const sorted = [...events].sort((a, b) => b.score - a.score);
    const md = [
      '# ' + dateKey + ' 日记', '',
      '## 事件', ...events.map(e => '- ' + e.desc + ' — 分数: ' + e.score), '',
      '## 最终日记（按分数降序）', ...sorted.map((e, i) => (i + 1) + '. （' + e.score + ' 分）' + e.desc), '',
    ].join('\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, md);
    this.store.state.lastDiaryDate = dateKey;
    this.store.saveState();
    logger.info('日记已写: ' + file + '（' + events.length + ' 个事件）');
    const summary = String(out.summary || '').trim();
    if (summary && this.cfg.channels.diary.notifyOwner !== false) await this.qq.sendOwner(summary);
    return { file, events, summary };
  }

  async runWeekly(weekKey) {
    weekKey = weekKey || (() => { const w = isoWeek(Date.now(), this.cfg.timeZone); return w.year + '-W' + w.week; })();
    const dates = weekDates(weekKey, this.cfg.timeZone);
    const beta = Number(this.cfg.channels.weekly.beta) || 0.7;
    // 本周事件：来自本周日记
    const thisWeekEvents = [];
    for (const d of dates) {
      const f = path.join(this.cfg.paths.diary, d + '.md');
      if (!fs.existsSync(f)) continue;
      for (const ev of parseDiaryEvents(fs.readFileSync(f, 'utf8'))) thisWeekEvents.push(ev);
    }
    // 上周事件：来自上周周报的「调整后分数」
    const lastKey = prevWeekKey(weekKey);
    const lastFile = path.join(this.cfg.paths.weekly, lastKey + '.md');
    const lastWeekEvents = fs.existsSync(lastFile) ? parseWeeklyEvents(fs.readFileSync(lastFile, 'utf8')) : [];
    if (!thisWeekEvents.length) { logger.info('本周没有日记事件，跳过周报'); return null; }
    const r = buildWeekly(lastWeekEvents, thisWeekEvents, beta);
    const file = path.join(this.cfg.paths.weekly, weekKey + '.md');
    const md = [
      '# ' + weekKey + ' 周报（' + dates[0] + ' ~ ' + dates[6] + '）',
      '> beta=' + beta + ' μ=' + r.mean.toFixed(1) + ' σ=' + r.std.toFixed(2) + ' T=' + r.threshold.toFixed(2),
      '',
      ...r.kept.map((e, i) => (i + 1) + '. （调整后 ' + Math.round(e.adj) + ' 分）' + e.desc),
      '',
      '<!-- 统计：本周事件 ' + thisWeekEvents.length + ' 条，上周事件 ' + lastWeekEvents.length + ' 条，合并 ' + r.total + ' 条，过滤掉 ' + r.removed + ' 条 -->',
    ].join('\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, md);
    this.store.state.lastWeeklyKey = weekKey;
    this.store.saveState();
    logger.info('周报已写: ' + file + '（保留 ' + r.kept.length + '/' + r.total + '）');
    // 给主人的口语总结（无公式）
    const top = r.kept.slice(0, 6).map(e => '- （' + Math.round(e.adj) + ' 分）' + e.desc).join('\n');
    const summary = await this.llm.askText({
      system: this.cfg.persona + '\n用口语向主人汇报这一周，不要出现任何公式或统计术语。',
      prompt: '这是本周筛选后最重要的事件（括号里是权重分，不要提）：\n' + top + '\n\n请用 2~4 句话口语汇报，只讲事件本身。',
      maxTokens: 400,
    });
    if (summary && this.cfg.channels.weekly.notifyOwner !== false) await this.qq.sendOwner(summary);
    return { file, ...r };
  }
}

module.exports = { DiaryChannel, parseDiaryEvents, parseWeeklyEvents, stats, buildWeekly, weekDates, prevWeekKey };
