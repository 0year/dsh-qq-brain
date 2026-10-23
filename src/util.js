'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** 估算 token 数：中文约 1 字 ≈ 0.65 token，ASCII 词按 4 字符 ≈ 1 token。 */
function estTokens(text) {
  if (!text) return 0;
  let cjk = 0, ascii = 0;
  for (const ch of String(text)) {
    if (ch.charCodeAt(0) > 0x2e80) cjk++; else ascii++;
  }
  return Math.ceil(cjk * 0.65 + ascii / 4);
}

function localDate(ts, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

function isoWeek(ts, timeZone) {
  const d = new Date(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts)));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week: String(week).padStart(2, '0') };
}

function localHHmm(ts, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
}

function localWeekday(ts, timeZone) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(ts));
  return ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })[name];
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function appendJsonl(file, rows) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

/** 从 Anthropic 兼容响应里取文本 */
function responseText(resp) {
  const blocks = (resp && resp.content) || [];
  return blocks.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('').trim();
}

/** 从模型输出里抠出 JSON（容忍 ```json 围栏和前后废话） */
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch (e) { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { estTokens, localDate, isoWeek, localHHmm, localWeekday, ensureDir, readJson, writeJson, appendJsonl, readJsonl, responseText, extractJson, sleep };
