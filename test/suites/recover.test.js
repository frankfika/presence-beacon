// 自助恢复链路测试：
//  1) 清掉本地数据 → 姓名+员工码 → 恢复 deviceToken（弱令牌）
//  2) 弱令牌不能追加生物特征凭证
//  3) 用旧指纹做一次 assert → 换发强令牌 → 可以追加凭证
//  4) 恢复过程不产生任何打卡记录
const { chromium } = require('../pw.js');
const BASE = process.env.BASE || 'http://localhost:8099';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'test123';

const results = [];
const ok = (id, title, pass, detail) => results.push({ id, title, pass, detail });

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext();

  /* ── 准备：建一个员工，走完整指纹登记，拿 employeeId ── */
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  // 用 API 建员工（管理端 token）
  const tok = await page.evaluate(async (pw) => {
    const r = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    return (await r.json()).token;
  }, ADMIN_PW);

  const UNIQ = '恢复测试员' + Math.random().toString(36).slice(2, 6);
  const emp = await page.evaluate(async ([t, nm]) => {
    const r = await fetch('/api/admin/employees', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': t },
      body: JSON.stringify({ name: nm, seat: 'R-01' }),
    });
    return await r.json();
  }, [tok, UNIQ]);
  const employeeId = emp.employee.id;
  const pin = emp.pin;
  const inviteCode = emp.inviteCode;
  console.log('员工:', employeeId, '员工码:', pin, '邀请码:', inviteCode);

  // 注册指纹（用 CDP 虚拟认证器）
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true, isUserConsenting: true,
    },
  });

  const reg = await page.evaluate(async ([employeeId, inviteCode]) => {
    const o = await (await fetch('/api/auth/register-options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, inviteCode }),
    })).json();
    const b64uToBuf = (s) => {
      const b = s.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b.padEnd(b.length + ((4 - b.length % 4) % 4), '='));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    };
    const cred = await navigator.credentials.create({
      publicKey: {
        ...o.options, challenge: b64uToBuf(o.options.challenge),
        user: { ...o.options.user, id: b64uToBuf(o.options.user.id) },
        excludeCredentials: (o.options.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
      },
    });
    const bufToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const resp = {
      id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
      response: {
        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
        attestationObject: bufToB64u(cred.response.attestationObject),
      },
    };
    const v = await (await fetch('/api/auth/register-verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, inviteCode, challengeId: o.challengeId, response: resp }),
    })).json();
    return v;
  }, [employeeId, inviteCode]);
  ok('REC-1', '首次指纹登记成功，拿到强设备令牌', !!reg.deviceToken && reg.strong === true, JSON.stringify(reg).slice(0, 200));

  /* ── 1) 清本地数据 → 姓名+员工码恢复 ── */
  const rec = await page.evaluate(async ([name, pin]) => {
    const r = await fetch('/api/auth/recover', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin }),
    });
    return { status: r.status, body: await r.json() };
  }, [UNIQ, pin]);
  ok('REC-2', '姓名 + 员工码可以自助恢复（不用找管理员）',
    rec.status === 200 && !!rec.body.deviceToken, JSON.stringify(rec.body).slice(0, 220));

  // 弱令牌能不能追加生物特征凭证？—— 不能
  const weakAddOn = await page.evaluate(async ([employeeId, deviceToken]) => {
    const r = await fetch('/api/auth/register-options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, deviceToken }),
    });
    return { status: r.status, body: await r.json() };
  }, [employeeId, rec.body.deviceToken]);
  ok('REC-3', '弱令牌（员工码恢复的）不能追加新的生物特征凭证',
    weakAddOn.status !== 200, `HTTP ${weakAddOn.status} ${JSON.stringify(weakAddOn.body).slice(0, 140)}`);

  // 错误员工码
  const bad = await page.evaluate(async (name) => {
    const r = await fetch('/api/auth/recover', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin: 'WRONGPIN' }),
    });
    return { status: r.status, body: await r.json() };
  }, UNIQ);
  ok('REC-4', '员工码错了不能恢复', bad.status === 403, `HTTP ${bad.status}`);

  /* ── 2) 用旧指纹 assert → 换发强令牌 ── */
  const bioRec = await page.evaluate(async (name) => {
    const o = await (await fetch('/api/auth/assert-options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeName: name, recover: true }),
    })).json();
    if (!o.options) return { fail: o };
    const b64uToBuf = (s) => {
      const b = s.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b.padEnd(b.length + ((4 - b.length % 4) % 4), '='));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    };
    const cred = await navigator.credentials.get({
      publicKey: {
        ...o.options, challenge: b64uToBuf(o.options.challenge),
        allowCredentials: (o.options.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
      },
    });
    const bufToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const resp = {
      id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
      response: {
        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
        authenticatorData: bufToB64u(cred.response.authenticatorData),
        signature: bufToB64u(cred.response.signature),
        userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : null,
      },
    };
    const v = await (await fetch('/api/auth/assert-verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: o.challengeId, response: resp, recover: true }),
    })).json();
    return v;
  }, UNIQ);
  ok('REC-5', '用旧指纹可以直接恢复（最强路径，且不用员工码）',
    !!bioRec.deviceToken && bioRec.strong === true, JSON.stringify(bioRec).slice(0, 220));

  // 恢复后不产生打卡记录
  const week = await page.evaluate(async ([t, id]) => {
    const r = await fetch(`/api/admin/overview?employeeId=${id}`, { headers: { 'x-admin-token': t } });
    const d = await r.json();
    const row = d.week.rows.find((x) => x.employeeId === id);
    return row ? { minutes: row.minutes, eventCount: row.eventCount } : null;
  }, [tok, employeeId]);
  ok('REC-6', '恢复过程不产生任何打卡记录', week && week.eventCount === 0 && week.minutes === 0, JSON.stringify(week));

  // 强令牌可以追加凭证
  const strongAddOn = await page.evaluate(async ([employeeId, deviceToken]) => {
    const r = await fetch('/api/auth/register-options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, deviceToken }),
    });
    return { status: r.status, body: await r.json() };
  }, [employeeId, bioRec.deviceToken]);
  ok('REC-7', '强令牌（指纹恢复的）可以追加/重登记生物特征',
    strongAddOn.status === 200 && !!strongAddOn.body.options, `HTTP ${strongAddOn.status}`);

  /* ── 3) 前端：清掉 localStorage 后能自助恢复 ── */
  await page.evaluate(() => { localStorage.clear(); });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const hasRecoverBtn = await page.locator('#btnRecover').count();
  ok('REC-8', '激活界面有「以前激活过？点这里恢复」入口', hasRecoverBtn === 1, `按钮数=${hasRecoverBtn}`);

  await page.click('#btnRecover');
  await page.waitForTimeout(400);
  await page.fill('#inpRecName', UNIQ);
  await page.fill('#inpRecPin', pin);
  await page.click('#btnRecoverPin');
  await page.waitForTimeout(1800);
  const homeVisible = await page.evaluate(() => {
    const s = document.getElementById('s-home');
    return s && getComputedStyle(s).display !== 'none';
  });
  const hasToken = await page.evaluate(() => !!localStorage.getItem('pb.deviceToken'));
  ok('REC-9', '前端清缓存后能自助恢复并回到首页', homeVisible && hasToken,
    `home=${homeVisible} token=${hasToken}`);

  // 恢复后能真的打卡
  await page.evaluate((p) => { window.__TEST_PIN__ = p; }, pin);
  const ck = await page.evaluate(async () => {
    const r = await fetch('/api/checkin/pin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employeeId: localStorage.getItem('pb.employeeId'),
        pin: window.__TEST_PIN__,
        action: 'in',
      }),
    });
    return { status: r.status, body: await r.json() };
  });
  ok('REC-10', '恢复后打卡链路可用（员工码通道真的能打出记录）',
    ck.status === 200 && ck.body.kind === 'in',
    `HTTP ${ck.status} ${JSON.stringify(ck.body).slice(0, 160)}`);

  await browser.close();
  let fail = 0;
  for (const r of results) {
    if (!r.pass) fail++;
    console.log(`${r.pass ? '✓' : '✗'} ${r.id}  ${r.title}\n    ${r.detail}`);
  }
  console.log(`\n通过 ${results.length - fail} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
