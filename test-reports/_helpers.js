'use strict';
/**
 * 在岗哨 · 方案承诺 ↔ 代码实现 对齐测试 —— 公共工具
 *
 * 只读地引用规则引擎（<repo>/server/rules.js），
 * 不修改 server/ 与 public/ 下的任何文件。
 */

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const R = require(ROOT + '/server/rules.js');

const OFF = 480; // UTC+8，与 db.js DEFAULT_SETTINGS.timezoneOffsetMinutes 一致

/** 服务端默认规则参数（db.js DEFAULT_SETTINGS → server/index.js rulesConfig()） */
const CFG = {
  weekStartWd: 1,            // 1 = 周一
  dailyCapMinutes: 12 * 60,  // 每日封顶 720
  lunchStartMinute: 12 * 60, // 午休窗口 12:00
  lunchWindowMinutes: 60,
  lunchMinOverlapMinutes: 45,
  lunchDeductionMinutes: 60,
  timezoneOffsetMinutes: OFF,
};

/** 本地日期时间 → UTC 毫秒（固定偏移，不含夏令时） */
function tsAt(dateKey, hh = 0, mm = 0, ss = 0, off = OFF) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss, 0) - off * 60000;
}

/** 构造一条打卡事件 */
function evAt(dateKey, hh, mm, kind, opts = {}) {
  const { ss = 0, off = OFF, id = null } = opts;
  const e = { ts: tsAt(dateKey, hh, mm, ss, off), kind };
  if (id) e.id = id;
  return e;
}
const ev = (dateKey, hh, mm, kind) => evAt(dateKey, hh, mm, kind);

/** 某本地日期所属自然周的起始日（weekStartWd=1 → 周一） */
function weekOf(dateKey, weekStartWd = CFG.weekStartWd) {
  return R.weekStartKeyOfDateKey(dateKey, weekStartWd);
}

/** 小时（浮点）→ 分钟 */
const H = (h) => h * 60;
/** 分钟 → 小时（保留 2 位） */
const toH = (m) => Math.round((m / 60) * 100) / 100;

/* ── 结论收集 ── */
const VERDICT = {
  OK: '✅ 一致',
  SPEC: '📄 方案页写错',
  CODE: '🐞 代码有 bug / 未实现',
  MIXED: '⚠️ 部分不一致',
};

const summary = [];

function record({ id, scenario, promise, actual, verdict, note = '' }) {
  summary.push({ id, scenario, promise, actual, verdict, note });
  return { id, scenario, promise, actual, verdict, note };
}

function summaryTable() {
  const head = '| # | 场景 | 方案承诺 | 实测结果 | 结论 | 说明 |\n|---|---|---|---|---|---|';
  const rows = summary.map((s) =>
    `| ${s.id} | ${s.scenario} | ${s.promise} | ${s.actual} | ${s.verdict} | ${s.note} |`
  );
  return [head, ...rows].join('\n');
}

function printSummary(title = '方案承诺 ↔ 实测 对表') {
  console.log(`\n══════ ${title} ══════`);
  console.log(summaryTable());
  console.log('─'.repeat(80));
  const counts = summary.reduce((a, s) => {
    a[s.verdict] = (a[s.verdict] || 0) + 1;
    return a;
  }, {});
  for (const [k, v] of Object.entries(counts)) console.log(`${k}: ${v}`);
  console.log(`总计 ${summary.length} 条\n`);
}

module.exports = {
  R, OFF, CFG,
  tsAt, evAt, ev, weekOf,
  H, toH,
  VERDICT, summary, record, summaryTable, printSummary,
};
