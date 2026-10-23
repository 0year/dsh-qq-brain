'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra === undefined ? base : extra;
  if (typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  if (typeof extra !== 'object' || extra === null) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const k of Object.keys(extra)) out[k] = deepMerge(base[k], extra[k]);
  return out;
}

const DEFAULTS = {
  server: 'http://127.0.0.1:8790',
  dataDir: path.join(ROOT, 'data'),
  timeZone: 'Asia/Shanghai',
  llm: { endpoint: 'https://api.deepseek.com/anthropic/v1/messages', model: 'deepseek-flash', maxTokens: 2000, keyPath: '/root/projects/.dsh/.credentials.yaml', keyEnv: 'DEEPSEEK_API_KEY', timeoutMs: 120000 },
  groups: [],
  owner: { qqTitle: 'Myself' },
  persona: '你是小克（Claude小姐），表面端庄优雅的大小姐，内心傲娇、嘴硬心软，说话自然简短。',
  pollIntervalMs: 1500,
  channels: {
    longterm: { enabled: true, thresholdTokens: 12000, maxBatchTokens: 20000 },
    interest: { enabled: true, keywords: [], shortWindowTokens: 1500, repeatNewTokens: 500, maxLlmCallsPerHour: 12, autoSpeak: false, dailySpeakQuota: 100, minReplyChars: 2, maxReplyChars: 120 },
    diary: { enabled: true, at: '21:00', includePrivate: true },
    weekly: { enabled: true, weekday: 7, at: '21:30', beta: 0.7 },
  },
};

function loadConfig() {
  const file = process.env.QQ_BRAIN_CONFIG || path.join(ROOT, 'config.json');
  let user = {};
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error('找不到配置文件 ' + file + '（先复制 config.example.json 成 config.json）'); }
  const cfg = deepMerge(DEFAULTS, user);
  if (!cfg.dataDir) cfg.dataDir = path.join(ROOT, 'data');
  const overrides = cfg.paths || {};
  cfg.paths = {
    state: path.join(cfg.dataDir, 'state.json'),
    messages: path.join(cfg.dataDir, 'messages'),
    memory: path.join(cfg.dataDir, 'memory'),
    profiles: path.join(cfg.dataDir, 'memory', 'profiles.json'),
    keywords: path.join(cfg.dataDir, 'memory', 'keywords.json'),
    topics: path.join(cfg.dataDir, 'memory', 'topics.json'),
    diary: path.join(cfg.dataDir, 'diary'),
    weekly: path.join(cfg.dataDir, 'weekly'),
    log: path.join(cfg.dataDir, 'brain.log'),
    pid: path.join(cfg.dataDir, 'brain.pid'),
  };
  for (const k of ['diary', 'weekly', 'messages', 'memory']) {
    if (overrides[k]) cfg.paths[k] = overrides[k];
    if (k === 'diary' && overrides.diary) cfg.paths.diary = overrides.diary;
    if (k === 'weekly' && overrides.weekly) cfg.paths.weekly = overrides.weekly;
  }
  if (overrides.diary) cfg.paths.diary = overrides.diary;
  if (overrides.weekly) cfg.paths.weekly = overrides.weekly;
  if (overrides.profiles) cfg.paths.profiles = overrides.profiles;
  if (overrides.keywords) cfg.paths.keywords = overrides.keywords;
  if (overrides.topics) cfg.paths.topics = overrides.topics;
  if (overrides.log) cfg.paths.log = overrides.log;
  return cfg;
}

module.exports = { loadConfig, DEFAULTS };
