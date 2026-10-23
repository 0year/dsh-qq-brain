'use strict';
const logger = require('./logger');

/** 去掉不像真人打字的符号：直角引号、破折号、弯引号。 */
function humanize(s) {
  return String(s || '')
    .replace(/[「」『』]/g, '')
    .replace(/——/g, '，')
    .replace(/[“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 通过 dsh-status-hud 的 QQ 桥把消息发到 QQ（bridge 负责打开 QQ、分条、息屏自适应）。 */
class QQ {
  constructor(cfg, store) { this.cfg = cfg; this.store = store; }

  async sendTo(title, text, kind) {
    text = humanize(text);
    if (!text || !String(text).trim()) return { ok: false, error: 'empty' };
    const url = this.cfg.server.replace(/\/$/, '') + '/qq/ui-send';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, text: String(text).trim(), kind: kind || 'private' }), signal: ctl.signal });
      const data = await res.json().catch(() => ({}));
      logger.info('QQ 发送 -> ' + title + ' #' + (data.id || '?') + ': ' + String(text).slice(0, 50));
      return { ok: res.ok, id: data.id };
    } catch (e) {
      logger.warn('QQ 发送失败: ' + (e && e.message));
      return { ok: false, error: String(e && e.message) };
    } finally { clearTimeout(timer); }
  }

  sendOwner(text) { return this.sendTo(this.cfg.owner.qqTitle || 'Myself', text, 'private'); }
}

module.exports = { QQ };
