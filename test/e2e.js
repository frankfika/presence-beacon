'use strict';
/**
 * 在岗哨 · 端到端测试
 *
 * 用 Chromium 的 CDP VirtualAuthenticator 模拟一台「有指纹的手机」，
 * 跑通真实的 WebAuthn 注册 → 扫码 → 指纹认证 → 打卡落库 → 周报 的完整链路。
 *
 * 跑法：先 npm start 起服务，再 node test/e2e.js
 */
const { chromium } = require('/usr/local/lib/node_modules/playwright');

const BASE = process.env.BASE || 'http://localhost:8099';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test123';

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ' → ' + JSON.stringify(extra) : ''}`); }
}

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { ...(opts.headers || {}) } };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  if (opts.token) init.headers['x-admin-token'] = opts.token;
  const res = await fetch(BASE + path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL: BASE,
    permissions: ['camera'],
    viewport: { width: 420, height: 900 },
  });

  /* ── 1. 管理端建数据 ── */
  console.log('\n【1】管理员准备');
  const login = await api('/api/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } });
  const token = login.token;
  check('管理员登录', !!token);

  const uniq = '张三' + String(Date.now() % 100000);
  const emp = await api('/api/admin/employees', {
    method: 'POST', token, body: { name: uniq, seat: '产品', targetMinutes: 1440 },
  });
  check('创建员工并拿到 12 位邀请码', !!emp.inviteCode && emp.inviteCode.length === 12, emp);

  const term = await api('/api/admin/terminals', {
    method: 'POST', token, body: { name: '办公室前台', location: '3 楼' },
  });
  check('创建终端并拿到密钥（只在创建时返回一次）', !!term.terminal.id && !!term.secret, term);

  /* ── 2. 虚拟认证器（模拟有指纹的手机） ── */
  console.log('\n【2】准备虚拟指纹认证器');
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      isUserConsenting: true,
    },
  });
  check('虚拟认证器已挂载', !!authenticatorId);

  /* ── 3. 员工首次激活：登记指纹 ── */
  console.log('\n【3】员工首次激活（登记指纹）');
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/');
  await page.waitForSelector('#s-setup.on', { timeout: 10000 });
  check('首次打开进入激活页', await page.isVisible('#s-setup'));

  await page.selectOption('#selEmp', emp.employee.id);
  await page.fill('#inpInvite', emp.inviteCode);
  await page.click('#btnRegister');
  await page.waitForSelector('#s-home.on', { timeout: 15000 });
  check('指纹注册成功并进入首页', await page.isVisible('#s-home'));

  const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId });  check('认证器里确实生成了凭据', (creds.credentials || []).length === 1, creds);

  const stored = await page.evaluate(() => ({
    eid: localStorage.getItem('pb.employeeId'),
    tok: !!localStorage.getItem('pb.deviceToken'),
  }));
  check('设备凭据已保存到本地', !!stored.eid && stored.tok, stored);

  /* ── 4. 终端：动态二维码会话 ── */
  console.log('\n【4】终端生成动态二维码');
  const th = { 'x-terminal-key': term.secret };
  const sess = await api(`/api/terminal/${term.terminal.id}/session`, { method: 'POST', headers: th });
  check('生成 8 位会话码', /^[A-Z0-9]{8}$/.test(sess.sessionId), sess);
  check('二维码载荷格式正确', sess.payload === `PB1:${sess.sessionId}`, sess.payload);

  const qrRes = await fetch(`${BASE}/api/terminal/${term.terminal.id}/qr.svg?session=${sess.sessionId}`, { headers: th });
  const qrSvg = await qrRes.text();
  check('二维码 SVG 可生成', qrRes.ok && qrSvg.startsWith('<svg'));

  /* 二维码内容能被 jsQR 扫出来（证明员工真的能扫到） */
  const decoded = await page.evaluate(async (svg) => {
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth * 3; c.height = img.naturalHeight * 3;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const code = window.jsQR(d.data, d.width, d.height);
    URL.revokeObjectURL(url);
    return code ? code.data : null;
  }, qrSvg);
  check('二维码内容可被真实扫码器解析', decoded === `PB1:${sess.sessionId}`, decoded);

  /* ── 5. 员工打卡 ── */
  console.log('\n【5】员工扫码 + 指纹打卡');
  await page.click('#btnCheckin');
  await page.waitForSelector('#s-scan.on', { timeout: 8000 });
  check('进入扫码界面', await page.isVisible('#s-scan'));

  // 用终端显示的 8 位码走同一条后端链路
  await page.fill('#inpCode', sess.sessionId);
  await page.click('#btnManual');
  await page.waitForSelector('#s-done.on', { timeout: 15000 });
  check('指纹验证通过并完成打卡', await page.isVisible('#s-done'));
  const doneTitle = await page.textContent('#doneTitle');
  check('记录为「签进」', doneTitle.trim() === '已签进', doneTitle);

  const stateIn = await api(`/api/terminal/${term.terminal.id}/state`, { headers: th });
  check('签进后终端显示本员工在场', stateIn.present.some((x) => x.id === emp.employee.id), stateIn.present);

  const week = await api(`/api/me?employeeId=${emp.employee.id}&deviceToken=${encodeURIComponent(stored.eid && (await page.evaluate(() => localStorage.getItem('pb.deviceToken'))))}`);
  check('周时长已累加（>0）', week.week.minutes > 0, week.week);
  check('状态为「未达标」', week.week.met === false, week.week);

  /* ── 5b. 手滑连按两次「签进」：应被去重，不产生第二条记录 ── */
  console.log('\n【5b】手滑连按两次');
  const dtok = await page.evaluate(() => localStorage.getItem('pb.deviceToken'));
  const before = (await api('/api/admin/overview', { token })).week.rows
    .find((r) => r.name === uniq)?.eventCount;
  // 模拟：用户手滑，在「签进」还没刷新的情况下又点了一次
  const dupOpts = await api('/api/auth/assert-options', {
    method: 'POST',
    body: { employeeId: emp.employee.id, deviceToken: dtok, action: 'in' },
  });
  check('连按两次被识别为重复（不再要求按指纹）', dupOpts.duplicate === true, dupOpts);
  const afterDup = (await api('/api/admin/overview', { token })).week.rows
    .find((r) => r.name === uniq)?.eventCount;
  check('连按没有多产生打卡记录', afterDup === before, { before, afterDup });

  /* ── 6. 签退 ── */
  console.log('\n【6】离开时再扫一次（签退）');
  const sess2 = await api(`/api/terminal/${term.terminal.id}/session`, { method: 'POST', headers: th });
  await page.click('#btnDoneBack');
  await page.waitForSelector('#s-home.on', { timeout: 8000 });
  await page.click('#btnCheckin');
  await page.waitForSelector('#s-scan.on', { timeout: 8000 });
  await page.fill('#inpCode', sess2.sessionId);
  await page.click('#btnManual');
  await page.waitForSelector('#s-done.on', { timeout: 15000 });
  const doneTitle2 = await page.textContent('#doneTitle');
  check('记录为「签退」', doneTitle2.trim() === '已签退', doneTitle2);
  const evtAfter2 = (await api('/api/admin/overview', { token })).week.rows
    .find((r) => r.name === uniq)?.eventCount;
  check('一进一出共 2 条记录', evtAfter2 === 2, evtAfter2);

  /* ── 7. 终端状态 ── */
  console.log('\n【7】终端大屏状态');
  const state = await api(`/api/terminal/${term.terminal.id}/state`, { headers: th });
  check('签退后终端不再显示本员工在场', !state.present.some((x) => x.id === emp.employee.id), state.present);
  check('团队周累计 > 0', state.teamMinutes > 0, state.teamMinutes);

  /* ── 8. 二维码一次性 ── */
  console.log('\n【8】防重放');
  const sess3 = await api(`/api/terminal/${term.terminal.id}/session`, { method: 'POST', headers: th });
  const dt = await page.evaluate(() => localStorage.getItem('pb.deviceToken'));
  const opts = await api('/api/auth/assert-options', {
    method: 'POST', body: { employeeId: emp.employee.id, deviceToken: dt, sessionId: sess3.sessionId },
  });
  const resp = await page.evaluate(async (o) => {
    const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const from = (s) => { const p = s.replace(/-/g, '+').replace(/_/g, '/'); const b = atob(p + '==='.slice((p.length + 3) % 4)); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a.buffer; };
    const oo = o.options;
    const cred = await navigator.credentials.get({
      publicKey: { ...oo, challenge: from(oo.challenge), allowCredentials: (oo.allowCredentials || []).map((c) => ({ ...c, id: from(c.id) })) },
    });
    return {
      id: cred.id, rawId: b64(cred.rawId), type: cred.type,
      response: {
        clientDataJSON: b64(cred.response.clientDataJSON),
        authenticatorData: b64(cred.response.authenticatorData),
        signature: b64(cred.response.signature),
        userHandle: cred.response.userHandle ? b64(cred.response.userHandle) : null,
      },
    };
  }, opts);
  await api('/api/auth/assert-verify', {
    method: 'POST',
    body: { employeeId: emp.employee.id, deviceToken: dt, sessionId: sess3.sessionId, challengeId: opts.challengeId, response: resp },
  });
  check('第一次使用该二维码成功', true);
  let replayBlocked = false;
  try {
    const opts2 = await api('/api/auth/assert-options', {
      method: 'POST', body: { employeeId: emp.employee.id, deviceToken: dt, sessionId: sess3.sessionId },
    });
    void opts2;
  } catch (e) {
    replayBlocked = e.status === 409 || e.status === 410;
  }
  check('同一个二维码不能复用', replayBlocked);

  /* ── 9. 管理端周报 + CSV ── */
  console.log('\n【9】周报与导出');
  const ov = await api('/api/admin/overview', { token });
  check('周报里能看到本员工', ov.week.rows.some((r) => r.name === uniq && r.minutes > 0), ov.week.rows);
  const csv = await fetch(`${BASE}/api/admin/export.csv`, { headers: { 'x-admin-token': token } });
  const csvText = await csv.text();
  check('CSV 可导出且含表头', csv.ok && csvText.includes('姓名') && csvText.includes(uniq), csvText.slice(0, 120));

  /* ── 10. 页面无 JS 报错 ── */
  console.log('\n【10】页面健康');
  check('无 JS 运行时错误', pageErrors.length === 0, pageErrors);

  const adminPage = await context.newPage();
  const adminErrors = [];
  adminPage.on('pageerror', (e) => adminErrors.push(e.message));
  await adminPage.goto('/admin');
  await adminPage.fill('#admPass', ADMIN_PASSWORD);
  await adminPage.click('#btnLogin');
  await adminPage.waitForSelector('#s-main.on', { timeout: 10000 });
  check('管理端可登录并进入', await adminPage.isVisible('#s-main'));
  await adminPage.waitForTimeout(600);
  check('管理端渲染出周报行', (await adminPage.locator('#bench .bench').count()) >= 1);
  check('管理端无 JS 报错', adminErrors.length === 0, adminErrors);

  const termPage = await context.newPage();
  const termErrors = [];
  termPage.on('pageerror', (e) => termErrors.push(e.message));
  await termPage.goto(`/terminal.html?tid=${term.terminal.id}&key=${term.secret}`);
  await termPage.waitForTimeout(2500);
  check('终端页渲染出二维码', (await termPage.locator('#qrHolder svg').count()) === 1);
  check('终端页显示在场人数', (await termPage.textContent('#sPresent')).trim().length > 0, await termPage.textContent('#sPresent'));
  check('终端页无 JS 报错', termErrors.length === 0, termErrors);

  /* ── 11. 清理 ── */
  await api(`/api/admin/employees/${emp.employee.id}`, { method: 'DELETE', token });
  const after = await api('/api/admin/overview', { token });
  check('删除后从在职名单消失', !after.employees.some((e) => e.id === emp.employee.id), after.employees.map((e) => e.name));
  const leftRow = after.week.rows.find((r) => r.employeeId === emp.employee.id);
  check('离职员工的历史时长被保留', !!leftRow && leftRow.active === false && leftRow.minutes > 0, leftRow);

  await browser.close();

  console.log(`\n═══════════════════════════════`);
  console.log(`通过 ${passed} · 失败 ${failed}`);
  console.log(`═══════════════════════════════`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('\nE2E 崩溃：', e);
  process.exit(1);
});
