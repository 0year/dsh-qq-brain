'use strict';
const fs = require('node:fs');
const path = require('node:path');

let logFile = null;
function init(file) { logFile = file; try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { /* ignore */ } }
function write(level, msg) {
  const line = new Date().toISOString() + ' [' + level + '] ' + msg;
  console.log(line);
  if (logFile) { try { fs.appendFileSync(logFile, line + '\n'); } catch (e) { /* ignore */ } }
}
module.exports = {
  init,
  info: m => write('info', m),
  warn: m => write('warn', m),
  error: m => write('error', m),
};
