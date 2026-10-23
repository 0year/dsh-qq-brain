#!/usr/bin/env node
'use strict';
const path = require('node:path');
const logger = require('./logger');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { LLM } = require('./llm');
const { QQ } = require('./qq');
const { Ingestor } = require('./ingest');
const { InterestChannel } = require('./channels/interest');
const { LongTermChannel } = require('./channels/longterm');
const { DiaryChannel } = require('./channels/diary');
const { localDate, localHHmm, localWeekday, isoWeek, sleep } = require('./util');

function build(cfg) {
  const store = new Store(cfg);
  const llm = new LLM(cfg.llm);
  const qq = new QQ(cfg, store);
  const ingestor = new Ingestor(cfg, store);
  const interest = new InterestChannel(cfg, store, llm, qq);
  const longterm = new LongTermChannel(cfg, store, llm);
  const diary = new DiaryChannel(cfg, store, llm, qq);
  return { store, llm, qq, ingestor, interest, longterm, diary };
}

async function once(cfg, world) {
  const msgs = await world.ingestor.pollOnce();
  if (msgs.length) await world.interest.onNewMessages(msgs);
  await world.longterm.maybeLearn();
  return msgs.length;
}

function dueDiary(cfg, store) {
  const dateKey = localDate(Date.now(), cfg.timeZone);
  if (store.state.lastDiaryDate === dateKey) return false;
  const now = localHHmm(Date.now(), cfg.timeZone);
  return now >= (cfg.channels.diary.at || '21:00');
}

function dueWeekly(cfg, store) {
  const w = isoWeek(Date.now(), cfg.timeZone);
  const key = w.year + '-W' + w.week;
  if (store.state.lastWeeklyKey === key) return false;
  if (localWeekday(Date.now(), cfg.timeZone) !== Number(cfg.channels.weekly.weekday || 7)) return false;
  return localHHmm(Date.now(), cfg.timeZone) >= (cfg.channels.weekly.at || '21:30');
}

async function start(cfg, world) {
  logger.info('qq-brain 启动：群=' + cfg.groups.join(',') + ' 数据目录=' + cfg.dataDir);
  try { require('node:fs').writeFileSync(cfg.paths.pid, String(process.pid)); } catch (e) { /* ignore */ }
  const cleanup = () => { try { require('node:fs').unlinkSync(cfg.paths.pid); } catch (e) { /* ignore */ } };
  let stopping = false;
  const stop = () => { stopping = true; logger.info('收到退出信号，正在停止…'); cleanup(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);

  // 事件驱动：轮询新消息 → 兴趣通道 / 长期学习
  (async () => {
    while (!stopping) {
      try {
        const msgs = await world.ingestor.pollOnce();
        if (msgs.length) {
          await world.interest.onNewMessages(msgs);
          await world.longterm.maybeLearn();
        }
      } catch (e) { logger.error('主循环异常: ' + (e && e.stack || e)); }
      await sleep(cfg.pollIntervalMs || 1500);
    }
  })();

  // 定时检查：日记 / 周报
  (async () => {
    while (!stopping) {
      try {
        if (cfg.channels.diary.enabled && dueDiary(cfg, world.store)) {
          await world.diary.runDaily();
        }
        if (cfg.channels.weekly.enabled && dueWeekly(cfg, world.store)) {
          await world.diary.runWeekly();
        }
      } catch (e) { logger.error('定时任务异常: ' + (e && e.stack || e)); }
      await sleep(30000);
    }
  })();

  while (!stopping) await sleep(1000);
  cleanup();
}

async function main() {
  const cmd = process.argv[2] || 'start';
  if (cmd === '--help' || cmd === '-h') {
    console.log('用法: node src/index.js <start|once|diary [YYYY-MM-DD]|weekly [YYYY-Www]|stats|test-llm>');
    return;
  }
  const cfg = loadConfig();
  logger.init(cfg.paths.log);
  const world = build(cfg);

  if (cmd === 'start') return start(cfg, world);
  if (cmd === 'once') {
    const n = await once(cfg, world);
    logger.info('once 完成，新消息 ' + n + ' 条；待学习 token=' + world.longterm.pendingTokens());
    return;
  }
  if (cmd === 'diary') { const r = await world.diary.runDaily(process.argv[3]); console.log(r ? '日记: ' + r.file : '无数据，未生成'); return; }
  if (cmd === 'weekly') { const r = await world.diary.runWeekly(process.argv[3]); console.log(r ? '周报: ' + r.file : '无数据，未生成'); return; }
  if (cmd === 'stats') {
    const st = world.store;
    const today = st.dateKey;
    const msgs = st.messagesOfDay(today);
    console.log(JSON.stringify({
      dataDir: cfg.dataDir,
      groups: cfg.groups,
      eventCursor: st.state.eventCursor,
      msgSeq: st.state.msgSeq,
      todayMessages: msgs.length,
      pendingLongTokens: world.longterm.pendingTokens(),
      profiles: Object.keys(st.profiles.senders || {}).length,
      keywords: (st.keywords.list || []).length,
      speakQuota: st.speakQuota(),
      lastDiaryDate: st.state.lastDiaryDate,
      lastWeeklyKey: st.state.lastWeeklyKey,
    }, null, 2));
    return;
  }
  if (cmd === 'test-llm') {
    const t = await world.llm.askText({ system: '只回复四个字。', prompt: '请回复：链路正常', maxTokens: 50 });
    console.log('LLM 回复: ' + t);
    return;
  }
  console.error('未知命令: ' + cmd);
  process.exitCode = 1;
}

main().catch(e => { logger.error('启动失败: ' + (e && e.stack || e)); process.exit(1); });
