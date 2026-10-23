'use strict';
const logger = require('../logger');
const { estTokens } = require('../util');

/** 长期学习通道：累计 token 达标 → 批量分析 → 增量更新人物画像（从不发言）。 */
class LongTermChannel {
  constructor(cfg, store, llm) {
    this.cfg = cfg;
    this.lc = cfg.channels.longterm;
    this.store = store;
    this.llm = llm;
    this.running = false;
  }

  pendingTokens() {
    const st = this.store.state;
    const msgs = this.store.messagesAfter(st.longCursorSeq).filter(m => this.isTarget(m));
    return msgs.reduce((a, m) => a + (m.tokens || estTokens(m.text)), 0);
  }

  isTarget(msg) {
    if (msg.kind === 'group') return this.cfg.groups.some(g => msg.chat.includes(g));
    return false; // 长期学习默认只学群聊
  }

  async maybeLearn() {
    if (!this.lc.enabled || this.running) return;
    if (this.pendingTokens() < this.lc.thresholdTokens) return;
    this.running = true;
    try {
      let guard = 0;
      while (this.pendingTokens() >= this.lc.thresholdTokens && guard++ < 3) {
        const batchMessages = [];
        let tokens = 0;
        for (const m of this.store.messagesAfter(this.store.state.longCursorSeq)) {
          if (!this.isTarget(m)) continue;
          const t = m.tokens || estTokens(m.text);
          if (tokens + t > this.lc.maxBatchTokens && batchMessages.length) break;
          batchMessages.push(m); tokens += t;
        }
        if (!batchMessages.length) break;
        await this.learnBatch(batchMessages);
        this.store.state.longCursorSeq = batchMessages[batchMessages.length - 1].seq;
        this.store.state.pendingTokens = this.pendingTokens();
        this.store.saveState();
      }
    } catch (e) {
      logger.warn('长期学习失败: ' + (e && e.message));
    } finally {
      this.running = false;
    }
  }

  async learnBatch(messages, depth = 0) {
    // 控制单批规模：transcript ≤ 5000 tokens，发送者 ≤ 20 人
    let batch = messages;
    const tokOf = m => m.tokens || estTokens(m.text);
    let total = batch.reduce((a, m) => a + tokOf(m), 0);
    if (total > 5000) {
      const stride = Math.ceil(total / 5000);
      batch = batch.filter((_, i) => i % stride === 0 || i === batch.length - 1);
      total = batch.reduce((a, m) => a + tokOf(m), 0);
    }
    const senders = [...new Set(batch.map(m => m.sender))];
    const existing = {};
    for (const s of senders) {
      const p = this.store.profiles.senders[s];
      if (p) existing[s] = { communication_style: p.communication_style, interests: p.interests, behavior: p.behavior, confidence: p.confidence };
    }
    const transcript = batch.map(m => m.sender + '：' + m.text).join('\n');
    const prompt = [
      '下面是 QQ 群「' + (batch[0].chat || '') + '」里刚积累的一段聊天记录（约 ' + total + ' tokens）。',
      '',
      '聊天记录：',
      transcript,
      '',
      '你对这些人已有的长期印象（JSON，可能为空）：',
      JSON.stringify(existing, null, 1),
      '',
      '你对这个群已有的整体认知：',
      JSON.stringify(this.store.profiles.groupFeatures || {}, null, 1),
      '',
      '请做「增量更新」而不是重新总结：',
      '1. 对记录里出现的每个人，修正/补充 communication_style（directness/verbosity/humor 用 high/medium/low）、interests（数组）、behavior（数组）、notes（短句），confidence 0~1（证据少就低）；',
      '2. 更新这个群的 groupFeatures（topics 数组、culture 一句话）；',
      '3. 提出 0~5 个值得加入兴趣索引的新关键词（candidate_keywords），只要确实反复出现的新话题。',
      '只描述聊天中可观察到的行为和明确喜好，不要推断敏感个人属性，不要编造。',
      '',
      '严格输出 JSON：{"profiles":{"昵称":{"communication_style":{"directness":"high","verbosity":"medium","humor":"low"},"interests":[],"behavior":[],"notes":"","confidence":0.5}},"group_features":{"topics":[],"culture":""},"candidate_keywords":[]}'
    ].join('\n');
    let out;
    try {
      out = await this.llm.askJson({ system: '你是长期记忆维护器，只输出 JSON。', prompt, maxTokens: 4000 });
    } catch (e) {
      // 上下文太大导致 JSON 截断：对半拆批重试一次
      if (depth < 2 && batch.length >= 8) {
        logger.warn('长期学习 JSON 解析失败，拆成两批重试: ' + (e && e.message).slice(0, 80));
        const mid = Math.floor(batch.length / 2);
        await this.learnBatch(batch.slice(0, mid), depth + 1);
        await this.learnBatch(batch.slice(mid), depth + 1);
        return;
      }
      throw e;
    }
    this.merge(out, senders);
    logger.info('长期学习完成：' + batch.length + ' 条消息，' + senders.length + ' 人，候选关键词 ' + ((out.candidate_keywords || []).length) + '，累积 profiles=' + Object.keys(this.store.profiles.senders || {}).length);
  }

  merge(out, senders) {
    const now = new Date().toISOString();
    for (const [name, upd] of Object.entries(out.profiles || {})) {
      if (!senders.includes(name)) continue;
      const prev = this.store.profiles.senders[name] || { evidenceCount: 0 };
      this.store.profiles.senders[name] = {
        name,
        communication_style: upd.communication_style || prev.communication_style || {},
        interests: [...new Set([...(prev.interests || []), ...(upd.interests || [])])].slice(0, 20),
        behavior: [...new Set([...(prev.behavior || []), ...(upd.behavior || [])])].slice(0, 20),
        notes: upd.notes || prev.notes || '',
        confidence: typeof upd.confidence === 'number' ? Math.max(0, Math.min(1, upd.confidence)) : (prev.confidence || 0.3),
        evidenceCount: (prev.evidenceCount || 0) + 1,
        lastSeen: now,
      };
    }
    if (out.group_features) {
      const gf = this.store.profiles.groupFeatures || {};
      this.store.profiles.groupFeatures = {
        topics: [...new Set([...(gf.topics || []), ...(out.group_features.topics || [])])].slice(0, 30),
        culture: out.group_features.culture || gf.culture || '',
        updatedAt: now,
      };
    }
    this.store.saveProfiles();
    // 兴趣关键词动态演化（去重、上限 300）
    const kws = this.store.keywords.list || [];
    const added = [];
    for (const k of (out.candidate_keywords || [])) {
      const kw = String(k || '').trim();
      if (!kw || kw.length > 20) continue;
      if (kws.some(x => x.toLowerCase() === kw.toLowerCase())) continue;
      kws.push(kw); added.push(kw);
    }
    if (kws.length > 300) kws.length = 300;
    if (added.length) {
      this.store.keywords.list = kws;
      this.store.saveKeywords();
      logger.info('兴趣索引新增关键词: ' + added.join(', '));
    }
  }
}

module.exports = { LongTermChannel };
