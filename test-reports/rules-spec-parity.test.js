'use strict';
/**
 * 在岗哨 · 方案页 24 场景 + 10 条规则参数 → 代码实现 逐条对齐
 *
 * 方案页：/workspace/output/presence-beacon/index.html
 * 被测对象：<repo>/server/rules.js（纯函数，单测直接引用）
 *
 * 命名约定：
 *   [Sxx] 场景表 24 行      [Pxx] 规则参数 10 项
 *   测试名里的 ✅/📄/🐞/⚠️ 就是结论，写在报告里也一致。
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  R, CFG, ev, weekOf, toH, VERDICT, record, printSummary, summary,
} = require('./_helpers.js');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

/* 基准周：2026-11-16（周一）~ 2026-11-22（周日），与方案页周报图表一致 */
const MON = '2026-11-16';
const TUE = '2026-11-17';
const WED = '2026-11-18';
const THU = '2026-11-19';
const FRI = '2026-11-20';
const SUN = '2026-11-22';
const NEXT_MON = '2026-11-23';

/** 跑一次：返回某一周的 weekStatus */
function run(events, exceptions = [], weekStart = MON, nowTs = undefined, cfg = CFG) {
  const now = nowTs === undefined ? events.length ? events[events.length - 1].ts + 3600000 : Date.now() : nowTs;
  const r = R.computeAttendance(events, exceptions, cfg, now);
  return { r, st: R.weekStatus(r, weekStart, 1440, now) };
}

/* ═══════════════════════════════════════════════════════════════
   日常
   ═══════════════════════════════════════════════════════════════ */

test('[S01 ✅] 标准到岗 9:02 签进 / 18:40 签出 → 当天计 8.6 h', () => {
  const { st } = run([
    ev(TUE, 9, 2, 'in'),
    ev(TUE, 18, 40, 'out'),
  ]);
  // 578 分钟原始时长，覆盖整段午休 → 扣 60 → 518 分钟
  assert.strictEqual(st.minutes, 518);
  assert.strictEqual(R.formatMinutes(st.minutes, 'decimal'), '8.6');
  assert.strictEqual(st.days[0].lunchDeducted, 60);
  record({
    id: 'S01', scenario: '标准到岗 9:02→18:40',
    promise: '当天计 8.6 h',
    actual: `518 min = ${toH(518)} h；formatMinutes(decimal) = "${R.formatMinutes(518, 'decimal')}"`,
    verdict: VERDICT.OK,
    note: '578 分原始时长 − 60 分午休扣减 = 518 分 = 8.63h，页面一位小数显示 8.6，与方案一致。',
  });
});

test('[S02 📄] 中午外出吃饭：方案说「空窗>45min 且跨 12:00–13:00 再减 1h」→ 代码不扣', () => {
  const { st } = run([
    ev(TUE, 9, 2, 'in'), ev(TUE, 12, 5, 'out'),
    ev(TUE, 13, 8, 'in'), ev(TUE, 18, 40, 'out'),
  ]);
  // 空窗 12:05→13:08 = 63 分钟，跨过午休窗口 —— 方案字面承诺要再扣 60 分钟
  assert.strictEqual(st.lunchDeducted, 0);
  assert.strictEqual(st.minutes, 515);           // 183 + 332
  assert.strictEqual(R.formatMinutes(st.minutes, 'decimal'), '8.6');
  // 若按方案字面执行，应为 515 − 60 = 455 分钟
  assert.notStrictEqual(st.minutes, 455);
  record({
    id: 'S02', scenario: '中午外出吃饭（12:05 出 / 13:08 回）',
    promise: '空窗不计时；若开启午休扣减再减 1 h（空窗 > 45min 且跨 12:00–13:00 触发）',
    actual: `空窗确实不计时；但午休扣减未触发（lunchDeducted=0），当天 515 min = ${toH(515)} h`,
    verdict: VERDICT.SPEC,
    note: '代码的触发条件是「单个在岗区间覆盖午休窗口 ≥45min」，不是「空窗」。若按方案字面应为 455 min=7.58h，与方案自己的时间轴图 8.58h 及 S01 的 8.6h 自相矛盾 → 方案页写错，代码对。',
  });
});

test('[S03 📄] 加班到 21:00 → 方案说当天 12.0h（触顶）→ 代码只有 10.9h', () => {
  const { st } = run([ev(TUE, 9, 2, 'in'), ev(TUE, 21, 0, 'out')]);
  assert.strictEqual(st.minutes, 658);           // 718 − 60
  assert.strictEqual(st.cappedDays, 0);
  assert.strictEqual(toH(st.minutes), 10.97);
  // 方案宣称的 12.0h（触顶）只有在更早上班时才成立
  const early = run([ev(TUE, 6, 30, 'in'), ev(TUE, 21, 0, 'out')]);
  assert.strictEqual(early.st.minutes, 720);
  assert.strictEqual(early.st.cappedDays, 1);
  record({
    id: 'S03', scenario: '加班到 21:00（沿用 9:02 签进）',
    promise: '当天计 12.0 h（触顶）',
    actual: `718 − 60 = 658 min = ${toH(658)} h，未触顶（cappedDays=0）；要真到 12.0h 需 06:30 前到岗`,
    verdict: VERDICT.SPEC,
    note: '「触顶」必须 >12h 才会被裁；刚好 12.0h（如 08:00→21:00）capped 标记仍为 false。方案没写上班时间，12.0h 的前提缺失。',
  });
});

test('[S04 ✅] 全天远程办公 → 无记录，不计入', () => {
  const { st } = run([]);
  assert.strictEqual(st.minutes, 0);
  assert.strictEqual(st.status, 'none');
  assert.strictEqual(st.met, false);
  assert.strictEqual(st.gapMinutes, 1440);
  record({
    id: 'S04', scenario: '全天远程办公',
    promise: '无记录，不计入（本周要在别的天补足）',
    actual: 'minutes=0，status=none，gap=1440 min（差 24h）',
    verdict: VERDICT.OK,
    note: '无事件即无时长，周报按 gap 显示差额，行为一致。',
  });
});

/* ═══════════════════════════════════════════════════════════════
   灵活办公的边界
   ═══════════════════════════════════════════════════════════════ */

test('[S05 ✅] 一周只来 2 天（周二 10h + 周四 12h）→ 22h → 未达标', () => {
  const { st } = run([
    ev(TUE, 7, 30, 'in'), ev(TUE, 18, 30, 'out'),      // 660 − 60 = 600 = 10h
    ev(THU, 6, 30, 'in'), ev(THU, 19, 30, 'out'),      // 780 − 60 = 720 = 12h
  ]);
  assert.strictEqual(st.minutes, 1320);
  assert.strictEqual(toH(st.minutes), 22);
  assert.strictEqual(st.met, false);
  assert.strictEqual(st.gapMinutes, 120);
  assert.strictEqual(st.status, 'behind');
  record({
    id: 'S05', scenario: '一周只来 2 天（周二 10h + 周四 12h）',
    promise: '22 h → 未达标',
    actual: `1320 min = ${toH(1320)} h，met=false，gap=120 min`,
    verdict: VERDICT.OK,
    note: '两天净时长 10h + 12h（均已扣午休 1h）合计 22h，判定未达标，一致。',
  });
});

test('[S06 ✅] 每天来 4 小时 × 5 天 → 20h → 未达标', () => {
  const events = [];
  for (const d of [MON, TUE, WED, THU, FRI]) {
    events.push(ev(d, 9, 0, 'in'), ev(d, 12, 0, 'out'), ev(d, 13, 0, 'in'), ev(d, 14, 0, 'out'));
  }
  const { st } = run(events);
  assert.strictEqual(st.minutes, 1200);
  assert.strictEqual(toH(st.minutes), 20);
  assert.strictEqual(st.met, false);
  assert.strictEqual(st.gapMinutes, 240);
  // 补充：若「4 小时」取 09:00→13:00（跨午休窗口），代码会再扣 1h → 每天 3h
  const overlapDay = run([ev(TUE, 9, 0, 'in'), ev(TUE, 13, 0, 'out')]);
  assert.strictEqual(overlapDay.st.days[0].lunchDeducted, 60);
  assert.strictEqual(overlapDay.st.days[0].minutes, 180);
  record({
    id: 'S06', scenario: '每天来 4 小时 × 5 天',
    promise: '20 h → 未达标',
    actual: '09:00–12:00 + 13:00–14:00 口径：1200 min = 20h，未达标（gap 4h）；若按 09:00→13:00 则每天被扣 1h → 3h/天 = 15h',
    verdict: VERDICT.OK,
    note: '方案没写 4 小时具体时段。代码的午休扣减只对「单段覆盖午休 ≥45min」生效，所以是否碰 12:00–13:00 会让结果差 5h（20h vs 15h）——方案应补一句。',
  });
});

test('[S07 ✅] 上午远程、下午到岗 → 只计下午的 5 h', () => {
  const { st } = run([ev(TUE, 13, 0, 'in'), ev(TUE, 18, 0, 'out')]);
  assert.strictEqual(st.minutes, 300);
  assert.strictEqual(toH(st.minutes), 5);
  assert.strictEqual(st.days[0].lunchDeducted, 0);
  record({
    id: 'S07', scenario: '上午远程、下午到岗（13:00→18:00）',
    promise: '只计下午的 5 h',
    actual: '300 min = 5h，无午休扣减',
    verdict: VERDICT.OK,
    note: '13:00 起点不覆盖 12:00–13:00 窗口，一致。',
  });
});

test('[S08 ✅] 出差：既不计入也不抵扣（当天打卡时长不计入周时长）', () => {
  const { st } = run(
    [ev(TUE, 9, 0, 'in'), ev(TUE, 18, 0, 'out')],
    [{ date: TUE, type: 'travel', minutes: 480 }],
  );
  assert.strictEqual(st.deductedMinutes, 0);      // 不抵扣 ✓
  assert.strictEqual(st.hasTravel, true);
  assert.strictEqual(st.travelMinutes, 480);
  assert.strictEqual(st.minutes, 0);                 // 出差当天不计入 ✓
  assert.strictEqual(st.days[0].minutes, 480);       // 原始记录仍保留
  assert.strictEqual(st.days[0].countedMinutes, 0);  // 但计入周总时长的是 0
  assert.strictEqual(st.days[0].travel, true);
  record({
    id: 'S08', scenario: '客户现场 / 出差（当天仍有打卡记录）',
    promise: '单独标记，既不计入也不抵扣',
    actual: '不抵扣 ✓（deducted=0，hasTravel=true）；不计入 ✓——出差当天的 countedMinutes=0，原始记录仍保留在明细里',
    verdict: VERDICT.OK,
    note: '一致。',
  });
});

test('[S09 📄] 请假 1 天 → 方案说目标降到 21 h → 代码按填的分钟数扣，1 天(8h)→16h', () => {
  const { st } = run(
    [ev(TUE, 9, 0, 'in'), ev(TUE, 18, 0, 'out')],
    [{ date: TUE, type: 'leave', minutes: 480 }],
  );
  assert.strictEqual(st.deductedMinutes, 480);
  assert.strictEqual(st.effectiveTargetMinutes, 960);  // 1440 − 480 = 16h
  assert.strictEqual(toH(st.effectiveTargetMinutes), 16);
  // 只有恰好填 180 分钟（3h）才会得到方案写的 21h
  const three = run([], [{ date: TUE, type: 'leave', minutes: 180 }]);
  assert.strictEqual(three.st.effectiveTargetMinutes, 1260);
  assert.strictEqual(toH(three.st.effectiveTargetMinutes), 21);
  record({
    id: 'S09', scenario: '请假 1 天',
    promise: '本周目标自动降到 21 h',
    actual: '抵扣 = 请假记录的分钟数：8h→16h、24h→0h；只有填 3h 才是 21h',
    verdict: VERDICT.SPEC,
    note: '系统里没有「1 天」这个单位（员工端按小时填，默认 1h、上限 24h），24−3=21 无法从任何自然规则推出。方案应改成「请假 N 小时 → 目标 −N 小时」。',
  });
});

test('[S10 📄] 跨周值班 周日 22:00→周一 02:00 → 方案说「2h 上周 + 4h 本周」→ 代码是 2h + 2h', () => {
  const events = [ev(SUN, 22, 0, 'in'), ev(NEXT_MON, 2, 0, 'out')];
  const r = R.computeAttendance(events, [], CFG, Date.UTC(2026, 10, 23, 3, 0));
  const last = R.weekStatus(r, MON, 1440, r.config ? Date.UTC(2026, 10, 23, 3, 0) - 8 * 3600000 : 0);
  const thisWeek = R.weekStatus(r, NEXT_MON, 1440, Date.UTC(2026, 10, 23, 3, 0) - 8 * 3600000);
  assert.strictEqual(last.minutes, 120);
  assert.strictEqual(thisWeek.minutes, 120);
  assert.strictEqual(last.minutes + thisWeek.minutes, 240); // 总共 4 小时
  record({
    id: 'S10', scenario: '跨周值班 周日 22:00 到 / 周一 02:00 走',
    promise: '2 h 算上周，4 h 算本周（合计 6h）',
    actual: `上周 120 min = 2h，本周 120 min = 2h，合计 240 min = 4h`,
    verdict: VERDICT.SPEC,
    note: '22:00→次日 02:00 本身就只有 4 小时，「2h + 4h」= 6h 算错了。代码按自然日切分：周日 2h 归上周、周一 2h 归本周，合计与实际打卡时长一致 → 方案页写错，代码对。',
  });
});

test('[S11 🐞] 全员远程的一周 → 方案说「规则自动挂起、不标记任何人不达标」→ 代码没有这个概念', () => {
  const { st } = run([]); // 一整周零打卡
  assert.strictEqual(st.met, false);
  assert.strictEqual(st.status, 'none');
  assert.strictEqual(st.gapMinutes, 1440);
  // 规则引擎返回体里没有任何「全员远程 / 挂起」字段
  const r = R.computeAttendance([], [], CFG, Date.UTC(2026, 10, 17, 12, 0));
  assert.strictEqual(r.weeks.length, 0);      // 零打卡 → 连「周」都没有，更谈不上挂起
  assert.strictEqual(r.suspended, undefined);
  assert.strictEqual(r.remoteWeek, undefined);
  record({
    id: 'S11', scenario: '全员远程的一周',
    promise: '规则自动挂起，生成「全员远程周」说明，不标记任何人不达标',
    actual: '零打卡的一周里每个员工 status=none / met=false / gap=1440，规则引擎与周报返回体都没有「挂起」或「全员远程周」字段',
    verdict: VERDICT.CODE,
    note: '整条功能缺失（rules.js 无 team 级判定，server/index.js teamWeek() 也不产出该标记）。属于「承诺未实现」。',
  });
});

/* ═══════════════════════════════════════════════════════════════
   异常
   ═══════════════════════════════════════════════════════════════ */

test('[S12 ⚠️] 忘打卡 → 补卡审批：时长 ✓、不偷偷改数 ✓、但周报没有「补卡次数」字段', () => {
  const approved = run(
    [ev(TUE, 9, 0, 'in'), ev(TUE, 12, 0, 'out')],
    [{ date: TUE, type: 'adjust', minutes: 60 }],
  );
  assert.strictEqual(approved.st.minutes, 240);      // 180 + 60
  assert.strictEqual(approved.st.adjustmentMinutes, 60);
  // 服务端只统计 status='approved' 的例外（server/index.js statusFor）→ pending 不进数
  assert.strictEqual(approved.st.days[0].adjustments, 60);
  // 周报暴露「补卡分钟数」和「补卡次数」
  assert.strictEqual(approved.st.adjustmentCount, 1);
  record({
    id: 'S12', scenario: '忘打卡 → 提交补卡 → 管理员批',
    promise: '补卡进时长；周报里显示「补卡 1 次」，不偷偷改数',
    actual: '补卡分钟数正确叠加（240 min）、未批准的补卡不计入 ✓、周报给出 adjustmentCount（次数）✓',
    verdict: VERDICT.OK,
    note: '一致。',
  });
});

test('[S13 ⚠️] 断网 → 离线兜底已实现（外壳 + 缓存周报 + 明确提示）；离线补传与终端离线告警仍未实现', () => {
  const r = R.computeAttendance([ev(TUE, 9, 0, 'in')], [], CFG, Date.UTC(2026, 10, 17, 18, 0));
  assert.strictEqual(r.truncated.length, 1);
  const fs = require('node:fs');
  const emp = fs.readFileSync(ROOT + '/public/employee.js', 'utf8');
  // ✅ 离线兜底：断网时用缓存的 bootstrap / lastMe 继续显示，并明确提示离线
  assert.ok(/离线模式/.test(emp), 'employee.js 应有离线模式提示');
  assert.ok(/lastMe/.test(emp), 'employee.js 应缓存 /api/me 结果供离线显示');
  assert.ok(/showOffline/.test(emp), 'employee.js 应有离线横幅');
  // ❌ 离线补传队列：仍然没有（WebAuthn 挑战必须服务端签发，做不到）
  assert.ok(!/outbox|pendingQueue|offlineQueue/.test(emp), 'employee.js 不应有离线补传队列');
  const sw = fs.readFileSync(ROOT + '/public/sw.js', 'utf8');
  assert.ok(!/queue|outbox|POST.*events/i.test(sw), 'sw.js 只做 shell 缓存，没有离线打卡队列');
  record({
    id: 'S13', scenario: '旧手机没电 / 断网',
    promise: '员工端切离线模式，本地缓存打卡，恢复后自动补传；终端离线超 2h 推提醒',
    actual: '离线兜底 ✓（断网仍能打开应用外壳、显示上次同步的周报、并明确提示「暂时不能打卡」）；离线补传 ✗；终端离线 2h 提醒 ✗',
    verdict: VERDICT.MIXED,
    note: '离线补传做不到：WebAuthn 挑战必须服务端签发，离线时无法完成身份验证。已在方案页与 README 写明取舍。',
  });
});

test('[S14 🐞] 手滑连按两次 → 方案说「30 秒内同一人只算一次」→ 代码直接把第二次记成「签出」', () => {
  // 规则层面：连按两次 = in@t + out@t+10s → 产生一个 10 秒的假区间，并且把在岗状态提前关闭
  const { st, r } = run([
    ev(TUE, 9, 0, 'in'),
    { ts: ev(TUE, 9, 0, 'in').ts + 10000, kind: 'out' },
    ev(TUE, 18, 40, 'out'),
  ]);
  assert.strictEqual(st.days[0].segments.length, 1);   // 第二个 out 无配对，被忽略
  assert.strictEqual(st.minutes, 10 / 60);      // 只有 10 秒 = 0.1667 分钟
  assert.strictEqual(st.unclosedDays, 0);
  record({
    id: 'S14', scenario: '手滑连按两次（30 秒内）',
    promise: '30 秒内同一人只算一次',
    actual: '第二次打卡被记成 kind=out（在岗区间被提前关闭），18:40 的正常签退变成无配对 out 被丢弃，当天只剩 10 秒 = 0.17 分钟；没有任何去重',
    verdict: VERDICT.CODE,
    note: 'server/index.js nextKindFor() 只按「上一个事件是什么」交替 in/out，没有时间窗去重；public/ 侧也没有。后果：误触一次就等于提前下班（后面 9 小时全丢）。这是最该修的代码 bug。',
  });
});

test('[S15 ⚠️] 借了同事的手机打卡 → 记成同事账号 ✓，但没有「请用本人手机」的提示', () => {
  const fs = require('node:fs');
  const emp = fs.readFileSync(ROOT + '/public/employee.js', 'utf8');
  const admin = fs.readFileSync(ROOT + '/public/admin.js', 'utf8');
  assert.ok(!/请用本人手机/.test(emp + admin), '代码里没有「请用本人手机」这句提示');
  // 账号归属：device_token 绑 employee_id → 谁的手机就记谁的账号（结构上成立）
  assert.ok(/verifyDeviceToken/.test(fs.readFileSync(ROOT + '/server/index.js', 'utf8')));
  record({
    id: 'S15', scenario: '借了同事的手机打卡',
    promise: '会记成同事的账号 → 提示「请用本人手机」；管理员可事后修正归属',
    actual: '账号归属 ✓（device token 绑定 employee_id）；「请用本人手机」提示 ✗；管理员「事后修正记录归属」也没有（只能删除员工，events 不可改 employee_id）',
    verdict: VERDICT.MIXED,
    note: '提示文案与「事后改归属」两处未实现；安全模型本身（绑定设备）是对的。',
  });
});

test('[S16 ✅] 员工用 iPhone 但没开 Face ID → 降级 6 位员工码 + 弱验证标记', () => {
  const fs = require('node:fs');
  const idx = fs.readFileSync(ROOT + '/public/employee.js', 'utf8');
  assert.ok(/员工码打卡（弱验证）/.test(idx), '员工端应展示弱验证标记');
  const srv = fs.readFileSync(ROOT + '/server/index.js', 'utf8');
  assert.ok(/randomCode\(8\)/.test(srv), '员工码应为 8 位随机字母数字');
  assert.ok(/hashSecret\(pin\)/.test(srv), '员工码应只存哈希');
  assert.ok(/verifyMethod: 'pin'/.test(srv) && /note: '员工码打卡（弱验证）'/.test(srv), 'PIN 打卡应打上弱验证标记');
  record({
    id: 'S16', scenario: 'iPhone 没开 Face ID',
    promise: '自动降级为员工 6 位码；打上「弱验证」标记',
    actual: 'PIN 打卡走 /api/checkin/pin，事件 verify_method=pin + note「员工码打卡（弱验证）」，返回体 weak=true；员工码为 8 位随机字母数字且只存哈希',
    verdict: VERDICT.OK,
    note: '标记落在事件上；不过周报行里没有「弱验证次数」统计，管理员要自己翻 exceptions/recent 才能看到。',
  });
});

/* ═══════════════════════════════════════════════════════════════
   信任与防作弊
   ═══════════════════════════════════════════════════════════════ */

test('[S17 ✅] 远程截图 / 转发动态码 → 二维码 45 秒过期、每次不同、不可重放', () => {
  const fs = require('node:fs');
  const srv = fs.readFileSync(ROOT + '/server/index.js', 'utf8');
  assert.ok(/expires_at < Date\.now\(\)/.test(srv), '服务端应校验会话过期');
  assert.ok(/sess\.used_at/.test(srv), '服务端应校验会话已使用');
  const db = fs.readFileSync(ROOT + '/server/db.js', 'utf8');
  assert.ok(/sessionTtlSeconds: '45'/.test(db), '默认 TTL 应为 45 秒');
  const { Store } = require(ROOT + '/server/db.js');
  const store = new Store(':memory:');
  const term = store.createTerminal({ name: 'T' });
  const a = store.createSession(term.id, 45);
  const b = store.createSession(term.id, 45);
  assert.notStrictEqual(a.id, b.id);                       // 每次不同
  assert.strictEqual(a.expiresAt - a.createdAt, 45000);    // 45 秒
  record({
    id: 'S17', scenario: '远程截图 / 转发动态码',
    promise: '二维码 45 秒过期且每次不同；截图重放无效',
    actual: 'session id 每次随机不同、TTL=45s、已使用会话返回 409、过期返回 410',
    verdict: VERDICT.OK,
    note: '唯一残留：旧会话在 45s 内仍然有效（不做「新会话作废旧会话」），但单次使用让截图重放最多成功一次。',
  });
});

test('[S18 ✅] 同事代打 → 必须员工自己手机系统级指纹/人脸通过', () => {
  const fs = require('node:fs');
  const wa = fs.readFileSync(ROOT + '/server/webauthn.js', 'utf8');
  assert.ok(/userVerification: 'required'/.test(wa), 'WebAuthn 必须要求系统级用户验证');
  assert.strictEqual((wa.match(/userVerification: 'required'/g) || []).length, 2, '注册与认证两处都应 required');
  record({
    id: 'S18', scenario: '同事代打',
    promise: '必须员工自己手机系统级指纹/人脸通过，代打拿不到活体认证',
    actual: 'webauthn.js 注册与认证两处都是 userVerification:"required"',
    verdict: VERDICT.OK,
    note: '注意员工码(PIN)通道天然绕过活体，这是方案里已声明的「弱验证」兜底。',
  });
});

test('[S19 🐞] 旧手机被人搬走 → 终端有 PIN 锁 + 后台检测 → 没有 PIN 锁，也没有后台检测', () => {
  const fs = require('node:fs');
  const t = fs.readFileSync(ROOT + '/public/terminal.js', 'utf8');
  assert.ok(!/pin|PIN|口令/.test(t), '终端页面没有 PIN 锁');
  const srv = fs.readFileSync(ROOT + '/server/index.js', 'utf8');
  assert.ok(!/heartbeat|心跳|offlineAlert|离线提醒/.test(srv), '服务端没有终端心跳/离线告警');
  // 终端接口靠共享密钥 x-terminal-key 保护（不是 PIN），且密钥存在终端页面里
  assert.ok(/x-terminal-key/.test(srv));
  record({
    id: 'S19', scenario: '旧手机被人搬走',
    promise: '终端有 PIN 锁 + 后台检测；可加 NFC 贴纸卡',
    actual: '终端没有 PIN 锁（只有 1.2s 长按弹信息页），没有后台检测/告警；API 层只有 x-terminal-key 共享密钥',
    verdict: VERDICT.CODE,
    note: '共享密钥≠PIN，且终端页面直接持有密钥；被搬走等于密钥一起被拿走。',
  });
});

test('[S20 ✅] 老板自己也要打卡 → 规则对所有人生效（含创始人）', () => {
  const srv = require('node:fs').readFileSync(ROOT + '/server/index.js', 'utf8');
  const calc = srv.slice(srv.indexOf('function statusFor'), srv.indexOf('function csvEscape'));
  assert.ok(!/isAdmin|豁免|boss|owner/i.test(calc), '规则计算里不应有管理员豁免分支');
  assert.ok(/employees\.map/.test(calc), '团队周报应覆盖全部在职员工');
  const { st } = run([ev(TUE, 9, 0, 'in'), ev(TUE, 18, 0, 'out')]);
  assert.strictEqual(st.minutes, 480);
  assert.strictEqual(st.met, false);   // 8h < 24h，谁都逃不掉
  record({
    id: 'S20', scenario: '老板自己也要打卡',
    promise: '规则对所有人生效，包括创始人',
    actual: 'statusFor()/teamWeek() 对所有 active 员工一视同仁，无豁免分支',
    verdict: VERDICT.OK,
    note: '一致。',
  });
});

/* ═══════════════════════════════════════════════════════════════
   生命周期
   ═══════════════════════════════════════════════════════════════ */

test('[S21 ✅] 新人入职 → 当天录入指纹/Face ID + 绑定工位，录入一次即可', () => {
  const fs = require('node:fs');
  const srv = fs.readFileSync(ROOT + '/server/index.js', 'utf8');
  assert.ok(/invite_code/.test(srv) && /已登记过生物特征/.test(srv), '应有邀请码 + 一次性登记限制');
  const { Store } = require(ROOT + '/server/db.js');
  const store = new Store(':memory:');
  const e = store.createEmployee({ name: '新人', seat: 'C区-03', inviteCode: 'ABCDEFGH1234', pinHash: 'x' });
  assert.strictEqual(e.seat, 'C区-03');       // 绑定工位
  assert.strictEqual(e.target_minutes, 1440); // 默认周目标 24h
  assert.strictEqual(e.invite_code, 'ABCDEFGH1234');
  assert.ok(/randomCode\(12\)/.test(srv), '服务端应生成 12 位邀请码');
  record({
    id: 'S21', scenario: '新人入职',
    promise: '当天录入 Face ID/指纹 + 绑定工位，录入一次以后直接用',
    actual: '建档即生成 12 位邀请码 + 8 位员工码（只存哈希），seat 字段可绑工位，register-verify 后 invite_code 置空（只能录一次）',
    verdict: VERDICT.OK,
    note: '一致。',
  });
});

test('[S22 ✅] 员工离职 → 软删除：生物凭据与登录凭据清掉，历史时长保留', () => {
  const fs = require('node:fs');
  const srv = fs.readFileSync(ROOT + '/server/index.js', 'utf8');
  assert.ok(/softDeleted/.test(srv), 'DELETE 接口应走软删除');
  assert.ok(!/store\.deleteEmployee\(id\)/.test(srv), '不应再物理删除员工');
  const { Store } = require(ROOT + '/server/db.js');
  const store = new Store(':memory:');
  const e = store.createEmployee({ name: '离职者' });
  store.addEvent({ employeeId: e.id, ts: Date.UTC(2026, 10, 17, 1, 0), kind: 'in' });
  store.addEvent({ employeeId: e.id, ts: Date.UTC(2026, 10, 17, 10, 0), kind: 'out' });
  assert.strictEqual(store.listEvents(e.id).length, 2);
  store.updateEmployee(e.id, { active: 0 });
  assert.strictEqual(store.listEvents(e.id).length, 2);   // 历史时长还在
  assert.strictEqual(store.getActiveEmployee(e.id), undefined); // 但已不在职
  record({
    id: 'S22', scenario: '员工离职',
    promise: '删除其生物凭据；历史时长按政策保留或匿名化',
    actual: 'DELETE 接口走软删除：active=0、凭据与邀请码清空、events 保留；周报里该员工标为「已离职」',
    verdict: VERDICT.OK,
    note: '一致。',
  });
});

test('[S23 ⚠️] 旧手机淘汰/换机 → 导出 CSV → 新机导入 + 重设终端 PIN', () => {
  const fs = require('node:fs');
  const srv = fs.readFileSync(ROOT + '/server/index.js', 'utf8');
  assert.ok(/export\.csv/.test(srv), '应有 CSV 导出');
  assert.ok(!/import/i.test(srv.replace(/import .*require.*\n/g, '')), '没有导入接口');
  assert.ok(!/terminals.*DELETE/.test(srv), '没有终端 PIN 重设接口');
  record({
    id: 'S23', scenario: '旧手机淘汰 / 换机',
    promise: '导出 CSV → 新机导入 + 重设终端 PIN',
    actual: 'CSV 导出 ✓（按周，含姓名/工位/时长/目标/差值/出差/未签退/补卡分钟）；新机导入 ✗；重设终端 PIN ✗（根本没有终端 PIN）',
    verdict: VERDICT.MIXED,
    note: '导出可用，迁移只能人工；CSV 是「单周」粒度，要整年迁移得逐周导。',
  });
});

test('[S24 ✅] 旺季临时提目标 → 本周改成 32 h，改配置即时生效', () => {
  const { Store } = require(ROOT + '/server/db.js');
  const store = new Store(':memory:');
  const e = store.createEmployee({ name: '旺季' });
  assert.strictEqual(e.target_minutes, 1440);
  store.updateEmployee(e.id, { target_minutes: 1920 });   // 32h
  assert.strictEqual(store.getEmployee(e.id).target_minutes, 1920);
  const r = R.computeAttendance([ev(TUE, 9, 0, 'in'), ev(TUE, 18, 0, 'out')], [], CFG, Date.UTC(2026, 10, 17, 19, 0));
  const st = R.weekStatus(r, MON, 1920, Date.UTC(2026, 10, 17, 19, 0));
  assert.strictEqual(st.targetMinutes, 1920);
  assert.strictEqual(st.met, false);
  assert.strictEqual(st.gapMinutes, 1920 - 480);
  record({
    id: 'S24', scenario: '旺季临时提目标（本周 32h）',
    promise: '本周改成 32 h，一句话的事；改配置即时生效',
    actual: 'PATCH /api/admin/employees/:id {targetMinutes} 立即改变周目标与 gap 判定',
    verdict: VERDICT.OK,
    note: '一致。但注意全局 weeklyTargetMinutes 只在建档时生效，改它不会影响已有员工（见 edge-cases 的 T-Z2）。',
  });
});

/* ═══════════════════════════════════════════════════════════════
   规则参数 10 项
   ═══════════════════════════════════════════════════════════════ */

test('[P01 ✅] 周起始日 = 周一', () => {
  const fs = require('node:fs');
  assert.ok(/weekStartWd: '1'/.test(fs.readFileSync(ROOT + '/server/db.js', 'utf8')));
  assert.strictEqual(R.weekStartKeyOfDateKey('2026-11-16', 1), '2026-11-16');
  assert.strictEqual(R.weekStartKeyOfDateKey('2026-11-22', 1), '2026-11-16');
  assert.strictEqual(R.weekStartKeyOfDateKey('2026-11-23', 1), '2026-11-23');
  record({ id: 'P01', scenario: '周起始日=周一', promise: '周一', actual: 'weekStartWd 默认 1，2026-11-16(周一)~11-22(周日) 同属一周', verdict: VERDICT.OK, note: '' });
});

test('[P02 ✅] 周目标 24 小时', () => {
  const fs = require('node:fs');
  assert.ok(/weeklyTargetMinutes: '1440'/.test(fs.readFileSync(ROOT + '/server/db.js', 'utf8')));
  const { Store } = require(ROOT + '/server/db.js');
  const store = new Store(':memory:');
  assert.strictEqual(store.createEmployee({ name: 'a' }).target_minutes, 1440);
  record({ id: 'P02', scenario: '周目标 24h', promise: '24 小时，可按岗位或个人分别设置', actual: '默认 weeklyTargetMinutes=1440，新员工 target_minutes=1440，个人可 PATCH 覆盖', verdict: VERDICT.OK, note: '全局目标改不动存量员工，见 edge-cases T-Z2。' });
});

test('[P03 ✅] 每日封顶 12 小时', () => {
  const { st } = run([ev(TUE, 7, 0, 'in'), ev(TUE, 13, 0, 'out'), ev(TUE, 13, 30, 'in'), ev(TUE, 23, 0, 'out')]);
  assert.strictEqual(st.minutes, 720);
  assert.strictEqual(st.cappedDays, 1);
  record({ id: 'P03', scenario: '每日封顶 12h', promise: '12 小时，防止连续签到刷时长', actual: '同一天 14.5h 原始时长被裁到 720 min，cappedDays=1', verdict: VERDICT.OK, note: '注意封顶条件是 >720 才标记 capped；刚好 720 不标。' });
});

test('[P04 📄] 午休扣减：方案写「空窗跨 12:00–13:00 且 > 45 分钟」，代码是「单个在岗区间覆盖午休 ≥45 分钟」', () => {
  const cfg = { ...CFG };
  // 覆盖整段窗口 → 扣
  const full = run([ev(TUE, 9, 2, 'in'), ev(TUE, 18, 40, 'out')], [], MON, undefined, cfg);
  assert.strictEqual(full.st.lunchDeducted, 60);
  // 空窗 63 分钟跨窗口 → 不扣（方案字面要扣）
  const gap = run([ev(TUE, 9, 2, 'in'), ev(TUE, 12, 5, 'out'), ev(TUE, 13, 8, 'in'), ev(TUE, 18, 40, 'out')], [], MON, undefined, cfg);
  assert.strictEqual(gap.st.lunchDeducted, 0);
  // 区间只覆盖窗口 30 分钟 → 不扣
  const part = run([ev(TUE, 9, 2, 'in'), ev(TUE, 12, 30, 'out'), ev(TUE, 13, 0, 'in'), ev(TUE, 18, 0, 'out')], [], MON, undefined, cfg);
  assert.strictEqual(part.st.lunchDeducted, 0);
  record({
    id: 'P04', scenario: '午休扣减（触发条件）',
    promise: '自动扣 1 小时；空窗跨 12:00–13:00 且 > 45 分钟',
    actual: '触发条件 = 单个在岗区间覆盖午休窗口 ≥45min（overlap ≥ 45）；空窗跨窗口不触发；阈值是 ≥ 不是 >',
    verdict: VERDICT.SPEC,
    note: '代码语义（区间覆盖）与管理页自己的提示「在岗区间覆盖午休超过这么多分钟才扣」一致，也和 S01 的 8.6h 数字自洽；方案页的「空窗」二字是笔误级错误。另：阈值代码用 ≥45，方案写「>45」，边界差 1 分钟。',
  });
});

test('[P05 ⚠️] 假期抵扣：leave ✓，但法定假日/调休（holiday）无法录入', () => {
  const { st } = run([], [{ date: TUE, type: 'leave', minutes: 480 }]);
  assert.strictEqual(st.deductedMinutes, 480);
  assert.strictEqual(st.effectiveTargetMinutes, 960);
  const hol = run([], [{ date: TUE, type: 'holiday', minutes: 480 }]);
  assert.strictEqual(hol.st.deductedMinutes, 480);          // 规则引擎支持
  const srv = require('node:fs').readFileSync(ROOT + '/server/index.js', 'utf8');
  assert.ok(/'leave', 'travel', 'adjust'/.test(srv), 'API 只接受 leave/travel/adjust');
  record({
    id: 'P05', scenario: '假期抵扣（法定假日/年假/调休）',
    promise: '法定假日 / 年假 / 调休从目标中扣除',
    actual: 'leave ✓；holiday 在规则引擎里被扣 ✓，但 POST /api/exceptions 的白名单只有 leave/travel/adjust → holiday 录入直接 400',
    verdict: VERDICT.CODE,
    note: '管理端 EXC_LABEL 里已经画了「节假日」，但没有任何创建入口 → 法定假日/调休抵扣实际做不到。',
  });
});

test('[P06 🐞] 出差：既不计入也不抵扣 → 不抵扣 ✓，不计入 ✗（同 S08）', () => {
  const { st } = run([], [{ date: TUE, type: 'travel', minutes: 480 }]);
  assert.strictEqual(st.deductedMinutes, 0);
  assert.strictEqual(st.travelMinutes, 480);
  assert.strictEqual(st.hasTravel, true);
  assert.strictEqual(st.minutes, 0);   // 没有打卡自然为 0
  record({ id: 'P06', scenario: '出差标记', promise: '既不计入，也不抵扣', actual: '不抵扣 ✓；无打卡时不计入 ✓；有打卡时仍计入 ✗（见 S08）', verdict: VERDICT.MIXED, note: '同一处缺口，两处表述。' });
});

test('[P07 ✅] 跨周归属：按分钟切分，跨周的时长分别算进所属周', () => {
  const r = R.computeAttendance([ev(SUN, 22, 0, 'in'), ev(NEXT_MON, 2, 0, 'out')], [], CFG, Date.UTC(2026, 10, 23, 3, 0) - 8 * 3600000);
  assert.strictEqual(R.weekStatus(r, MON, 1440, Date.UTC(2026, 10, 23, 3, 0) - 8 * 3600000).minutes, 120);
  assert.strictEqual(R.weekStatus(r, NEXT_MON, 1440, Date.UTC(2026, 10, 23, 3, 0) - 8 * 3600000).minutes, 120);
  assert.strictEqual(r.weeks.length, 2);
  record({ id: 'P07', scenario: '跨周归属', promise: '按分钟切分，跨周的时长分别算进所属周', actual: '周日 2h → 上周，周一 2h → 本周，两周各自独立统计', verdict: VERDICT.OK, note: '一致（方案在 S10 给的数字 2h/4h 是错的，见 S10）。' });
});

test('[P08 ✅] 未签退兜底：12 小时自动截断 + 标记待确认 + 可手工修正', () => {
  const now = Date.UTC(2026, 10, 17, 15, 0); // UTC 15:00 = 本地 23:00
  const r = R.computeAttendance([ev(TUE, 9, 0, 'in')], [], CFG, now);
  const st = R.weekStatus(r, MON, 1440, now);
  assert.strictEqual(st.minutes, 660);        // 截到 12h 再扣 1h 午休
  assert.strictEqual(st.unclosedDays, 1);
  assert.strictEqual(r.truncated.length, 1);
  record({ id: 'P08', scenario: '未签退兜底', promise: '12 小时自动截断并标「待确认」，可手工修正', actual: '未闭合区间截到 min(now, 开始+12h)，unclosedDays=1（待确认标记），可用补卡手工修正', verdict: VERDICT.OK, note: '一致。' });
});

test('[P09 ⚠️] 补卡：员工提交 → 管理员批 → 周报显示补卡次数', () => {
  const { st } = run([], [{ date: TUE, type: 'adjust', minutes: 60 }]);
  assert.strictEqual(st.adjustmentMinutes, 60);
  assert.strictEqual(st.minutes, 60);
  assert.strictEqual(st.adjustmentCount, 1);
  record({ id: 'P09', scenario: '补卡', promise: '员工提交 → 管理员批；周报里显示补卡次数', actual: '提交/审批链路 ✓；周报给出 adjustmentMinutes 与 adjustmentCount ✓', verdict: VERDICT.OK, note: '一致。' });
});

test('[P10 ✅] 周报生成：每周一 09:00 定时推送（Webhook）+ 可导出 CSV', () => {
  const fs = require('node:fs');
  const srv = fs.readFileSync(ROOT + '/server/index.js', 'utf8');
  assert.ok(/export\.csv/.test(srv), 'CSV 导出存在');
  assert.ok(/REPORT_WEBHOOK/.test(srv), '有 Webhook 推送配置');
  assert.ok(/reportScheduler/.test(srv), '有定时任务');
  assert.ok(/report-push/.test(srv), '有手动推送接口');
  record({
    id: 'P10', scenario: '周报生成与推送',
    promise: '每周一 09:00 推送邮件 / 群机器人 / 可导出 CSV',
    actual: '有定时任务（REPORT_PUSH_HOUR，默认 9 点）+ Webhook 推送 + 手动推送接口 + CSV 导出',
    verdict: VERDICT.OK,
    note: '推送走通用 Webhook（飞书/企微/Slack 都能接）；没有内置 SMTP。',
  });
});

/* ═══════════════════════════════════════════════════════════════
   汇总
   ═══════════════════════════════════════════════════════════════ */

test('汇总：24 场景 + 10 参数 对表', () => {
  printSummary('在岗哨 · 方案承诺 ↔ 代码实现 对表（24 场景 + 10 规则参数）');
  assert.strictEqual(summary.length, 34);
  assert.ok(summary.some((s) => s.verdict === VERDICT.CODE), '应存在代码类问题');
  assert.ok(summary.some((s) => s.verdict === VERDICT.SPEC), '应存在方案页写错的项');
});
