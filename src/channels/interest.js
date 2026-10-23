'use strict';
const logger = require('../logger');
const { estTokens, sleep } = require('../util');

/** 兴趣响应通道：关键词廉价唤醒 → 小窗口上下文 → 模型判断是否值得接话。 */
class InterestChannel {
  constructor(cfg, store, llm, qq) {
    this.cfg = cfg;
    this.ic = cfg.channels.interest;
    this.store = store;
    this.llm = llm;
    this.qq = qq;
    this.callTimes = [];
    this.keywords = Array.isArray(store.keywords.list) && store.keywords.list.length ? store.keywords.list : (this.ic.keywords || []);
    if (!store.keywords.list || !store.keywords.list.length) { store.keywords.list = this.keywords; store.saveKeywords(); }
    this.matchers = this.keywords.map(k => ({ k, re: this.makeMatcher(k) }));
  }

  makeMatcher(kw) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (/^[\x00-\x7f]+$/.test(kw)) return new RegExp('(^|[^A-Za-z0-9])' + esc + '([^A-Za-z0-9]|$)', 'i');
    return new RegExp(esc, 'i');
  }

  /** 关键词命中 + 增量 token 去重 → 是否触发 */
  matchAndUpdate(msg) {
    const hits = [];
    for (const m of this.matchers) {
      if (!m.re.test(msg.text)) continue;
      const topic = this.store.topics[m.k] || { lastTriggerAt: 0, tokensSince: 0 };
      topic.tokensSince = (topic.tokensSince || 0) + estTokens(msg.text);
      if (!topic.lastTriggerAt || topic.tokensSince >= this.ic.repeatNewTokens) hits.push(m.k);
      this.store.topics[m.k] = topic;
    }
    if (hits.length) {
      for (const k of hits) this.store.topics[k] = { lastTriggerAt: Date.now(), tokensSince: 0 };
      this.store.saveTopics();
    }
    return hits;
  }

  budgetOk() {
    const now = Date.now();
    this.callTimes = this.callTimes.filter(t => now - t < 3600 * 1000);
    return this.callTimes.length < this.ic.maxLlmCallsPerHour;
  }

  buildContext(chat, keyword) {
    const ctx = this.store.recentContext(chat, this.ic.shortWindowTokens);
    const lines = ctx.map(m => m.sender + '：' + m.text);
    const profiles = this.store.profiles.senders || {};
    const relevantProfiles = ctx.map(m => m.sender).filter((v, i, a) => a.indexOf(v) === i)
      .map(name => {
        const p = profiles[name];
        if (!p) return null;
        const style = p.language_style || {};
        const ex = (p.style_examples || []).slice(0, 2);
        return name + '：说话长短=' + (style.sentence_length || '?')
          + '，标点习惯=' + (style.punctuation_habit || '?')
          + '，口头禅=' + JSON.stringify(style.catchphrases || [])
          + '，语气=' + (style.tone || '?')
          + (ex.length ? '，原话例句=' + JSON.stringify(ex) : '');
      })
      .filter(Boolean).slice(0, 8);
    const gs = this.store.profiles.groupStyle || {};
    return { lines, profiles: relevantProfiles, groupFeatures: this.store.profiles.groupFeatures || {}, groupStyle: gs };
  }

  async maybeRespond(msg, hits) {
    if (!this.budgetOk()) { logger.info('兴趣通道预算用尽，跳过 ' + hits.join(',')); return null; }
    const chat = msg.chat;
    const ctx = this.buildContext(chat, hits[0]);
    const prompt = [
      '你在 QQ 群「' + chat + '」里潜水。',
      '刚刚有人提到了你感兴趣的关键词：' + hits.join('、'),
      '',
      '最近的聊天上下文：',
      ctx.lines.join('\n'),
      '',
      '你对这些人的长期印象：',
      (ctx.profiles.length ? ctx.profiles.join('\n') : '（暂无）'),
      '',
      '群里的整体特征：' + JSON.stringify(ctx.groupFeatures),
      '',
      '这个群的说话方式：' + JSON.stringify(ctx.groupStyle || {}),
      '',
      '请判断：',
      '1. 你现在是否真的感兴趣、值得接话？（不要为了回而回）',
      '2. 如果值得，写一句要发到群里的话：**必须模仿这个群的语言方式**（句子长短、标点习惯、口头禅、梗、语气），',
      '   短、口语、不科普、不纠正、不 @ 所有人；不要用书面语。',
      '',
      '严格输出 JSON：{"interested":true/false,"should_reply":true/false,"reply":"要发的话或null","reason":"一句话理由"}'
    ].join('\n');
    this.callTimes.push(Date.now());
    let decision;
    try {
      decision = await this.llm.askJson({
        system: (this.ic.persona || this.cfg.persona) + '\n你正在决定要不要在群里说一句话。只输出 JSON。',
        prompt,
        maxTokens: 500,
      });
    } catch (e) { logger.warn('兴趣判断失败: ' + (e && e.message)); return null; }
    logger.info('兴趣判断 [' + hits.join(',') + '] should_reply=' + decision.should_reply + ' reason=' + (decision.reason || ''));
    const record = { ts: Date.now(), chat, keyword: hits.join(','), message: msg.text, sender: msg.sender, decision };
    await this.logDecision(record);
    if (!decision.should_reply || !decision.reply) return decision;
    if (!this.ic.autoSpeak) { logger.info('autoSpeak=false，只记录不发送: ' + decision.reply); return decision; }
    const quota = this.store.speakQuota();
    if (quota.used >= (this.ic.dailySpeakQuota || 100)) { logger.info('今天群发言额度用完，不发送'); return decision; }
    // 合规过滤：长度 & 不该出现的词
    let reply = String(decision.reply).replace(/@所有人|@全体成员/g, '').trim();
    if (reply.length < (this.ic.minReplyChars || 1)) return decision;
    if (reply.length > (this.ic.maxReplyChars || 120)) reply = reply.slice(0, this.ic.maxReplyChars || 120);
    await sleep(800 + Math.floor(Math.random() * 1200));
    const r = await this.qq.sendTo(chat, reply, 'group');
    if (r.ok) this.store.consumeSpeakQuota();
    return decision;
  }

  async logDecision(record) {
    try {
      const { appendJsonl } = require('../util');
      const path = require('node:path');
      appendJsonl(path.join(this.cfg.dataDir, 'decisions', new Date().toISOString().slice(0, 10) + '.jsonl'), [record]);
    } catch (e) { /* ignore */ }
  }

  /** 事件驱动入口：新消息到达时调用 */
  async onNewMessages(messages) {
    if (!this.ic.enabled) return;
    for (const msg of messages) {
      if (msg.kind !== 'group') continue;
      if (!this.cfg.groups.some(g => msg.chat.includes(g))) continue;
      const hits = this.matchAndUpdate(msg);
      if (!hits.length) continue;
      await this.maybeRespond(msg, hits);
    }
  }
}

module.exports = { InterestChannel };
