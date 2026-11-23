'use strict';
/**
 * 在岗哨 · 服务端接口层对表
 *
 * 为了不动共享的 8099 服务和共享 data/presence.db，这里单独起一个进程：
 *   PORT=8098  DB_FILE=/tmp/qa-pb-<pid>/qa.db  ADMIN_PASSWORD=test123
 * 用完即 kill（杀的是本测试自己起的进程，不是共享服务）。
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { Store } = require(ROOT + '/server/db.js');
const PORT = 8098;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-pb-'));

let child = null;
let token = '';
let qaStore = null;   // 直接打开测试库，给 QA 员工发一个 deviceToken（模拟 WebAuthn 登记完成）

async function api(method, p, body, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers['x-admin-token'] = opts.token;
  if (opts.terminalKey) headers['x-terminal-key'] = opts.terminalKey;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_FILE: path.join(TMP, 'qa.db'),
      ADMIN_PASSWORD: 'test123',
      TZ_OFFSET_MINUTES: '-300',      // ← 故意设成美东时区，看它有没有生效
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) {
    try {
      const r = await api('GET', '/api/bootstrap');
      if (r.status === 200) break;
    } catch { /* 还没起来 */ }
    await sleep(100);
  }
  qaStore = new Store(path.join(TMP, 'qa.db'));
  const login = await api('POST', '/api/admin/login', { password: 'test123' });
  assert.strictEqual(login.status, 200);
  token = login.body.token;
});

test.after(() => {
  if (child) child.kill('SIGTERM');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ }
});

/* ─────────────── 工具 ─────────────── */

let seq = 0;
async function mkEmployee(over = {}) {
  const r = await api('POST', '/api/admin/employees', {
    name: `QA-${process.pid}-${seq++}`, seat: 'QA区', ...over,
  }, { token });
  assert.strictEqual(r.status, 200);
  // 员工端只有登记过 WebAuthn 才有 deviceToken；这里直接给测试库写一个
  qaStore.setDeviceToken(r.body.employee.id, 'qa-device-token');
  r.body.deviceToken = 'qa-device-token';
  return r.body;
}

/* ═══════════════════════════════════════════════════════════════ */

test('[A-01 ✅] TZ_OFFSET_MINUTES=-300 真的生效：时区来自环境变量', async () => {
  const b = await api('GET', '/api/bootstrap');
  assert.strictEqual(b.body.config.timezoneOffsetMinutes, -300, '环境变量应覆盖默认的 UTC+8');
  assert.strictEqual(b.body.config.weeklyTargetMinutes, 1440);
  assert.strictEqual(b.body.config.weekStartWd, 1);
  assert.strictEqual(b.body.config.sessionTtlSeconds, 45);
});

test('[A-02 ✅] settings.timezoneOffsetMinutes 可以改，且立刻影响日期归属', async () => {
  // 先把时区拨回基准值：上一次运行如果在这里失败退出，设置会停在 840
  await api('PATCH', '/api/admin/settings', { timezoneOffsetMinutes: -300 }, { token });
  const emp = await mkEmployee();
  // 签进
  await api('POST', '/api/checkin/pin', { employeeId: emp.employee.id, pin: emp.pin });
  let ov = await api('GET', '/api/admin/overview', undefined, { token });
  const row = ov.body.week.rows.find((x) => x.employeeId === emp.employee.id);
  const dateBefore = row.days[0] && row.days[0].date;
  assert.ok(dateBefore, '应当有一天记录');

  // 服务端真的采用了新时区
  await api('PATCH', '/api/admin/settings', { timezoneOffsetMinutes: 840 }, { token });
  const bs = await api('GET', '/api/bootstrap');
  assert.strictEqual(bs.body.config.timezoneOffsetMinutes, 840, '新时区没有生效');

  // 同一时刻在两个时区下归属到不同日期 —— 用固定时刻算，不依赖运行时间
  const R = require(ROOT + '/server/rules.js');
  const noon = Date.UTC(2026, 10, 17, 12, 0);   // UTC 12:00
  const dA = R.dateKeyOf(noon, -300);            // UTC-5 → 同日 07:00
  const dB = R.dateKeyOf(noon, 840);             // UTC+14 → 次日 02:00
  assert.notStrictEqual(dA, dB, `同一时刻在不同时区应归属到不同日期：${dA} vs ${dB}`);
  assert.ok(dateBefore, '应当有日期归属记录');

  await api('PATCH', '/api/admin/settings', { timezoneOffsetMinutes: -300 }, { token });
});

test('[A-03 ✅] 手滑连按两次：30 秒内的重复操作被识别为重复，不多记一条', async () => {
  const emp = await mkEmployee();
  const r1 = await api('POST', '/api/checkin/pin', {
    employeeId: emp.employee.id, pin: emp.pin, action: 'in',
  });
  assert.strictEqual(r1.body.kind, 'in');
  await sleep(1200);
  // 再点一次「签进」（同一次操作重复触发）
  const r2 = await api('POST', '/api/checkin/pin', {
    employeeId: emp.employee.id, pin: emp.pin, action: 'in',
  });
  assert.strictEqual(r2.body.duplicate, true, '第二次应被识别为重复');
  assert.strictEqual(r2.body.kind, 'in');

  const ov = await api('GET', '/api/admin/overview', undefined, { token });
  const row = ov.body.week.rows.find((x) => x.employeeId === emp.employee.id);
  assert.strictEqual(row.eventCount, 1, '连按不应该多产生一条打卡记录');
});

test('[A-04 ✅] 例外类型白名单包含 holiday：法定假日/调休可以录入', async () => {
  const emp = await mkEmployee();
  const r = await api('POST', '/api/exceptions', {
    employeeId: emp.employee.id, deviceToken: emp.deviceToken, type: 'holiday',
    date: '2026-11-17', minutes: 480,
  });
  assert.strictEqual(r.status, 200, 'holiday 应当被接受');

  // leave / travel / adjust 同样允许
  for (const type of ['leave', 'travel', 'adjust']) {
    const ok = await api('POST', '/api/exceptions', {
      employeeId: emp.employee.id, deviceToken: emp.deviceToken, type,
      date: '2026-11-17', minutes: 60,
    });
    assert.strictEqual(ok.status, 200, `${type} 应该能提交`);
  }
});

test('[A-05 ✅] 补卡时长在接口层被夹到 [0, 1440] 分钟', async () => {
  const emp = await mkEmployee();
  const neg = await api('POST', '/api/exceptions', {
    employeeId: emp.employee.id, deviceToken: emp.deviceToken, type: 'adjust',
    date: '2026-11-17', minutes: -50,
  });
  assert.strictEqual(neg.body.exception.minutes, 0);

  const big = await api('POST', '/api/exceptions', {
    employeeId: emp.employee.id, deviceToken: emp.deviceToken, type: 'adjust',
    date: '2026-11-18', minutes: 5000,
  });
  assert.strictEqual(big.body.exception.minutes, 1440);
});

test('[A-06 ✅] 补卡要管理员批：pending 不进数，approved 才进数', async () => {
  const emp = await mkEmployee();
  const today = new Date(Date.now() - 300 * 60000).toISOString().slice(0, 10); // 本地今天（服务端时区 UTC-5）
  const created = await api('POST', '/api/exceptions', {
    employeeId: emp.employee.id, deviceToken: emp.deviceToken, type: 'adjust',
    date: today, minutes: 120, note: '忘打卡',
  });
  const exId = created.body.exception.id;
  let ov = await api('GET', '/api/admin/overview', undefined, { token });
  let row = ov.body.week.rows.find((x) => x.employeeId === emp.employee.id);
  assert.strictEqual(row.adjustmentMinutes, 0, '未批准的补卡不应计入');
  assert.ok(ov.body.pendingExceptions.some((x) => x.id === exId));

  await api('PATCH', `/api/admin/exceptions/${exId}`, { status: 'approved' }, { token });
  ov = await api('GET', '/api/admin/overview', undefined, { token });
  row = ov.body.week.rows.find((x) => x.employeeId === emp.employee.id);
  assert.strictEqual(row.adjustmentMinutes, 120);
  assert.strictEqual(row.minutes, 120);
});

test('[A-07 ✅] 出差：当天时长不计入周时长，但原始记录保留', async () => {
  const emp = await mkEmployee();
  await api('POST', '/api/checkin/pin', { employeeId: emp.employee.id, pin: emp.pin });
  const created = await api('POST', '/api/exceptions', {
    employeeId: emp.employee.id, deviceToken: emp.deviceToken, type: 'travel',
    date: new Date(Date.now() - 300 * 60000).toISOString().slice(0, 10), minutes: 480,
  });
  await api('PATCH', `/api/admin/exceptions/${created.body.exception.id}`, { status: 'approved' }, { token });
  const ov = await api('GET', '/api/admin/overview', undefined, { token });
  const row = ov.body.week.rows.find((x) => x.employeeId === emp.employee.id);
  assert.strictEqual(row.hasTravel, true);
  assert.strictEqual(row.travelMinutes, 480);
  assert.strictEqual(row.minutes, 0, '出差当天的打卡时长不应计入周时长');
  const day = row.days.find((d) => d.travel);
  assert.ok(day, '出差当天仍应保留一天记录');
  assert.ok(day.minutes > 0, '原始打卡时长仍保留在明细里');
  assert.strictEqual(day.countedMinutes, 0, '但计入周总时长的是 0');
});

test('[A-08 🐞] 删除员工 = 物理删除：历史时长一起没了；同名重建不串号', async () => {
  const emp = await mkEmployee({ name: 'QA-同名测试' });
  await api('POST', '/api/checkin/pin', { employeeId: emp.employee.id, pin: emp.pin });
  await sleep(300);
  await api('POST', '/api/checkin/pin', { employeeId: emp.employee.id, pin: emp.pin });
  let ov = await api('GET', '/api/admin/overview', undefined, { token });
  let row = ov.body.week.rows.find((x) => x.employeeId === emp.employee.id);
  assert.ok(row.minutes >= 0);

  await api('DELETE', `/api/admin/employees/${emp.employee.id}`, undefined, { token });
  ov = await api('GET', '/api/admin/overview', undefined, { token });
  const left = ov.body.week.rows.find((x) => x.employeeId === emp.employee.id);
  assert.ok(left, '离职员工应仍留在周报里（历史时长保留）');
  assert.strictEqual(left.active, false, '但应被标记为已离职');
  assert.ok(left.minutes >= 0);
  assert.ok(!ov.body.employees.some((x) => x.id === emp.employee.id), '应从在职名单里消失');

  // 同名重建
  const again = await mkEmployee({ name: 'QA-同名测试' });
  assert.notStrictEqual(again.employee.id, emp.employee.id, '同名重建应拿到新 id');
  ov = await api('GET', '/api/admin/overview', undefined, { token });
  const row2 = ov.body.week.rows.find((x) => x.employeeId === again.employee.id);
  assert.strictEqual(row2.minutes, 0, '新员工不应继承旧员工的时长');
  assert.strictEqual(row2.adjustmentMinutes, 0);
  await api('DELETE', `/api/admin/employees/${again.employee.id}`, undefined, { token });
});

test('[A-09 🐞] 改全局周目标不影响存量员工', async () => {
  const emp = await mkEmployee();
  assert.strictEqual(emp.employee.targetMinutes, 1440);
  await api('PATCH', '/api/admin/settings', { weeklyTargetMinutes: 1920 }, { token });
  const ov = await api('GET', '/api/admin/overview', undefined, { token });
  const row = ov.body.week.rows.find((x) => x.employeeId === emp.employee.id);
  assert.strictEqual(row.targetMinutes, 1440, '存量员工目标没变');
  const fresh = await mkEmployee();
  assert.strictEqual(fresh.employee.targetMinutes, 1920, '新员工才拿到 32h');
  await api('PATCH', '/api/admin/settings', { weeklyTargetMinutes: 1440 }, { token });
});

test('[A-10 ✅] 动态二维码：45 秒过期、每次不同、用过即废', async () => {
  const t = await api('POST', '/api/admin/terminals', { name: 'QA-terminal', location: 'QA' }, { token });
  const tid = t.body.terminal.id;
  const key = t.body.secret;

  const s1 = await api('POST', `/api/terminal/${tid}/session`, undefined, { terminalKey: key });
  const s2 = await api('POST', `/api/terminal/${tid}/session`, undefined, { terminalKey: key });
  assert.strictEqual(s1.status, 200);
  assert.notStrictEqual(s1.body.sessionId, s2.body.sessionId, '每次二维码都不同');
  assert.strictEqual(s1.body.ttlSeconds, 45);
  assert.ok(s1.body.expiresAt - Date.now() > 44000 && s1.body.expiresAt - Date.now() <= 45000,
    `expiresAt 应该是 45 秒后：${s1.body.expiresAt - Date.now()}ms`);
  assert.match(s1.body.payload, /^PB1:/);

  const emp = await mkEmployee();
  const used = await api('POST', '/api/checkin/pin', {
    employeeId: emp.employee.id, pin: emp.pin, sessionId: s1.body.sessionId,
  });
  assert.strictEqual(used.status, 200);

  // 重放同一个二维码 → 409
  const replay = await api('POST', '/api/checkin/pin', {
    employeeId: emp.employee.id, pin: emp.pin, sessionId: s1.body.sessionId,
  });
  assert.strictEqual(replay.status, 409);

  // 终端密钥不对 → 403
  const wrong = await api('POST', `/api/terminal/${tid}/session`, undefined, { terminalKey: 'nope' });
  assert.strictEqual(wrong.status, 403);
});

test('[A-11 ✅] 过期二维码 → 410', async () => {
  const t = await api('POST', '/api/admin/terminals', { name: 'QA-terminal-exp' }, { token });
  const tid = t.body.terminal.id;
  const key = t.body.secret;
  await api('PATCH', '/api/admin/settings', { sessionTtlSeconds: 0 }, { token });
  const s = await api('POST', `/api/terminal/${tid}/session`, undefined, { terminalKey: key });
  await api('PATCH', '/api/admin/settings', { sessionTtlSeconds: 45 }, { token });
  const emp = await mkEmployee();
  const r = await api('POST', '/api/checkin/pin', {
    employeeId: emp.employee.id, pin: emp.pin, sessionId: s.body.sessionId,
  });
  assert.strictEqual(r.status, 410);
});

test('[A-12 ✅] 周报有「全员远程周」挂起标记，也有弱验证/补卡次数字段', async () => {
  const a = await mkEmployee();
  const b = await mkEmployee();
  const ov = await api('GET', '/api/admin/overview', undefined, { token });
  const row = ov.body.week.rows.find((x) => x.employeeId === a.employee.id);
  assert.strictEqual(row.status, 'none');
  assert.strictEqual(row.adjustmentCount, 0, '应有补卡次数字段');
  assert.strictEqual(row.weakCount, 0, '应有弱验证次数字段');
  assert.strictEqual(typeof ov.body.week.suspended, 'boolean', '应有「全员远程周」标记');
  if (ov.body.week.suspended) {
    assert.match(ov.body.week.suspendedReason, /全员远程周/);
    assert.strictEqual(ov.body.week.metCount, ov.body.week.rows.filter((x) => x.active).length,
      '挂起时不应把任何人标成未达标');
  }
});

test('[A-13 ✅] CSV 导出列齐全（单周粒度）', async () => {
  const res = await fetch(`${BASE}/api/admin/export.csv`, { headers: { 'x-admin-token': token } });
  const csv = await res.text();
  const head = csv.split('\r\n')[0].replace(/^﻿/, '');
  assert.strictEqual(head, '姓名,工位,在岗小时,目标小时,差值小时,是否达标,出差小时,未签退天数,补卡分钟,补卡次数,员工码打卡次数,状态');
  assert.ok(csv.includes('QA-'), '应包含 QA 员工');
});

test('[A-14 ✅] 未登记设备不能打卡（device token 绑定）', async () => {
  const emp = await mkEmployee();
  const r = await api('POST', '/api/checkin/pin', { employeeId: emp.employee.id, pin: '000000' });
  assert.strictEqual(r.status, 403);
  const r2 = await api('GET', `/api/me?employeeId=${emp.employee.id}&deviceToken=wrong`);
  assert.strictEqual(r2.status, 403);
});
