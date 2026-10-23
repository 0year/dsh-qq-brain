'use strict';
const logger = require('./logger');

const GROUP_SUFFIX = /\s*\(\d+条新消息\)\s*$/;
const SENDER_PREFIX = /^(.{1,40}?)[:：]\s*(.+)$/s;

function stripSuffix(t) { return String(t || '').replace(GROUP_SUFFIX, '').trim(); }

/** 把 QQ 通知事件规范化成消息：群聊/私聊、发送者、内容。 */
function normalizeEvent(ev, groups) {
  const rawTitle = String(ev.title || '').trim();
  if (!rawTitle) return null;
  const text = String(ev.text || '').trim();
  if (!text) return null;
  const title = stripSuffix(rawTitle);
  // 群聊：标题是群名，正文形如「发送者: 内容」
  const m = SENDER_PREFIX.exec(text);
  const isGroupTitle = groups.some(g => title.includes(g));
  if (m && (isGroupTitle || /群/.test(title))) {
    return { ts: ev.at || ev.time || Date.now(), kind: 'group', chat: title, sender: m[1].trim(), text: m[2].trim(), eventId: ev.id };
  }
  if (isGroupTitle) return { ts: ev.at || ev.time || Date.now(), kind: 'group', chat: title, sender: '群友', text, eventId: ev.id };
  // 私聊：标题是对方备注/昵称
  return { ts: ev.at || ev.time || Date.now(), kind: 'private', chat: title, sender: title, text, eventId: ev.id };
}

class Ingestor {
  constructor(cfg, store) { this.cfg = cfg; this.store = store; this.seenHash = new Map(); }

  /** 拉取新事件并入库，返回新增消息 */
  async pollOnce() {
    const url = this.cfg.server.replace(/\/$/, '') + '/qq/events?since=' + this.store.state.eventCursor;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    let data;
    try {
      const res = await fetch(url, { signal: ctl.signal });
      data = await res.json();
    } catch (e) {
      logger.warn('拉取 QQ 事件失败: ' + (e && e.message));
      return [];
    } finally { clearTimeout(timer); }

    const events = data.events || [];
    if (data.cursor > this.store.state.eventCursor) {
      // cursor 只在成功处理时推进，避免漏消息
    }
    const rows = [];
    const seenKeys = new Set();
    for (const ev of events) {
      const msg = normalizeEvent(ev, this.cfg.groups);
      if (!msg) continue;
      const dedupeKey = msg.chat + '|' + msg.sender + '|' + msg.text;
      const last = this.seenHash.get(dedupeKey) || 0;
      if (Date.now() - last < 90000) continue; // QQ 重复通知去重
      this.seenHash.set(dedupeKey, Date.now());
      if (this.seenHash.size > 4000) this.seenHash.clear();
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      rows.push(msg);
    }
    if (data.cursor !== undefined) {
      this.store.state.eventCursor = Math.max(this.store.state.eventCursor, Number(data.cursor) || 0);
      this.store.saveState();
    }
    if (rows.length) {
      const saved = this.store.appendMessages(rows);
      logger.info('入库 ' + saved.length + ' 条（' + rows.filter(r => r.kind === 'group').length + ' 群聊）');
      return saved;
    }
    return [];
  }
}

module.exports = { Ingestor, normalizeEvent };
