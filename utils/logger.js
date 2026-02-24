const config = require('../config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[config.migration.logLevel] ?? LEVELS.info;

function timestamp() {
  return new Date().toISOString();
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}m ${sec}s`;
}

function log(level, message, data) {
  if (LEVELS[level] > currentLevel) return;
  const prefix = `[${timestamp()}] [${level.toUpperCase()}]`;
  if (data !== undefined) {
    console.log(`${prefix} ${message}`, typeof data === 'object' ? JSON.stringify(data) : data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

module.exports = {
  error: (msg, data) => log('error', msg, data),
  warn: (msg, data) => log('warn', msg, data),
  info: (msg, data) => log('info', msg, data),
  debug: (msg, data) => log('debug', msg, data),

  phase: (phaseNum, phaseName) => {
    console.log('');
    console.log('='.repeat(70));
    console.log(`  FASE ${phaseNum} — ${phaseName}`);
    console.log('='.repeat(70));
  },

  table: (tableName, action) => {
    console.log(`\n  ► ${tableName} — ${action}`);
  },

  progress: (tableName, current, total) => {
    const pct = ((current / total) * 100).toFixed(1);
    const bar = '█'.repeat(Math.floor(current / total * 30)) + '░'.repeat(30 - Math.floor(current / total * 30));
    process.stdout.write(`\r    ${tableName}: ${current.toLocaleString()} / ${total.toLocaleString()} (${pct}%) ${bar}`);
    if (current >= total) process.stdout.write('\n');
  },

  summary: (tableName, results, durationMs) => {
    const parts = [`migrados: ${results.migrated}`];
    if (results.skipped > 0) parts.push(`omitidos: ${results.skipped}`);
    if (results.failed > 0) parts.push(`fallidos: ${results.failed}`);
    parts.push(`tiempo: ${formatDuration(durationMs)}`);
    console.log(`    ✓ ${tableName}: ${parts.join(', ')}`);
  },

  formatDuration,
};
