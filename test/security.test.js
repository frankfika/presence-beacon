'use strict';
/**
 * 在岗哨 · 安全回归测试
 *
 * 独立实例（独立端口 + 独立数据库），不碰开发实例。
 * 覆盖安全审查中发现的高危/中危项的修复效果。
 *
 * 跑法：node test/security.test.js
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const PORT = 8121;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'sec-test-admin-pw';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-sec-'));
const DB_FILE = path.join(TMP, 'sec.db');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`); }
}

async function api(p, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { ...(opts.headers || {}) } };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  if (opts.token) init.headers['x-admin-token'] = opts.token;
  const res = await fetch(BASE + p, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}

async function waitReady(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DB_FILE,
      ADMIN_PASSWORD,
      RP_ID: 'localhost',
      APP_ORIGIN: BASE,
      TZ_OFFSET_MINUTES: '480',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', (d) => logs.push(d.toString()));
  server.stderr.on('data', (d) => logs.push(d.toString()));

  try {
    if (!await waitReady()) {
      console.error('服务没起来：', logs.join(''));
      process.exit(1);
    }

    const login = await api('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } });
    assert(login.ok, '管理员登录失败');
    const token = login.data.token;

    const emp = await api('/api/admin/employees', {
      method: 'POST', token, body: { name: '安全回归员工', seat: 'A区', targetMinutes: 1440 },
    });
    const term = await api('/api/admin/terminals', {
      method: 'POST', token, body: { name: '安全回归终端', location: '1楼' },
    });
    const empId = emp.data.employee.id;
    const inviteCode = emp.data.inviteCode;
    const pin = emp.data.pin;
    const termId = term.data.terminal.id;
    const termKey = term.data.secret;

    console.log('\n【1】爆破限流');

    // 员工码：连续错 8 次后应被锁
    let codes = [];
    for (let i = 0; i < 10; i++) {
      const r = await api('/api/checkin/pin', { method: 'POST', body: { employeeId: empId, pin: 'WRONGP1N' } });
      codes.push(r.status);
    }
    check('员工码连续错误后触发限流（429）', codes.includes(429), codes);

    // 伪造 XFF 不能绕过限流
    const spoof = [];
    for (let i = 0; i < 6; i++) {
      const r = await api('/api/checkin/pin', {
        method: 'POST',
        headers: { 'X-Forwarded-For': `10.0.0.${i + 1}` },
        body: { employeeId: empId, pin: 'WRONGP1N' },
      });
      spoof.push(r.status);
    }
    check('伪造 X-Forwarded-For 无法绕过限流', !spoof.includes(200), spoof);

    // 邀请码
    let icodes = [];
    for (let i = 0; i < 10; i++) {
      const r = await api('/api/auth/register-options', {
        method: 'POST', body: { employeeId: empId, inviteCode: 'BADSCODE12' },
      });
      icodes.push(r.status);
    }
    check('邀请码连续错误后触发限流（429）', icodes.includes(429), icodes);

    // 管理员登录
    let acodes = [];
    for (let i = 0; i < 7; i++) {
      const r = await api('/api/admin/login', { method: 'POST', body: { password: 'wrong-password' } });
      acodes.push(r.status);
    }
    check('管理员登录连续错误后触发限流（429）', acodes.includes(429), acodes);

    console.log('\n【2】越权与状态');

    // 未登录访问管理端
    const noAuth = await api('/api/admin/overview');
    check('未登录访问管理 API → 401', noAuth.status === 401, noAuth.status);

    // 错误的管理 token
    const badToken = await api('/api/admin/overview', { token: 'x.y' });
    check('伪造管理员 token → 401', badToken.status === 401, badToken.status);

    // 终端密钥跨终端
    const other = await api('/api/admin/terminals', { method: 'POST', token, body: { name: '另一个终端' } });
    const cross = await api(`/api/terminal/${other.data.terminal.id}/state`, { headers: { 'x-terminal-key': termKey } });
    check('终端密钥不能操作别的终端 → 403', cross.status === 403, cross.status);

    // 停用员工不能打卡
    await api(`/api/admin/employees/${empId}`, { method: 'PATCH', token, body: { active: false } });
    const inactive = await api('/api/checkin/pin', { method: 'POST', body: { employeeId: empId, pin } });
    check('已停用员工不能用工��码打卡 → 403', inactive.status === 403, inactive.status);
    await api(`/api/admin/employees/${empId}`, { method: 'PATCH', token, body: { active: true } });

    // 员工存在性枚举（用一个没被限流的新员工，避免撞上前面锁掉的桶）
    const probe = await api('/api/admin/employees', {
      method: 'POST', token, body: { name: '枚举探针', seat: 'B区', targetMinutes: 1440 },
    });
    const probeId = probe.data.employee.id;
    const e1 = await api('/api/auth/register-options', { method: 'POST', body: { employeeId: probeId, inviteCode: 'NOPE' } });
    const e2 = await api('/api/auth/register-options', { method: 'POST', body: { employeeId: 'no-such-employee', inviteCode: 'NOPE' } });
    check('不存在的员工与错误邀请码返回同样的错误', e1.data.error === e2.data.error, { e1: e1.data.error, e2: e2.data.error });

    const p1 = await api('/api/checkin/pin', { method: 'POST', body: { employeeId: probeId, pin: 'NOPENOPE' } });
    const p2 = await api('/api/checkin/pin', { method: 'POST', body: { employeeId: 'no-such-employee', pin: 'NOPENOPE' } });
    check('员工码通道同样无法枚举员工', p1.data.error === p2.data.error, { p1: p1.data.error, p2: p2.data.error });

    console.log('\n【3】敏感数据不落明文');

    const dbBytes = fs.readFileSync(DB_FILE);
    const dbText = dbBytes.toString('latin1');
    check('数据库里没有管理员口令明文', !dbText.includes(ADMIN_PASSWORD));
    check('数据库里没有员工码明文', !dbText.includes(pin));
    check('数据库里没有终端密钥明文', !dbText.includes(termKey));

    const boot = await api('/api/bootstrap');
    check('bootstrap 不暴露 hasPin', !('hasPin' in (boot.data.employees[0] || {})));
    check('bootstrap 不暴露 targetMinutes', !('targetMinutes' in (boot.data.employees[0] || {})));
    check('bootstrap 不暴露终端密钥', !JSON.stringify(boot.data).includes(termKey));

    console.log('\n【4】注入与响应头');

    // CSV 公式注入
    const evil = await api('/api/admin/employees', {
      method: 'POST', token, body: { name: '=1+1', seat: "+cmd|' /C calc'!A0", targetMinutes: 1440 },
    });
    const csv = await fetch(`${BASE}/api/admin/export.csv`, { headers: { 'x-admin-token': token } });
    const csvText = await csv.text();
    const evilRow = csvText.split('\r\n').find((l) => l.includes('1+1') || l.includes('cmd')) || '';
    check('CSV 导出转义 Excel 公式注入', evilRow.includes("'"), evilRow);
    check('CSV 导出不会让公式裸奔', !/(^|,)"?[=+]/.test(evilRow), evilRow);
    void evil;

    // 安全响应头
    const pageRes = await fetch(`${BASE}/`);
    check('静态页面有 X-Frame-Options', pageRes.headers.get('x-frame-options') === 'DENY');
    check('静态页面有 CSP', !!pageRes.headers.get('content-security-policy'));
    check('静态页面有 nosniff', pageRes.headers.get('x-content-type-options') === 'nosniff');
    const apiRes = await fetch(`${BASE}/api/health`);
    check('API 响应也有安全头', apiRes.headers.get('x-frame-options') === 'DENY');

    // 内部错误不外泄
    const badJson = await fetch(`${BASE}/api/admin/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
      body: '{not json',
    });
    const badText = await badJson.text();
    check('畸形请求不会吐数据库内部错误', !/SQLite|constraint|node_modules/.test(badText), badText.slice(0, 160));

    console.log('\n【5】二维码与会话');

    const sess = await api(`/api/terminal/${termId}/session`, { method: 'POST', headers: { 'x-terminal-key': termKey } });
    check('终端会话码 8 位', /^[A-Z0-9]{8}$/.test(sess.data.sessionId), sess.data.sessionId);
    const replay = await api(`/api/terminal/${termId}/state`, { headers: { 'x-terminal-key': 'wrong-key' } });
    check('错误终端密钥 → 403', replay.status === 403);

    console.log('\n【6】离线路径');
    const health = await api('/api/health');
    check('健康检查可用', health.status === 200 && health.data.ok === true, health.data);
    check('健康检查能判断是否安全上下文', typeof health.data.secure === 'boolean', health.data);

    console.log('\n【7】备份脚本');
    const backupScript = path.join(__dirname, '..', 'scripts', 'backup.js');
    check('备份脚本存在', fs.existsSync(backupScript));
    check('README 说明了备份', fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').includes('npm run backup'));

    console.log('\n【8】启动日志不泄密');
    const allLogs = logs.join('');
    check('启动日志里没有管理员口令', !allLogs.includes(ADMIN_PASSWORD), allLogs.split('\n').filter((l) => l.includes('口令')).join(' | '));
    check('启动日志里提示了口令文件位置', allLogs.includes('.admin-password'));
  } catch (e) {
    console.error('\n测试崩溃：', e);
    failed++;
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    server.kill('SIGKILL');
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n═══════════════════════════════`);
  console.log(`通过 ${passed} · 失败 ${failed}`);
  console.log(`═══════════════════════════════`);
  process.exit(failed ? 1 : 0);
})();
