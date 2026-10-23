'use strict';
const fs = require('node:fs');
const logger = require('./logger');
const { responseText, extractJson } = require('./util');

function readApiKey(llmCfg) {
  if (llmCfg.keyEnv && process.env[llmCfg.keyEnv]) return process.env[llmCfg.keyEnv].trim();
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  try {
    const raw = fs.readFileSync(llmCfg.keyPath, 'utf8');
    const m = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(raw);
    if (m) return m[1].trim();
  } catch (e) { /* ignore */ }
  throw new Error('找不到 DEEPSEEK_API_KEY（环境变量或 ' + llmCfg.keyPath + '）');
}

class LLM {
  constructor(cfg) {
    this.cfg = cfg;
    this.key = readApiKey(cfg);
    this.calls = 0;
  }

  async call({ system, messages, maxTokens, json }) {
    const body = {
      model: this.cfg.model,
      max_tokens: maxTokens || this.cfg.maxTokens,
      system: system || undefined,
      messages,
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs || 120000);
    try {
      const res = await fetch(this.cfg.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error('LLM HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
      const data = await res.json();
      this.calls++;
      const text = responseText(data);
      return { text, json: json ? extractJson(text) : null, raw: data };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 方便地要一个 JSON 结果 */
  async askJson({ system, prompt, maxTokens }) {
    const out = await this.call({ system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens, json: true });
    if (!out.json) throw new Error('模型没有返回合法 JSON: ' + (out.text || '').slice(0, 200));
    return out.json;
  }

  async askText({ system, prompt, maxTokens }) {
    const out = await this.call({ system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens });
    return out.text;
  }
}

module.exports = { LLM };
