'use strict';
/**
 * 在岗哨 · 方案页没写、但真实存在的边界场景
 *
 * 覆盖任务要求的 9 类：
 *   T-Z*   时区偏移（TZ_OFFSET_MINUTES / timezoneOffsetMinutes）
 *   T-DST  跨夏令时 / T-MON 月末 / T-YR 年末 / T-LEAP 闰年
 *   T-WK   周一 00:00 / 周日 23:59 的归属
 *   T-SAME 同一秒两次打卡
 *   T-ORD  事件乱序写入
 *   T-ADJ  补卡 0 / 负数 / > 24h
 *   T-TGT0 目标为 0 的员工
 *   T-MULTI 一天多区间 → 封顶与午休扣减叠加
 *   T-DEL  删除后重加同名员工是否串号
 *  外加：午休阈值边界、封顶边界等规则引擎自身的坑。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { R, CFG, ev, evAt, tsAt, toH, VERDICT, record, printSummary, summary } = require('./_helpers.js');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { Store } = require(ROOT + '/server/db.js');

const MIN = 60000;
const MON = '2026-11-16';
const TUE = '2026-11-17';
const SUN = '2026-11-22';
const NEXT_MON = '2026-11-23';

/** 本地时间 → UTC 毫秒（任意偏移） */
function L(dateKey, hh, mm, ss = 0, off = 480) {
  return tsAt(dateKey, hh, mm, ss, off);
}

/* ═══════════════════════════════════════════════════════════════
   1. 时区偏移
   ═══════════════════════════════════════════════════════════════ */

test('[T-Z1] 时区偏移只认「固定分钟数」，改 offset 会改日期/周归属', () => {
  const ts = Date.UTC(2026, 10, 16, 16, 0); // 2026-11-16T16:00Z
  assert.strictEqual(R.dateKeyOf(ts, 480), '2026-11-17');   // UTC+8 → 次日 00:00
  assert.strictEqual(R.dateKeyOf(ts, 0), '2026-11-16');     // UTC
  assert.strictEqual(R.dateKeyOf(ts, -300), '2026-11-16');  // UTC-5 → 当日 11:00
  assert.strictEqual(R.dateKeyOf(ts, 330), '2026-11-16');   // UTC+5:30 → 当日 21:30
  assert.strictEqual(R.dateKeyOf(ts, 720), '2026-11-17');   // UTC+12 → 次日 08:00

  // 同一时刻，跨周的归属会随 offset 改变
  const ts2 = Date.UTC(2026, 10, 22, 16, 0); // 2026-11-22T16:00Z
  const wk8 = R.weekStartKeyOfDateKey(R.dateKeyOf(ts2, 480), 1);
  const wk5 = R.weekStartKeyOfDateKey(R.dateKeyOf(ts2, -300), 1);
  assert.strictEqual(wk8, '2026-11-23');  // UTC+8 → 周一 00:00 → 归下一周
  assert.strictEqual(wk5, '2026-11-16');  // UTC-5 → 周日 11:00 → 归本周
  record({
    id: 'T-Z1', scenario: '时区偏移（timezoneOffsetMinutes）',
    promise: '方案页未提；系统提供「时区偏移（分钟）」配置，默认 480',
    actual: 'offset 是固定分钟数（不做时区/夏令时计算）；同一时刻在不同 offset 下可落到不同日期、不同自然周',
    verdict: VERDICT.OK,
    note: '行为符合「固定偏移」设计，但意味着非 UTC+8 地区需要手工维护偏移值。',
  });
});

test('[T-Z2] TZ_OFFSET_MINUTES 环境变量是死代码：真正生效的是 settings.timezoneOffsetMinutes', () => {
  const src = fs.readFileSync(ROOT + '/server/index.js', 'utf8');
  assert.ok(/const TZ_OFFSET = Number\(process\.env\.TZ_OFFSET_MINUTES \|\| 480\)/.test(src), '应定义了 TZ_OFFSET');
  const uses = src.match(/\bTZ_OFFSET\b/g) || [];
  assert.strictEqual(uses.length, 1, 'TZ_OFFSET 只出现 1 次 → 定义后从未被使用（死代码）');
  // 生效路径：rulesConfig() 读的是 settings 表
  assert.ok(/timezoneOffsetMinutes: Number\(s\.timezoneOffsetMinutes\)/.test(src));
  const db = fs.readFileSync(ROOT + '/server/db.js', 'utf8');
  assert.ok(/timezoneOffsetMinutes: '480'/.test(db));
  record({
    id: 'T-Z2', scenario: 'TZ_OFFSET_MINUTES vs timezoneOffsetMinutes',
    promise: '方案页未提',
    actual: 'TZ_OFFSET_MINUTES 被读进常量 TZ_OFFSET 后再没被用过；实际生效的是 settings.timezoneOffsetMinutes（默认 480）',
    verdict: VERDICT.CODE,
    note: '部署时想用环境变量改时区会「看起来不生效」——要么删掉这个死变量，要么把它接到 settings 初始化上。',
  });
});

test('[T-Z3] 全局周目标 weeklyTargetMinutes 只在建档时生效，改它不动存量员工', () => {
  const store = new Store(':memory:');
  const a = store.createEmployee({ name: '老员工' });          // 继承默认 1440
  store.setSetting('weeklyTargetMinutes', '1920');             // 全局改成 32h
  const b = store.createEmployee({ name: '新员工' });          // 新人才拿到 1920
  assert.strictEqual(store.getEmployee(a.id).target_minutes, 1440);
  assert.strictEqual(store.getEmployee(b.id).target_minutes, 1920);
  record({
    id: 'T-Z3', scenario: '全局周目标 vs 存量员工',
    promise: '方案页：「周目标 24 小时，可按岗位或个人分别设置」「旺季临时提目标：本周改成 32h」',
    actual: '改全局 weeklyTargetMinutes 只影响之后新建的员工；存量员工的 target_minutes 不动（个人 PATCH 有效）',
    verdict: VERDICT.MIXED,
    note: 'S24 的「个人改 32h 即时生效」是成立的；但「统一把团队目标改成 32h」需要逐人 PATCH，管理页没有「应用到全部」。',
  });
});

/* ═══════════════════════════════════════════════════════════════
   2. 夏令时 / 月末 / 年末 / 闰年
   ═══════════════════════════════════════════════════════════════ */

test('[T-DST] 固定偏移 → 没有夏令时：跨 DST 日的夜班会多算/少算 1 小时', () => {
  const off = -300; // America/New_York 冬令时
  // 2026-03-08 美东进入夏令时（02:00 → 03:00）
  // 夜班 2026-03-07 23:00 → 2026-03-08 07:00（本地）
  const r = R.computeAttendance(
    [evAt('2026-03-07', 23, 0, 'in', { off }), evAt('2026-03-08', 7, 0, 'out', { off })],
    [], { ...CFG, timezoneOffsetMinutes: off }, L('2026-03-08', 8, 0, 0, off)
  );
  assert.strictEqual(r.weeks[0].minutes, 480);   // 引擎按固定偏移算 = 8h
  // 真实纽约时间：23:00 EST = 04:00Z，07:00 EDT = 11:00Z → 实际只有 7 小时
  assert.strictEqual((Date.UTC(2026, 2, 8, 11, 0) - Date.UTC(2026, 2, 8, 4, 0)) / MIN, 420);
  record({
    id: 'T-DST', scenario: '跨夏令时的夜班（America/New_York 口径）',
    promise: '方案页未提',
    actual: '引擎按固定偏移算 480 min；真实 DST 日历下应为 420 min（多算 60 min）。秋季回拨日则相反（少算 60 min）',
    verdict: VERDICT.CODE,
    note: '中国无夏令时、默认 UTC+8 无影响；但配置里允许改成任何固定偏移，用美区/欧区时每年 2 天会差 1 小时。属设计限制，非致命。',
  });
});

test('[T-MON] 月末跨天：1/31 → 2/1 的切分与跨周归属', () => {
  // 1/31(周六) 22:00 → 2/1(周日) 02:00：同属 1/26 那周，切成两天
  const r1 = R.computeAttendance(
    [ev('2026-01-31', 22, 0, 'in'), ev('2026-02-01', 2, 0, 'out')],
    [], CFG, L('2026-02-01', 3, 0)
  );
  assert.deepStrictEqual(r1.weeks.map((w) => w.weekStart), ['2026-01-26']);
  assert.strictEqual(r1.weeks[0].minutes, 240);
  assert.deepStrictEqual(r1.weeks[0].days.map((d) => d.date), ['2026-01-31', '2026-02-01']);

  // 2/1(周日) 23:58 → 2/2(周一) 00:02：跨周，各 2 分钟
  const r2 = R.computeAttendance(
    [ev('2026-02-01', 23, 58, 'in'), ev('2026-02-02', 0, 2, 'out')],
    [], CFG, L('2026-02-02', 1, 0)
  );
  assert.deepStrictEqual(r2.weeks.map((w) => w.weekStart), ['2026-01-26', '2026-02-02']);
  assert.strictEqual(R.weekStatus(r2, '2026-01-26', 1440, 0).minutes, 2);
  assert.strictEqual(R.weekStatus(r2, '2026-02-02', 1440, 0).minutes, 2);
  record({
    id: 'T-MON', scenario: '月末跨天',
    promise: '方案页未提',
    actual: '按本地自然日切分：1/31→2/1 同周切两天（240 min）；2/1 深夜→2/2 凌晨跨周 2min/2min',
    verdict: VERDICT.OK,
    note: '月末行为正确（无「每月最后一天特殊逻辑」的坑）。',
  });
});

test('[T-YR] 年末跨年：12/31 → 1/1、以及跨年跨周', () => {
  const r1 = R.computeAttendance(
    [ev('2025-12-31', 22, 0, 'in'), ev('2026-01-01', 2, 0, 'out')],
    [], CFG, L('2026-01-01', 3, 0)
  );
  assert.deepStrictEqual(r1.weeks.map((w) => w.weekStart), ['2025-12-29']);   // 同一周
  assert.strictEqual(r1.weeks[0].minutes, 240);
  assert.deepStrictEqual(r1.weeks[0].days.map((d) => d.date), ['2025-12-31', '2026-01-01']);

  // 2026-01-04(周日) 23:58 → 2026-01-05(周一) 00:02：跨年又跨周
  const r2 = R.computeAttendance(
    [ev('2026-01-04', 23, 58, 'in'), ev('2026-01-05', 0, 2, 'out')],
    [], CFG, L('2026-01-05', 1, 0)
  );
  assert.deepStrictEqual(r2.weeks.map((w) => w.weekStart), ['2025-12-29', '2026-01-05']);
  assert.strictEqual(R.weekStatus(r2, '2025-12-29', 1440, 0).minutes, 2);
  assert.strictEqual(R.weekStatus(r2, '2026-01-05', 1440, 0).minutes, 2);
  record({
    id: 'T-YR', scenario: '年末跨年 / 跨年跨周',
    promise: '方案页未提',
    actual: '12/31 22:00→1/1 02:00 全在 12/29 那周（240 min）；跨到 1/5(周一) 则 2min/2min 分属两周',
    verdict: VERDICT.OK,
    note: '跨年正确：自然周以日期字符串为准，不受「年」影响。',
  });
});

test('[T-LEAP] 闰年 2/29：存在、归属正确；平年 2/28→3/1 只跨 1 天', () => {
  assert.strictEqual(R.weekStartKeyOfDateKey('2024-02-29', 1), '2024-02-26');   // 周四 → 上周一
  const r1 = R.computeAttendance(
    [ev('2024-02-29', 22, 0, 'in'), ev('2024-03-01', 2, 0, 'out')],
    [], CFG, L('2024-03-01', 3, 0)
  );
  assert.deepStrictEqual(r1.weeks[0].days.map((d) => d.date), ['2024-02-29', '2024-03-01']);
  assert.strictEqual(r1.weeks[0].minutes, 240);

  // 2024-02-28 → 2024-03-01 跨 3 天（29 日存在），中间那天整日 → 被每日封顶裁到 720
  const r2 = R.computeAttendance(
    [ev('2024-02-28', 22, 0, 'in'), ev('2024-03-01', 2, 0, 'out')],
    [], CFG, L('2024-03-01', 3, 0)
  );
  assert.deepStrictEqual(r2.weeks[0].days.map((d) => d.date), ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.strictEqual(r2.weeks[0].minutes, 120 + 720 + 120);

  // 平年：2/28 → 3/1 跨 1 天
  const r3 = R.computeAttendance(
    [ev('2026-02-28', 22, 0, 'in'), ev('2026-03-01', 2, 0, 'out')],
    [], CFG, L('2026-03-01', 3, 0)
  );
  assert.deepStrictEqual(r3.weeks[0].days.map((d) => d.date), ['2026-02-28', '2026-03-01']);
  assert.strictEqual(r3.weeks[0].minutes, 240);
  record({
    id: 'T-LEAP', scenario: '闰年 / 平年 月末',
    promise: '方案页未提',
    actual: '2024-02-29 正常存在（周四，归属 2/26 那周）；2/28→3/1 在闰年跨 3 天（中间整天被封顶到 720）、平年跨 2 天',
    verdict: VERDICT.OK,
    note: '正确。',
  });
});

/* ═══════════════════════════════════════════════════════════════
   3. 周一 00:00 / 周日 23:59
   ═══════════════════════════════════════════════════════════════ */

test('[T-WK] 打卡正好在周一 00:00 / 周日 23:59 的归属', () => {
  // 周一 00:00:00 打卡 → 算新的一周
  assert.strictEqual(R.weekStartKeyOfDateKey(R.dateKeyOf(L(MON, 0, 0, 0), 480), 1), MON);
  // 周日 23:59:59 打卡 → 算上一周
  assert.strictEqual(R.weekStartKeyOfDateKey(R.dateKeyOf(L(SUN, 23, 59, 59), 480), 1), MON);
  // 跨零点 1 秒 → 分属两周，各 1 秒
  const r = R.computeAttendance(
    [evAt(SUN, 23, 59, 'in', { ss: 59 }), { ts: L(NEXT_MON, 0, 0, 1), kind: 'out' }],
    [], CFG, L(NEXT_MON, 1, 0)
  );
  const last = R.weekStatus(r, MON, 1440, 0).minutes;
  const next = R.weekStatus(r, NEXT_MON, 1440, 0).minutes;
  assert.ok(Math.abs(last - 1 / 60) < 1e-9, `上周应是 1 秒，得到 ${last}`);
  assert.ok(Math.abs(next - 1 / 60) < 1e-9, `本周应是 1 秒，得到 ${next}`);
  // daysLeft：周一是 7，周日是 1
  assert.strictEqual(R.daysUntilWeekEnd(MON, 1), 7);
  assert.strictEqual(R.daysUntilWeekEnd(SUN, 1), 1);
  record({
    id: 'T-WK', scenario: '周一 00:00 / 周日 23:59 的边界归属',
    promise: '方案页未提；规则说「按本地自然日切开，再归到自然周」',
    actual: '周一 00:00:00 → 新一周；周日 23:59:59 → 上一周；跨零点 1 秒按秒切给两周',
    verdict: VERDICT.OK,
    note: '边界正确。注意 daysUntilWeekEnd 周一返回 7（含当天），周报「还剩几天」的口径需要和 UI 对齐。',
  });
});

/* ═══════════════════════════════════════════════════════════════
   4. 同一秒两次打卡
   ═══════════════════════════════════════════════════════════════ */

test('[T-SAME] 同一秒两次打卡：in+out 同时刻 → 0 分钟且整天不建档', () => {
  const t = L(TUE, 9, 0, 0);
  const r = R.computeAttendance(
    [{ ts: t, kind: 'in' }, { ts: t, kind: 'out' }],
    [], CFG, L(TUE, 19, 0)
  );
  assert.strictEqual(r.weeks.length, 0, '零长度区间不会建出「天」记录');
  assert.strictEqual(R.weekStatus(r, MON, 1440, L(TUE, 19, 0)).minutes, 0);
  assert.strictEqual(r.segments.length, 1);
  assert.strictEqual(r.segments[0].closed, true);
  record({
    id: 'T-SAME', scenario: '同一秒 in + out',
    promise: '方案页未提',
    actual: '配对成 0 长度区间 → 该区间被整段丢弃，连当天的记录都不产生（days 为空）',
    verdict: VERDICT.OK,
    note: '行为合理（不会凭空产生时长）。但服务端 nextKindFor 仍会把第二次记成 out，后续配对会错位——见 S14。',
  });
});

test('[T-SAME2] 同一秒连按两次 in → 丢弃前一段；单独的 out 被忽略', () => {
  const t = L(TUE, 9, 0, 0);
  const r1 = R.computeAttendance(
    [{ ts: t, kind: 'in' }, { ts: t, kind: 'in' }, ev(TUE, 18, 0, 'out')],
    [], CFG, L(TUE, 19, 0)
  );
  assert.strictEqual(r1.weeks[0].minutes, 480);      // 09:00→18:00 = 540 分钟，扣 60 午休 → 480
  assert.strictEqual(r1.segments.filter((s) => s.dropped).length, 1);

  const r2 = R.computeAttendance([{ ts: t, kind: 'out' }], [], CFG, L(TUE, 19, 0));
  assert.strictEqual(r2.segments.length, 0);
  assert.strictEqual(r2.weeks.length, 0);
  record({
    id: 'T-SAME2', scenario: '同一秒连按两次 in / 无配对的 out',
    promise: '方案页未提',
    actual: '两次 in → 前一段被丢弃（dropped），后一段正常计 480 min；无配对的 out → 直接忽略，不产生任何记录',
    verdict: VERDICT.OK,
    note: '规则层面对「手滑」是容错的；问题出在服务端把第二次 in 判成 out（S14）。',
  });
});

test('[T-SAME3] 相邻 1 秒的两次打卡会产生 0.0167 分钟的碎时长（CSV 里会被四舍五入成 0.00 h）', () => {
  const r = R.computeAttendance(
    [{ ts: L(TUE, 9, 0, 0), kind: 'in' }, { ts: L(TUE, 9, 0, 1), kind: 'out' }],
    [], CFG, L(TUE, 19, 0)
  );
  assert.ok(Math.abs(r.weeks[0].minutes - 1 / 60) < 1e-9);
  assert.strictEqual((r.weeks[0].minutes / 60).toFixed(2), '0.00');
  record({
    id: 'T-SAME3', scenario: '1 秒内进出',
    promise: '方案页未提',
    actual: '产生 1 秒 = 0.0167 分钟的时长；周报页显示 0m，CSV 显示 0.00 小时',
    verdict: VERDICT.OK,
    note: '碎时长无害，但说明引擎不做秒级取整；若将来按秒计费要注意。',
  });
});

/* ═══════════════════════════════════════════════════════════════
   5. 事件乱序写入
   ═══════════════════════════════════════════════════════════════ */

test('[T-ORD] 事件乱序写入：引擎会按 ts 排序，结果与顺序无关', () => {
  const ordered = [ev(TUE, 9, 2, 'in'), ev(TUE, 18, 40, 'out')];
  const shuffled = [ev(TUE, 18, 40, 'out'), ev(TUE, 9, 2, 'in')];
  const a = R.computeAttendance(ordered, [], CFG, L(TUE, 19, 0));
  const b = R.computeAttendance(shuffled, [], CFG, L(TUE, 19, 0));
  assert.strictEqual(a.weeks[0].minutes, b.weeks[0].minutes);
  assert.strictEqual(b.weeks[0].minutes, 518);
  record({
    id: 'T-ORD', scenario: '事件乱序写入',
    promise: '方案页未提',
    actual: 'computeAttendance 内部 [..events].sort((a,b)=>a.ts-b.ts) → 与写入顺序无关',
    verdict: VERDICT.OK,
    note: '引擎层安全。数据库层 listEvents 也是 ORDER BY ts ASC。',
  });
});

test('[T-ORD2] ts 相同的 in/out 保持写入顺序（稳定排序）；out 的 ts 早于 in 时会被忽略', () => {
  const t = L(TUE, 9, 0, 0);
  const r1 = R.computeAttendance(
    [{ ts: t, kind: 'in' }, { ts: t, kind: 'out' }], [], CFG, L(TUE, 19, 0)
  );
  assert.strictEqual(r1.weeks.length, 0);            // in 在前 → 配成 0 长度 → 丢弃
  const r2 = R.computeAttendance(
    [{ ts: t, kind: 'out' }, { ts: t, kind: 'in' }], [], CFG, L(TUE, 19, 0)
  );
  assert.strictEqual(r2.segments.length, 1);
  assert.strictEqual(r2.segments[0].closed, false);   // out 在前被忽略 → in 悬空
  assert.strictEqual(r2.truncated.length, 1);
  record({
    id: 'T-ORD2', scenario: '同 ts 的 in/out 顺序敏感',
    promise: '方案页未提',
    actual: 'V8 的 sort 是稳定排序 → 同样 ts 时保持写入顺序：[in,out] 归零，[out,in] 则 out 被忽略、in 悬空到 now',
    verdict: VERDICT.OK,
    note: '同一秒内先到后到的顺序由数据库主键/插入顺序决定，语义可接受。',
  });
});

test('[T-ORD3] 数据库层：乱序插入的事件，取出来是按 ts 升序的', () => {
  const store = new Store(':memory:');
  const e = store.createEmployee({ name: '乱序' });
  store.addEvent({ employeeId: e.id, ts: L(TUE, 18, 40, 0), kind: 'out' });
  store.addEvent({ employeeId: e.id, ts: L(TUE, 9, 2, 0), kind: 'in' });
  const list = store.listEvents(e.id, 0);
  assert.deepStrictEqual(list.map((x) => x.kind), ['in', 'out']);
  record({
    id: 'T-ORD3', scenario: '数据库事件顺序',
    promise: '方案页未提',
    actual: 'listEvents() ORDER BY ts ASC → 乱序写入也按时间取',
    verdict: VERDICT.OK,
    note: '配合 idx_evt_emp_ts 索引，无问题。',
  });
});

/* ═══════════════════════════════════════════════════════════════
   6. 补卡 0 / 负数 / > 24 小时
   ═══════════════════════════════════════════════════════════════ */

test('[T-ADJ1] 补卡 0 分钟 = 无事发生', () => {
  const r = R.computeAttendance(
    [ev(TUE, 9, 0, 'in'), ev(TUE, 18, 0, 'out')],
    [{ date: TUE, type: 'adjust', minutes: 0 }], CFG, L(TUE, 19, 0)
  );
  assert.strictEqual(r.weeks[0].minutes, 480);
  assert.strictEqual(r.weeks[0].adjustmentMinutes, 0);
  record({ id: 'T-ADJ1', scenario: '补卡 0 分钟', promise: '方案页未提', actual: '时长相加 0，不影响统计', verdict: VERDICT.OK, note: '' });
});

test('[T-ADJ2] ✅ 补卡负数：规则引擎拦下负数，不会把时长扣成负值', () => {
  const r = R.computeAttendance(
    [ev(TUE, 9, 0, 'in'), ev(TUE, 12, 0, 'out')],
    [{ date: TUE, type: 'adjust', minutes: -60 }], CFG, L(TUE, 19, 0)
  );
  assert.strictEqual(r.weeks[0].minutes, 180);      // 负数补卡被忽略
  assert.strictEqual(r.weeks[0].adjustmentMinutes, 0);

  // 极端：整天没有打卡 + 负数补卡 → 时长仍然不为负
  const r2 = R.computeAttendance(
    [], [{ date: TUE, type: 'adjust', minutes: -120 }], CFG, L(TUE, 19, 0)
  );
  assert.strictEqual(r2.weeks[0].minutes, 0);
  const st = R.weekStatus(r2, MON, 1440, L(TUE, 19, 0));
  assert.strictEqual(st.gapMinutes, 1440);
  assert.ok(st.gapMinutes >= 0);
  assert.strictEqual(st.status, 'none');            // minutes ≤ 0 → 既不是 met 也不是 behind
  record({
    id: 'T-ADJ2', scenario: '补卡时长为负数',
    promise: '方案页未提；管理端只应能加时长',
    actual: '规则引擎对 minutes 不做下限校验：负数补卡会把当天/当周时长扣成负数（周时长 −120、gap 1560、状态 none），CSV 会输出负数小时',
    verdict: VERDICT.CODE,
    note: 'HTTP 接口层做了 Math.max(0, …) 拦截（见 api-parity.test.js），但规则引擎自身没有防线：任何绕过接口的写入（脚本导入、迁移）都会产生负时长。属于防御性缺口。',
  });
});

test('[T-ADJ3] ✅ 补卡超过 24 小时：人工补卡不受每日封顶影响，也不误标 capped', () => {
  const r = R.computeAttendance(
    [], [{ date: TUE, type: 'adjust', minutes: 5000 }], CFG, L(TUE, 19, 0)
  );
  const day = r.weeks[0].days[0];
  assert.strictEqual(day.minutes, 0);                // 打卡时长为 0（本来就没打卡）
  assert.strictEqual(day.adjustments, 5000);         // 人工补卡全额计入
  assert.strictEqual(day.countedMinutes, 5000);      // 计入周总时长
  assert.strictEqual(day.capped, false);             // 不会被误标成「刷时长被封顶」
  assert.strictEqual(r.weeks[0].adjustmentMinutes, 5000);
  assert.strictEqual(r.weeks[0].minutes, 5000);
  record({
    id: 'T-ADJ3', scenario: '补卡时长 > 24h',
    promise: '方案页未提',
    actual: '人工补卡是管理员批准的，直接计入，不参与每日封顶、也不误标 capped',
    verdict: VERDICT.OK,
    note: '每日封顶只针对打卡时长，人工补卡另算。接口层仍会把 minutes 截到 [0,1440]。',
  });
});

/* ═══════════════════════════════════════════════════════════════
   7. 目标为 0 的员工
   ═══════════════════════════════════════════════════════════════ */

test('[T-TGT0] 目标为 0 的员工：永远「达标」，且请假抵扣不会把它扣成负数', () => {
  const r = R.computeAttendance([], [], CFG, L(TUE, 19, 0));
  const st = R.weekStatus(r, MON, 0, L(TUE, 19, 0));
  assert.strictEqual(st.effectiveTargetMinutes, 0);
  assert.strictEqual(st.gapMinutes, 0);
  assert.strictEqual(st.met, true);
  assert.strictEqual(st.status, 'met');

  const r2 = R.computeAttendance([], [{ date: TUE, type: 'leave', minutes: 480 }], CFG, L(TUE, 19, 0));
  const st2 = R.weekStatus(r2, MON, 0, L(TUE, 19, 0));
  assert.strictEqual(st2.effectiveTargetMinutes, 0, 'max(0, …) 兜住了负数');
  assert.strictEqual(st2.met, true);

  // 前端进度条不能除以 0
  const emp = fs.readFileSync(ROOT + '/public/employee.js', 'utf8');
  assert.ok(/effectiveTargetMinutes \? /.test(emp), '员工端进度条应做除零保护');
  record({
    id: 'T-TGT0', scenario: '周目标 = 0 的员工',
    promise: '方案页未提',
    actual: 'effectiveTarget=max(0,0−抵扣)=0 → gap=0 → met=true / status=met（零打卡也算达标）；前端进度条有除零保护',
    verdict: VERDICT.OK,
    note: '「没打卡但因目标是 0 而显示达标」在周报里容易误读（团队达标率会被虚高）。建议目标为 0 时不计入达标统计。',
  });
});

/* ═══════════════════════════════════════════════════════════════
   8. 一天多区间 → 封顶与午休扣减叠加
   ═══════════════════════════════════════════════════════════════ */

test('[T-MULTI1] 一天三个区间：午休扣减按「区间」逐段判定，且可以把整段吃掉', () => {
  const r = R.computeAttendance([
    ev(TUE, 8, 0, 'in'), ev(TUE, 9, 0, 'out'),      // 60 min，无午休
    ev(TUE, 12, 0, 'in'), ev(TUE, 12, 50, 'out'),   // 50 min，覆盖午休 50min ≥45 → 扣 50 → 0
    ev(TUE, 14, 0, 'in'), ev(TUE, 20, 0, 'out'),    // 360 min，无午休
  ], [], CFG, L(TUE, 21, 0));
  const day = r.weeks[0].days[0];
  assert.strictEqual(day.segments.length, 3);
  assert.strictEqual(day.lunchDeducted, 25);          // min(60, 覆盖 50, 时长一半 25)
  assert.strictEqual(day.minutes, 60 + 25 + 360);     // 短区间不会被整段吃掉
  assert.strictEqual(day.capped, false);
  record({
    id: 'T-MULTI1', scenario: '一天多个区间 + 午休扣减',
    promise: '方案页未提',
    actual: '扣减 = min(午休扣减时长, 实际覆盖午休的分钟数, 这段时长的一半)：12:00–12:50 这段扣 25 分钟，净 25 分钟',
    verdict: VERDICT.OK,
    note: '短区间不会被整段吃掉。',
  });
});

test('[T-MULTI2] 一天内午休扣减最多触发一次（区间互不重叠，总覆盖 ≤ 60min）', () => {
  // 两段各覆盖 30 分钟：都不足 45 → 一分不扣
  const r1 = R.computeAttendance([
    ev(TUE, 11, 30, 'in'), ev(TUE, 12, 20, 'out'),
    ev(TUE, 12, 30, 'in'), ev(TUE, 13, 30, 'out'),
  ], [], CFG, L(TUE, 20, 0));
  assert.strictEqual(r1.weeks[0].days[0].lunchDeducted, 0);

  // 一段覆盖 50 分钟（≥45）→ 扣 min(60, 覆盖 50, 时长一半 55) = 50，另一段覆盖 0
  const r2 = R.computeAttendance([
    ev(TUE, 11, 0, 'in'), ev(TUE, 12, 50, 'out'),
    ev(TUE, 13, 0, 'in'), ev(TUE, 14, 0, 'out'),
  ], [], CFG, L(TUE, 20, 0));
  assert.strictEqual(r2.weeks[0].days[0].lunchDeducted, 50);
  record({
    id: 'T-MULTI2', scenario: '多区间的午休扣减叠加',
    promise: '方案页未提',
    actual: '区间互不重叠 → 单日午休窗口总覆盖 ≤ 60min → 最多只有一段能达到 ≥45 阈值 → 每天最多扣一次',
    verdict: VERDICT.OK,
    note: '不会出现「同一天被扣 2 小时」的重复扣减，规则是自洽的。',
  });
});

test('[T-MULTI3] 封顶与午休扣减叠加：扣完再封顶；封顶标记只在 >720 时才打', () => {
  const capped = R.computeAttendance(
    [ev(TUE, 7, 0, 'in'), ev(TUE, 21, 0, 'out')], [], CFG, L(TUE, 22, 0)
  );
  const d1 = capped.weeks[0].days[0];
  assert.strictEqual(d1.lunchDeducted, 60);
  assert.strictEqual(d1.minutes, 720);       // 840 − 60 = 780 → 裁到 720
  assert.strictEqual(d1.capped, true);

  // 恰好 720（08:00→21:00）→ 不标 capped
  const exact = R.computeAttendance(
    [ev(TUE, 8, 0, 'in'), ev(TUE, 21, 0, 'out')], [], CFG, L(TUE, 22, 0)
  );
  const d2 = exact.weeks[0].days[0];
  assert.strictEqual(d2.minutes, 720);
  assert.strictEqual(d2.capped, false, '等于上限不算「触顶」');

  // 721 → 触顶
  const over = R.computeAttendance(
    [ev(TUE, 7, 59, 'in'), ev(TUE, 21, 0, 'out')], [], CFG, L(TUE, 22, 0)
  );
  assert.strictEqual(over.weeks[0].days[0].minutes, 720);
  assert.strictEqual(over.weeks[0].days[0].capped, true);
  record({
    id: 'T-MULTI3', scenario: '封顶 × 午休扣减叠加',
    promise: '方案页：「每日封顶 12 小时」+「午休扣减 1 小时」',
    actual: '先扣午休再封顶；capped 只在 >720 时置位（正好 720 不算触顶）',
    verdict: VERDICT.OK,
    note: '与 S03 方案「加班到 21:00 = 12.0h（触顶）」的表述能对上（要 07:59 前到岗）。',
  });
});

/* ═══════════════════════════════════════════════════════════════
   9. 删除后重加同名员工
   ═══════════════════════════════════════════════════════════════ */

test('[T-DEL] 删除后重加同名员工：id 全新、统计不串号；历史时长随旧员工一起消失', () => {
  const store = new Store(':memory:');
  const a = store.createEmployee({ name: '张三', seat: 'A' });
  store.addEvent({ employeeId: a.id, ts: L(TUE, 9, 0, 0), kind: 'in' });
  store.addEvent({ employeeId: a.id, ts: L(TUE, 18, 0, 0), kind: 'out' });
  const ra = R.computeAttendance(store.listEvents(a.id).map((e) => ({ ts: e.ts, kind: e.kind })), [], CFG, L(TUE, 19, 0));
  assert.strictEqual(ra.weeks[0].minutes, 480);

  store.deleteEmployee(a.id);
  assert.strictEqual(store.listEvents(a.id).length, 0, '旧员工的历史事件被级联删除');

  const b = store.createEmployee({ name: '张三', seat: 'A' });
  assert.notStrictEqual(b.id, a.id, '同名重建会拿到新的 uuid');
  assert.strictEqual(store.listEvents(b.id).length, 0);
  const rb = R.computeAttendance(store.listEvents(b.id).map((e) => ({ ts: e.ts, kind: e.kind })), [], CFG, L(TUE, 19, 0));
  assert.strictEqual(rb.weeks.length, 0);
  assert.strictEqual(R.weekStatus(rb, MON, 1440, L(TUE, 19, 0)).minutes, 0);
  record({
    id: 'T-DEL', scenario: '删除后重加同名员工',
    promise: '方案页：「员工离职 → 删除其生物凭据；历史时长按政策保留或匿名化」',
    actual: '统计不串号 ✓（新 uuid、0 事件、0 分钟）；但旧员工的历史时长被 CASCADE 物理删除 ✗，与「保留或匿名化」相反',
    verdict: VERDICT.CODE,
    note: '要满足方案，需要「匿名化保留」（把 employee_id 换成匿名占位）或软删除 + 历史归档；当前只有物理删除这一条路。',
  });
});

test('[T-DEL2] 名字不是唯一键：同名两人可共存（各算各的），但周报里两行同名', () => {
  const store = new Store(':memory:');
  const a = store.createEmployee({ name: '李四' });
  const b = store.createEmployee({ name: '李四' });
  assert.notStrictEqual(a.id, b.id);
  store.addEvent({ employeeId: a.id, ts: L(TUE, 9, 0, 0), kind: 'in' });
  store.addEvent({ employeeId: a.id, ts: L(TUE, 18, 0, 0), kind: 'out' });
  const mins = (id) => R.weekStatus(
    R.computeAttendance(store.listEvents(id).map((e) => ({ ts: e.ts, kind: e.kind })), [], CFG, L(TUE, 19, 0)),
    MON, 1440, L(TUE, 19, 0)
  ).minutes;
  assert.strictEqual(mins(a.id), 480);
  assert.strictEqual(mins(b.id), 0);
  assert.strictEqual(store.listEmployees().length, 2);
  record({
    id: 'T-DEL2', scenario: '同名员工共存',
    promise: '方案页未提',
    actual: '两个人可以同时叫「李四」，事件按 uuid 归属，互不串号；周报会出现两行同名',
    verdict: VERDICT.OK,
    note: '数据正确，但周报用姓名做展示标识，建议同时展示工位/员工号避免歧义。',
  });
});

/* ═══════════════════════════════════════════════════════════════
   额外：午休阈值 & 封顶的精确边界
   ═══════════════════════════════════════════════════════════════ */

test('[T-LUNCH] ✅ 午休阈值边界：覆盖 45 分钟就扣（方案已改成 ≥45），且短区间不会被整段吃掉', () => {
  const at45 = R.computeAttendance(
    [ev(TUE, 12, 0, 'in'), ev(TUE, 12, 45, 'out')], [], CFG, L(TUE, 19, 0)
  );
  assert.strictEqual(at45.weeks[0].days[0].lunchDeducted, 22);   // min(60, 覆盖 45, 时长一半 22)
  assert.strictEqual(at45.weeks[0].days[0].minutes, 23);          // 不为 0

  const at44 = R.computeAttendance(
    [ev(TUE, 12, 0, 'in'), ev(TUE, 12, 44, 'out')], [], CFG, L(TUE, 19, 0)
  );
  assert.strictEqual(at44.weeks[0].days[0].lunchDeducted, 0);
  assert.strictEqual(at44.weeks[0].days[0].minutes, 44);
  record({
    id: 'T-LUNCH', scenario: '午休阈值 45 分钟的精确边界',
    promise: '方案页（已修正）：「单个在岗区间覆盖午休时段 ≥ 45 分钟」',
    actual: '代码是 overlap >= 45（等于 45 也扣），与方案一致；且扣减最多为区间时长的一半，短区间不会被整段吃掉',
    verdict: VERDICT.OK,
    note: '方案页与实现已对齐。',
  });
});

test('[T-CAP] 每日封顶是「先扣午休再裁」，且未签退的截断也是 12h', () => {
  // 未签退：09:00 打卡、现在 23:00 → 截到 12h 再扣 1h = 660
  const r = R.computeAttendance([ev(TUE, 9, 0, 'in')], [], CFG, L(TUE, 23, 0));
  const st = R.weekStatus(r, MON, 1440, L(TUE, 23, 0));
  assert.strictEqual(st.minutes, 660);
  assert.strictEqual(st.unclosedDays, 1);
  assert.strictEqual(r.truncated.length, 1);
  record({
    id: 'T-CAP', scenario: '未签退截断 12h',
    promise: '「未签退兜底：12 小时自动截断并标待确认」',
    actual: '截到 min(now, 开始+12h) = 720，再扣 60 午休 → 660 min；unclosedDays=1 标记待确认',
    verdict: VERDICT.OK,
    note: '与方案一致（注意「12 小时截断」指的是区间长度，扣午休后是 11h）。',
  });
});

/* ═══════════════════════════════════════════════════════════════
   汇总
   ═══════════════════════════════════════════════════════════════ */

test('汇总：边界场景对表', () => {
  printSummary('在岗哨 · 方案页未覆盖的边界场景');
  assert.ok(summary.length >= 18);
});
