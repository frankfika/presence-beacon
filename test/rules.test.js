'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../server/rules.js');

const OFF = 480; // UTC+8
const CFG = { weekStartWd: 1, dailyCapMinutes: 720, timezoneOffsetMinutes: OFF };

/** 本地日期时间 → UTC 毫秒 */
function ts(dateKey, hh, mm = 0) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, 0, 0) - OFF * 60000;
}
const ev = (dateKey, hh, mm, kind) => ({ ts: ts(dateKey, hh, mm), kind });

// 2026-11-16 是周一，2026-11-22 是周日
const MON = '2026-11-16';
const TUE = '2026-11-17';
const SUN = '2026-11-22';
const NEXT_MON = '2026-11-23';

test('进/出配对：一次完整进出 = 区间时长', () => {
  const r = R.computeAttendance(
    [ev(TUE, 9, 2, 'in'), ev(TUE, 18, 40, 'out')],
    [], CFG, ts(TUE, 19, 0)
  );
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 19, 0));
  // 09:02→18:40 = 578 分，覆盖整段午休 → 自动扣 60 → 518 分
  assert.strictEqual(st.minutes, 518);
  assert.strictEqual(st.days.length, 1);
  assert.strictEqual(st.days[0].lunchDeducted, 60);
});

test('中午打卡出去吃饭：空窗不计时，且不重复扣午休', () => {
  const r = R.computeAttendance(
    [ev(TUE, 9, 2, 'in'), ev(TUE, 12, 5, 'out'), ev(TUE, 13, 8, 'in'), ev(TUE, 18, 40, 'out')],
    [], CFG, ts(TUE, 19, 0)
  );
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 19, 0));
  // 183 + 332 = 515 分 = 8h35m = 8.58h（与方案页一致）
  assert.strictEqual(st.minutes, 515);
  assert.strictEqual(st.lunchDeducted, 0);
  assert.strictEqual(st.days[0].segments.length, 2);
});

test('忘了打卡出去吃饭：单段覆盖午休 → 自动扣 1 小时', () => {
  const r = R.computeAttendance(
    [ev(TUE, 9, 2, 'in'), ev(TUE, 18, 40, 'out')],
    [], CFG, ts(TUE, 19, 0)
  );
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 19, 0));
  assert.strictEqual(st.minutes, 518);
  assert.strictEqual(st.lunchDeducted, 60);
});

test('午休窗口只被覆盖 30 分钟（<45 阈值）→ 不扣', () => {
  const r = R.computeAttendance(
    [ev(TUE, 9, 2, 'in'), ev(TUE, 12, 30, 'out'), ev(TUE, 13, 0, 'in'), ev(TUE, 18, 0, 'out')],
    [], CFG, ts(TUE, 19, 0)
  );
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 19, 0));
  assert.strictEqual(st.lunchDeducted, 0);
});

test('跨天夜班：按本地自然日切开', () => {
  const r = R.computeAttendance(
    [ev(TUE, 22, 0, 'in'), ev('2026-11-18', 2, 0, 'out')],
    [], CFG, ts('2026-11-18', 3, 0)
  );
  const st = R.weekStatus(r, MON, 1440, ts('2026-11-18', 3, 0));
  assert.strictEqual(st.minutes, 240);
  assert.strictEqual(st.days.length, 2);
  assert.strictEqual(st.days[0].date, TUE);
  assert.strictEqual(st.days[0].minutes, 120);
  assert.strictEqual(st.days[1].date, '2026-11-18');
  assert.strictEqual(st.days[1].minutes, 120);
});

test('跨周归属：周日夜里到岗，时长按分钟切给所属周', () => {
  const r = R.computeAttendance(
    [ev(SUN, 22, 0, 'in'), ev(NEXT_MON, 2, 0, 'out')],
    [], CFG, ts(NEXT_MON, 3, 0)
  );
  const lastWeek = R.weekStatus(r, MON, 1440, ts(NEXT_MON, 3, 0));
  const thisWeek = R.weekStatus(r, NEXT_MON, 1440, ts(NEXT_MON, 3, 0));
  assert.strictEqual(lastWeek.minutes, 120); // 周日 22:00→24:00
  assert.strictEqual(thisWeek.minutes, 120);  // 周一 00:00→02:00
  assert.strictEqual(lastWeek.days[0].date, SUN);
  assert.strictEqual(thisWeek.days[0].date, NEXT_MON);
});

test('每日封顶：同一天造出 14.5h → 压到 12h', () => {
  const r = R.computeAttendance(
    [ev(TUE, 7, 0, 'in'), ev(TUE, 13, 0, 'out'), ev(TUE, 13, 30, 'in'), ev(TUE, 23, 0, 'out')],
    [], CFG, ts(TUE, 23, 30)
  );
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 23, 30));
  assert.strictEqual(st.minutes, 720);
  assert.strictEqual(st.cappedDays, 1);
});

test('未签退兜底：未超过封顶就截到「现在」', () => {
  const r = R.computeAttendance([ev(TUE, 9, 0, 'in')], [], CFG, ts(TUE, 20, 0));
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 20, 0));
  assert.strictEqual(st.minutes, 600); // 11h − 1h 午休扣减
  assert.strictEqual(st.unclosedDays, 1);
});

test('未签退兜底：超过封顶就截到 12h 并标记待确认', () => {
  const r = R.computeAttendance([ev(TUE, 9, 0, 'in')], [], CFG, ts(TUE, 23, 0));
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 23, 0));
  assert.strictEqual(st.minutes, 660); // 截到 12h，再扣 1h 午休
  assert.strictEqual(st.unclosedDays, 1);
  assert.strictEqual(r.truncated.length, 1);
});

test('连按两次 in：丢弃前一个未闭合段', () => {
  const r = R.computeAttendance(
    [ev(TUE, 9, 0, 'in'), ev(TUE, 10, 0, 'in'), ev(TUE, 18, 0, 'out')],
    [], CFG, ts(TUE, 19, 0)
  );
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 19, 0));
  assert.strictEqual(st.minutes, 420); // 10:00→18:00 = 8h − 1h 午休
});

test('假期抵扣：请假 8h → 目标降到 16h', () => {
  const r = R.computeAttendance(
    [ev(TUE, 9, 0, 'in'), ev(TUE, 18, 0, 'out')],
    [{ date: TUE, type: 'leave', minutes: 480 }],
    CFG, ts(TUE, 19, 0)
  );
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 19, 0));
  assert.strictEqual(st.deductedMinutes, 480);
  assert.strictEqual(st.effectiveTargetMinutes, 960);
  assert.strictEqual(st.gapMinutes, 480); // 目标 16h − 实到 8h = 8h
});

test('出差：既不计入也不抵扣', () => {
  const r = R.computeAttendance(
    [ev(TUE, 9, 0, 'in'), ev(TUE, 18, 0, 'out')],
    [{ date: TUE, type: 'travel', minutes: 480 }],
    CFG, ts(TUE, 19, 0)
  );
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 19, 0));
  assert.strictEqual(st.minutes, 0);                // 出差当天不计入周时长
  assert.strictEqual(st.deductedMinutes, 0);        // 出差不抵扣
  assert.strictEqual(st.hasTravel, true);
  assert.strictEqual(st.travelMinutes, 480);
  assert.strictEqual(st.travelDays, 1);
  // 原始打卡记录仍然保留，只是没计入
  assert.strictEqual(st.days[0].minutes, 480);
  assert.strictEqual(st.days[0].countedMinutes, 0);
  assert.strictEqual(st.days[0].travel, true);
});

test('法定假日 / 调休（holiday）从目标中扣除', () => {
  const r = R.computeAttendance(
    [ev(TUE, 9, 0, 'in'), ev(TUE, 18, 0, 'out')],
    [{ date: TUE, type: 'holiday', minutes: 480 }],
    CFG, ts(TUE, 19, 0)
  );
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 19, 0));
  assert.strictEqual(st.deductedMinutes, 480);
  assert.strictEqual(st.effectiveTargetMinutes, 960);
});

test('负数补卡不能把时长扣成负数', () => {
  const r = R.computeAttendance(
    [ev(TUE, 9, 0, 'in'), ev(TUE, 12, 0, 'out')],
    [{ date: TUE, type: 'adjust', minutes: -120 }],
    CFG, ts(TUE, 19, 0)
  );
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 19, 0));
  assert.strictEqual(st.minutes, 180);   // 负数补卡被忽略
  assert.ok(st.minutes >= 0);
  assert.strictEqual(st.adjustmentMinutes, 0);
});

test('补卡时长不受每日封顶影响，也不会被误标 capped', () => {
  const r = R.computeAttendance(
    [ev(TUE, 9, 0, 'in'), ev(TUE, 12, 0, 'out')],
    [{ date: TUE, type: 'adjust', minutes: 1440 }],
    CFG, ts(TUE, 19, 0)
  );
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 19, 0));
  assert.strictEqual(st.minutes, 180 + 1440);
  assert.strictEqual(st.cappedDays, 0);   // 人工补卡不算「刷时长被封顶」
  assert.strictEqual(st.adjustmentCount, 1);
});

test('午休扣减不会把短区间整段吃掉', () => {
  // 12:00–12:50 覆盖午休 50 分钟（≥45 阈值）→ 触发扣减，但只扣区间的一半
  const r = R.computeAttendance(
    [ev(TUE, 12, 0, 'in'), ev(TUE, 12, 50, 'out')],
    [], CFG, ts(TUE, 19, 0)
  );
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 19, 0));
  assert.ok(st.minutes > 0, '短区间不该被记成 0 分钟');
  assert.strictEqual(st.minutes, 25);   // 50 − 25
});

test('出差 + 请假混合：出差不抵扣，请假抵扣', () => {
  const r = R.computeAttendance(
    [ev(TUE, 9, 0, 'in'), ev(TUE, 18, 0, 'out')],
    [
      { date: TUE, type: 'travel', minutes: 480 },
      { date: '2026-11-18', type: 'leave', minutes: 240 },
    ],
    CFG, ts(TUE, 19, 0)
  );
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 19, 0));
  assert.strictEqual(st.minutes, 0);
  assert.strictEqual(st.deductedMinutes, 240);   // 只有请假抵扣
  assert.strictEqual(st.effectiveTargetMinutes, 1200);
});

test('补卡：adjust 事件直接加时长', () => {
  const r = R.computeAttendance(
    [ev(TUE, 9, 0, 'in'), ev(TUE, 12, 0, 'out')],
    [{ date: TUE, type: 'adjust', minutes: 60 }],
    CFG, ts(TUE, 19, 0)
  );
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 19, 0));
  assert.strictEqual(st.minutes, 180 + 60);
  assert.strictEqual(st.adjustmentMinutes, 60);
});

test('周目标达成判定', () => {
  const r = R.computeAttendance(
    [ev(TUE, 8, 0, 'in'), ev(TUE, 20, 0, 'out')],
    [], CFG, ts(TUE, 21, 0)
  );
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 21, 0));
  assert.strictEqual(st.minutes, 660); // 12h − 1h 午休
  assert.strictEqual(st.met, false);
  assert.strictEqual(st.status, 'behind');
  assert.strictEqual(st.gapMinutes, 780);
});

test('完全没打卡 → status = none', () => {
  const r = R.computeAttendance([], [], CFG, ts(TUE, 21, 0));
  const st = R.weekStatus(r, MON, 1440, ts(TUE, 21, 0));
  assert.strictEqual(st.minutes, 0);
  assert.strictEqual(st.status, 'none');
  assert.strictEqual(st.gapMinutes, 1440);
});

test('周起始日可配置：改成周日则归属周不同', () => {
  const cfg = { ...CFG, weekStartWd: 0 };
  const r = R.computeAttendance(
    [ev(TUE, 9, 0, 'in'), ev(TUE, 18, 0, 'out')],
    [], cfg, ts(TUE, 19, 0)
  );
  // 周日 2026-11-22 起的一周 → 11-17(周二) 属于 11-15 那一周
  const wk = R.weekStartKeyOfDateKey(TUE, 0);
  assert.strictEqual(wk, '2026-11-15');
  const st = R.weekStatus(r, wk, 1440, ts(TUE, 19, 0));
  assert.strictEqual(st.minutes, 480);
});

test('formatMinutes 输出', () => {
  assert.strictEqual(R.formatMinutes(515), '8h35m');
  assert.strictEqual(R.formatMinutes(518, 'decimal'), '8.6');
  assert.strictEqual(R.formatMinutes(480), '8h');
});
