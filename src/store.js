'use strict';
const fs = require('node:fs');
const path = require('node:path');
const logger = require('./logger');
const { estTokens, localDate, appendJsonl, readJsonl, readJson, writeJson, ensureDir } = require('./util');

class Store {
  constructor(cfg) {
    this.cfg = cfg;
    this.p = cfg.paths;
    ensureDir(this.p.dataDir || cfg.dataDir);
    ensureDir(this.p.messages);
    ensureDir(this.p.memory);
    ensureDir(this.p.diary);
    ensureDir(this.p.weekly);
    this.state = readJson(this.p.state, { eventCursor: 0, msgSeq: 0, pendingTokens: 0, longCursorSeq: 0, lastDiaryDate: '', lastWeeklyKey: '', speakQuota: { date: '', used: 0 } });
    this.recent = []; // 最近消息内存缓存
    this.loadRecentFromDisk();
    this.profiles = readJson(this.p.profiles, { version: 1, senders: {}, groupFeatures: {}, updatedAt: '' });
    this.keywords = readJson(this.p.keywords, { updatedAt: '', list: [] });
    this.topics = readJson(this.p.topics, {});
  }

  /** 启动时把最近 30 天的消息读回内存（跨进程恢复上下文与学习游标） */
  loadRecentFromDisk(days = 30) {
    try {
      const files = fs.readdirSync(this.p.messages).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-days);
      const rows = [];
      for (const f of files) rows.push(...readJsonl(path.join(this.p.messages, f)));
      rows.sort((a, b) => (a.seq || 0) - (b.seq || 0));
      this.recent = rows;
      if (rows.length) this.state.msgSeq = Math.max(this.state.msgSeq || 0, rows[rows.length - 1].seq || 0);
      const pending = rows.filter(m => (m.seq || 0) > (this.state.longCursorSeq || 0) && m.kind === 'group' && (this.cfg.groups || []).some(g => String(m.chat || '').includes(g)))
        .reduce((a, m) => a + (m.tokens || 0), 0);
      this.state.pendingTokens = pending;
      this.saveState();
    } catch (e) { /* 首次运行没有数据 */ }
  }

  saveState() { writeJson(this.p.state, this.state); }
  saveProfiles() { this.profiles.updatedAt = new Date().toISOString(); writeJson(this.p.profiles, this.profiles); }
  saveKeywords() { this.keywords.updatedAt = new Date().toISOString(); writeJson(this.p.keywords, this.keywords); }
  saveTopics() { writeJson(this.p.topics, this.topics); }

  get dateKey() { return localDate(Date.now(), this.cfg.timeZone); }
  messageFile(dateKey) { return path.join(this.p.messages, dateKey + '.jsonl'); }

  appendMessages(rows) {
    if (!rows.length) return [];
    const byDate = new Map();
    for (const row of rows) {
      row.seq = ++this.state.msgSeq;
      row.tokens = estTokens(row.text);
      const dk = localDate(row.ts, this.cfg.timeZone);
      if (!byDate.has(dk)) byDate.set(dk, []);
      byDate.get(dk).push(row);
    }
    for (const [dk, list] of byDate) appendJsonl(this.messageFile(dk), list);
    this.state.pendingTokens += rows.reduce((a, r) => a + r.tokens, 0);
    this.saveState();
    this.recent.push(...rows);
    if (this.recent.length > 6000) this.recent = this.recent.slice(-4000);
    return rows;
  }

  /** 读某天的消息 */
  messagesOfDay(dateKey) {
    const cached = this.recent.filter(m => localDate(m.ts, this.cfg.timeZone) === dateKey);
    const seen = new Set(cached.map(m => m.seq));
    const disk = readJsonl(this.messageFile(dateKey)).filter(m => !seen.has(m.seq));
    return [...disk, ...cached].sort((a, b) => a.seq - b.seq);
  }

  /** 取最近 n 条 / 最近 token 预算的上下文 */
  recentContext(chat, budgetTokens) {
    const list = this.recent.filter(m => m.chat === chat);
    let tokens = 0; const out = [];
    for (let i = list.length - 1; i >= 0 && tokens < budgetTokens; i--) {
      tokens += list[i].tokens || estTokens(list[i].text);
      out.unshift(list[i]);
    }
    return out;
  }

  messagesAfter(seq) { return this.recent.filter(m => m.seq > seq); }

  /** 群发言额度（每天 N 条） */
  speakQuota() {
    const today = this.dateKey;
    if (this.state.speakQuota.date !== today) this.state.speakQuota = { date: today, used: 0 };
    return this.state.speakQuota;
  }
  consumeSpeakQuota() {
    const q = this.speakQuota();
    q.used++;
    this.saveState();
    return q;
  }
}

module.exports = { Store };
