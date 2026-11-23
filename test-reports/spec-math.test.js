'use strict';
/**
 * 在岗哨 · 方案页自身的算术自洽性检查
 *
 * 这些用例不测代码，只测「方案页写的数字自己算不算得通」——
 * 用来给报告里「方案页写错了」这一类结论提供可复现的证据。
 */

const test = require('node:test');
const assert = require('node:assert');
const { R, CFG, ev, toH, VERDICT, record, printSummary, summary } = require('./_helpers.js');

const TUE = '2026-11-17';
const SUN = '2026-11-22';
const NEXT_MON = '2026-11-23';
const MON = '2026-11-16';

/* ── 方案页第 3 节时间轴：09:02 签进 / 12:05 签出 / 13:08 签进 / 18:40 签出 ── */

test('[M-01 📄] 时间轴「上午在岗 3.03 h」算错了，应为 3.05 h；且 3.03+5.53=8.56≠8.58', () => {
  const morning = 9 * 60 + 2, lunchOut = 12 * 60 + 5, lunchIn = 13 * 60 + 8, evening = 18 * 60 + 40;
  const m1 = lunchOut - morning;        // 183
  const gap = lunchIn - lunchOut;       // 63
  const m2 = evening - lunchIn;         // 332
  assert.strictEqual(m1, 183);
  assert.strictEqual(gap, 63);
  assert.strictEqual(m2, 332);
  assert.strictEqual(toH(m1), 3.05, '183 分 = 3.05 h，不是 3.03');
  assert.strictEqual(toH(gap), 1.05, '63 分 = 1.05 h ✓');
  assert.strictEqual(toH(m2), 5.53, '332 分 = 5.53 h ✓');
  assert.strictEqual(toH(m1 + m2), 8.58, '合计 515 分 = 8.58 h ✓');
  // 方案页自带的三个数字自相矛盾
  assert.notStrictEqual(3.03 + 5.53, 8.58);
  record({
    id: 'M-01', scenario: '方案页时间轴的四个数字',
    promise: '上午在岗 3.03 h / 午休空窗 1.05 h / 下午在岗 5.53 h / 当日净在岗 8.58 h',
    actual: '真实值：3.05 / 1.05 / 5.53 / 8.58（只有「上午在岗 3.03」错；3.03+5.53=8.56 与标注的 8.58 对不上）',
    verdict: VERDICT.SPEC,
    note: '改「3.03 h」→「3.05 h」即可自洽。',
  });
});

test('[M-02 📄] 时间轴图的几何也对不上：最后一个点画在 94.66% ≈ 18:28，标签写 18:40', () => {
  // 轴：09:00 → 19:00 共 600 分钟；94.66% ≈ 568 分钟 → 09:00+568 = 18:28
  const minutes = 0.9466 * 600;
  const hh = Math.floor(9 + minutes / 60);
  const mm = Math.round(minutes % 60);
  assert.strictEqual(`${hh}:${String(mm).padStart(2, '0')}`, '18:28');
  assert.notStrictEqual('18:28', '18:40');
  record({
    id: 'M-02', scenario: '时间轴 SVG 几何',
    promise: '最后一个点在 18:40（= 96.67%），末段宽度应为 332/600 = 55.33%',
    actual: '实际画的是 left:94.66% / width:53.3% → 末端落在 18:28，比标注早 12 分钟',
    verdict: VERDICT.SPEC,
    note: '纯视觉误差，不影响数值结论。',
  });
});

test('[M-03 📄] 方案页脚注与自己的时间轴互相矛盾：按脚注，午休扣减开启时那天应是 7.58 h', () => {
  // 方案脚注：「如果开启「午休自动扣减」，且空窗跨过 12:00–13:00 且超过 45 分钟，再自动扣 1 小时」
  const gap = 13 * 60 + 8 - (12 * 60 + 5); // 63 分钟空窗，跨过 12:00–13:00
  assert.ok(gap > 45 && gap >= 60, '空窗 63 分钟，满足脚注的触发条件');
  const raw = (12 * 60 + 5 - (9 * 60 + 2)) + (18 * 60 + 40 - (13 * 60 + 8)); // 515
  assert.strictEqual(raw, 515);
  assert.strictEqual(toH(raw - 60), 7.58, '按脚注字面 → 455 分 = 7.58 h');
  assert.strictEqual(toH(raw), 8.58, '而图上标注的是 8.58 h');
  // 代码（区间覆盖语义）给的是 515 分
  const r = R.computeAttendance([
    ev(TUE, 9, 2, 'in'), ev(TUE, 12, 5, 'out'),
    ev(TUE, 13, 8, 'in'), ev(TUE, 18, 40, 'out'),
  ], [], CFG, Date.UTC(2026, 10, 17, 11, 0) - 8 * 3600000);
  assert.strictEqual(r.weeks[0].minutes, 515);
  record({
    id: 'M-03', scenario: '时间轴脚注 vs 时间轴数值',
    promise: '脚注：空窗跨 12:00–13:00 且 >45 分钟就再扣 1 小时；图上：当日净在岗 8.58 h',
    actual: '按脚注字面执行 → 7.58 h；按图上数值 → 8.58 h；代码（区间覆盖语义）→ 515 分 = 8.58 h',
    verdict: VERDICT.SPEC,
    note: '方案页内部打架。结合 S01「标准到岗 8.6 h」和 S02 的「再减 1h」只能二选一；代码选了与 8.6h 自洽的那一套（区间覆盖）。',
  });
});

test('[M-04 📄] 跨周场景「2 h 算上周，4 h 算本周」= 6h，但 22:00→02:00 只有 4h', () => {
  const shift = (2 * 60 + 24 * 60) - (22 * 60); // 次日 02:00 − 当日 22:00
  assert.strictEqual(shift, 240);
  assert.strictEqual(shift / 60, 4);
  assert.strictEqual(2 + 4, 6);
  assert.notStrictEqual(2 + 4, shift / 60);
  record({
    id: 'M-04', scenario: '跨周值班场景的数字',
    promise: '2 h 算上周，4 h 算本周',
    actual: '整班只有 4 小时；代码算「上周 2h + 本周 2h」= 4h',
    verdict: VERDICT.SPEC,
    note: '方案页应写「2 h 算上周，2 h 算本周」。',
  });
});

test('[M-05 📄] 「请假 1 天 → 目标 21 h」里的 3 小时抵扣推导不出来', () => {
  // 方案：24h 目标，请假 1 天 → 21h，即抵扣 3h
  assert.strictEqual(24 - 21, 3);
  // 任何自然口径都推不出 3h：
  assert.strictEqual(24 / 5, 4.8);        // 5 天工作日摊到每周 24h → 每天 4.8h
  assert.strictEqual(24 - 24 / 5, 19.2);
  assert.strictEqual(24 - 8, 16);         // 请假 8h
  assert.strictEqual(24 - 12, 12);        // 请假一个封顶日 12h
  assert.strictEqual(24 - 24, 0);         // 请假 24h
  record({
    id: 'M-05', scenario: '请假 1 天的抵扣口径',
    promise: '请假 1 天 → 本周目标自动降到 21 h',
    actual: '3h 的抵扣无出处（4.8h/天→19.2h、8h→16h、12h→12h、24h→0h）；系统按「填几分钟扣几分钟」',
    verdict: VERDICT.SPEC,
    note: '方案应改写成「请假 N 小时 → 目标 −N 小时」，并规定「1 天」等于几小时。',
  });
});

test('[M-06 📄] 「加班到 21:00 → 12.0h（触顶）」需要 08:00 前到岗，方案没说起点', () => {
  const raw = (21 * 60) - (9 * 60 + 2);   // 09:02 → 21:00
  assert.strictEqual(raw, 718);
  assert.strictEqual(raw - 60, 658);      // 扣 1h 午休
  assert.strictEqual(toH(raw - 60), 10.97);
  // 08:00 上班 → 780 − 60 = 720（正好 12h，但不算「触顶」）
  assert.strictEqual((21 * 60 - 8 * 60) - 60, 720);
  // 07:59 上班 → 781 − 60 = 721 > 720 → 被裁到 720，才是真正的「触顶」
  assert.ok((21 * 60 - (7 * 60 + 59)) - 60 > 720);
  record({
    id: 'M-06', scenario: '加班到 21:00 的触顶前提',
    promise: '当天计 12.0 h（触顶）',
    actual: '按 09:02 签进 → 10.97 h，未触顶；08:00 签进 → 正好 12.0h（不标触顶）；07:59 前签进 → 才触顶',
    verdict: VERDICT.SPEC,
    note: '方案补一句起始时间，或改成「按 9:02 上班口径是 10.9 h」。',
  });
});

test('[M-07 ✅] 周报 bench 图自身是自洽的（比例尺 30h）', () => {
  const rows = [
    { name: '张三', hours: 27.5, barPct: 91.6 },
    { name: '李四', hours: 24.0, barPct: 80 },
    { name: '王五', hours: 19.5, barPct: 65 },
    { name: '赵六', hours: 12.0, barPct: 40 },
    { name: '孙七', hours: 26.5, barPct: 88.3 },
  ];
  const SCALE = 30; // 目标线 80% = 24h → 满宽 = 30h
  for (const r of rows) {
    assert.ok(Math.abs((r.hours / SCALE) * 100 - r.barPct) < 0.1, `${r.name} 比例不对`);
  }
  assert.strictEqual((24 / SCALE) * 100, 80, '目标线 80% ✓');
  const total = rows.reduce((a, r) => a + r.hours, 0);
  assert.strictEqual(total, 109.5, '团队合计 109.5h ✓');
  const met = rows.filter((r) => r.hours >= 24).length;
  assert.strictEqual(met, 3, '达标 3/5 ✓');
  assert.strictEqual(24 - 19.5, 4.5, '王五差 4.5h ✓');
  record({
    id: 'M-07', scenario: '周报 bench 图 / 推送卡片',
    promise: '张三 27.5 / 李四 24.0 / 王五 19.5 / 赵六 12.0 / 孙七 26.5；团队合计 109.5h；达标 3/5；王五差 4.5',
    actual: '全部自洽（比例尺 30h、目标线 80%）；赵六标注「本周有 2 天出差（既不计入也不抵扣）」——「不计入」与实现不符（见 S08）',
    verdict: VERDICT.OK,
    note: '图表数字本身没问题；只有「出差不计入」这句与实现冲突。',
  });
});

test('汇总：方案页算术自洽性', () => {
  printSummary('方案页自身的数字校验');
  assert.ok(summary.length >= 7);
});
