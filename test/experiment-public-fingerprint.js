/**
 * 实验：旧安卓机当「公共指纹识别器」在纯浏览器里到底行不行？
 *
 * 方案 B（用户提的）：办公室那台旧安卓机上，每个员工注册一个属于自己的
 * WebAuthn 凭证；打卡时在这台机器上按指纹，浏览器返回 credential ID，
 * 服务器据此知道是谁。
 *
 * 这个实验用 CDP 虚拟认证器（模拟「一台设备上有多个人的指纹」）跑真实链路，
 * 回答三个问题：
 *   Q1 同一认证器能不能给多个用户各注册一个凭证？
 *   Q2 断言时不指定 allowCredentials，浏览器返回的是谁的凭证？
 *   Q3 浏览器会不会弹出「选账户」让用户明确指定？
 *
 * 结论写进 docs/架构说明.md 的 §5.1，作为「为什么不用这个方案」的证据。
 *
 * 用法：node test/experiment-public-fingerprint.js
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const { Store } = require('../server/db.js');
const { WebAuthnService, b64url, fromB64url } = require('../server/webauthn.js');

const PORT = 8096;
const BASE = `http://localhost:${PORT}`;
const RP_ID = 'localhost';
const ORIGIN = BASE;

/* ── 实验用的小服务 ── */
const store = new Store(':memory:');
const wa = new WebAuthnService(store, { rpName: '在岗哨', rpID: RP_ID, origins: [ORIGIN] });

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

/**
 * 注册：给某个用户生成 registrationOptions。
 * 关键：excludeCredentials 只排除「这个用户自己的」凭证 ——
 * 其他用户的凭证留在同一台设备上，正是方案 B 要的。
 */
async function expRegister(body) {
  const emp = store.getEmployee(body.employeeId);
  if (!emp) return { error: '员工不存在' };
  const mine = store.listCredentials(emp.id);
  const options = await wa.registrationOptions({ employee: emp });
  // 覆盖掉 excludeCredentials：方案 B 里同一台设备要容纳不同用户的凭证
  options.options.excludeCredentials = mine.map((c) => ({ id: c.id }));
  return options;
}
async function expRegisterVerify(body) {
  const emp = store.getEmployee(body.employeeId);
  const { credentialId } = await wa.verifyRegistration({
    employee: emp, response: body.response, challengeId: body.challengeId, origin: [ORIGIN],
  });
  return { credentialId };
}

/**
 * 断言（方案 B 的核心）：
 * allowCredentials 留空 → 浏览器从本机所有已登记凭证里挑一个能通过验证的。
 * 服务器从返回的 credential ID 反查是哪个员工。
 */
async function expAssert(body) {
  const creds = store.db.prepare('SELECT * FROM credentials').all();
  const { generateAuthenticationOptions } = require('@simplewebauthn/server');
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
    // 方案 B 的关键：allowCredentials 要么给全部（浏览器弹账户选择器），
    // 要么留空（浏览器从本机所有常驻凭证里自己挑一个能通过的）
    allowCredentials: body.mode === 'all'
      ? creds.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined }))
      : [],
  });
  const challengeId = crypto.randomUUID();
  store.putChallenge({ id: challengeId, challenge: options.challenge, kind: 'assert', employeeId: 'multi' });
  return { challengeId, options };
}
async function expAssertVerify(body) {
  const { verifyAuthenticationResponse } = require('@simplewebauthn/server');
  const ch = store.takeChallenge(body.challengeId);
  if (!ch) return { error: 'challenge 无效或已过期' };
  const credId = typeof body.response.id === 'string' ? body.response.id : b64url(body.response.id);
  const cred = store.getCredential(credId);
  if (!cred) return { error: '凭据不存在' };
  const emp = store.getEmployee(cred.employee_id);
  // 用「凭证真正的主人」做标准签名校验
  const v = await verifyAuthenticationResponse({
    response: body.response,
    expectedChallenge: ch.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: cred.id,
      publicKey: fromB64url(cred.public_key),
      counter: cred.counter,
      transports: cred.transports ? JSON.parse(cred.transports) : undefined,
    },
    requireUserVerification: true,
  });
  if (!v.verified) return { error: '验证失败' };
  return { credentialId: cred.id, employeeId: cred.employee_id, employeeName: emp.name };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    });
    return res.end();
  }
  const body = await readBody(req);
  const p = req.url.split('?')[0];
  try {
    if (p === '/exp/register') return json(res, 200, await expRegister(body));
    if (p === '/exp/register-verify') return json(res, 200, await expRegisterVerify(body));
    if (p === '/exp/assert') return json(res, 200, await expAssert(body));
    if (p === '/exp/assert-verify') return json(res, 200, await expAssertVerify(body));
    if (p === '/exp/creds') {
      return json(res, 200, store.db.prepare('SELECT id, employee_id FROM credentials').all());
    }
    if (p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><body>experiment</body></html>');
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

/* ── 浏览器侧 ── */
const b64uToBuf = (s) => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b.padEnd(b.length + ((4 - b.length % 4) % 4), '='));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const bufToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

(async () => {
  await new Promise((r) => server.listen(PORT, r));

  // 建三个「员工」
  const emps = ['张三', '李四', '王五'].map((name) =>
    store.createEmployee({ name, seat: name + '位', inviteCode: crypto.randomUUID() }));
  console.log('实验对象：', emps.map((e) => e.name).join(' / '), '（共用同一台「终端」）\n');

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // 把 base64url 转换助手注入页面（page.evaluate 里的代码跑在浏览器上下文）
  await page.addInitScript(() => {
    window.__b64uToBuf = (s) => {
      const b = s.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b.padEnd(b.length + ((4 - b.length % 4) % 4), '='));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    };
    window.__bufToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

  // 一台认证器 = 那台旧安卓机
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true, isUserConsuming: false,
      isUserConsenting: true,
    },
  });
  console.log('✓ 虚拟认证器已建立（模拟那台旧安卓机的指纹模组）\n');

  const out = [];
  const log = (q, ans, detail) => {
    out.push({ q, ans, detail });
    console.log(`${q}\n  → ${ans}${detail ? '  （' + detail + '）' : ''}\n`);
  };

  /* Q1：同一认证器能否给多个用户各注册一个凭证？ */
  const registered = [];
  for (const emp of emps) {
    const r = await page.evaluate(async ([eid]) => {
      const o = await (await fetch('/exp/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: eid }),
      })).json();
      const cred = await navigator.credentials.create({
        publicKey: {
          ...o.options,
          challenge: window.__b64uToBuf(o.options.challenge),
          user: { ...o.options.user, id: window.__b64uToBuf(o.options.user.id) },
          excludeCredentials: (o.options.excludeCredentials || []).map((c) => ({ ...c, id: window.__b64uToBuf(c.id) })),
        },
      });
      if (!cred) return { error: '用户取消' };
      const resp = {
        id: cred.id, rawId: window.__bufToB64u(cred.rawId), type: cred.type,
        response: {
          clientDataJSON: window.__bufToB64u(cred.response.clientDataJSON),
          attestationObject: window.__bufToB64u(cred.response.attestationObject),
        },
      };
      const v = await (await fetch('/exp/register-verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: eid, challengeId: o.challengeId, response: resp }),
      })).json();
      return v;
    }, [emp.id]);
    registered.push({ name: emp.name, ...r });
  }
  const okCount = registered.filter((r) => r.credentialId).length;
  log('Q1 同一台设备能注册几个人的指纹？',
    okCount === emps.length ? `能，${okCount} 个人都注册成功了` : `只成功 ${okCount}/${emps.length} 个`,
    `认证器 id ${authenticatorId.slice(0, 8)}…`);

  const credList = await (await fetch(`${BASE}/exp/creds`)).json();
  log('  服务端存的凭证',
    `${credList.length} 条，分别属于 ${[...new Set(credList.map((c) => c.employee_id))].length} 个用户`,
    'credential ID 互不相同 → 服务器能靠它反查是谁');

  /* Q2 + Q3：断言时不让浏览器「预先知道」是谁 */
  for (const mode of ['all', 'any']) {
    const r = await page.evaluate(async ([m]) => {
      const o = await (await fetch('/exp/assert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: m }),
      })).json();
      let picked = null, err = null;
      try {
        const cred = await navigator.credentials.get({
          publicKey: {
            ...o.options,
            challenge: window.__b64uToBuf(o.options.challenge),
            allowCredentials: (o.options.allowCredentials || []).map((c) => ({ ...c, id: window.__b64uToBuf(c.id) })),
          },
        });
        if (cred) {
          const resp = {
            id: cred.id, rawId: window.__bufToB64u(cred.rawId), type: cred.type,
            response: {
              clientDataJSON: window.__bufToB64u(cred.response.clientDataJSON),
              authenticatorData: window.__bufToB64u(cred.response.authenticatorData),
              signature: window.__bufToB64u(cred.response.signature),
              userHandle: cred.response.userHandle ? window.__bufToB64u(cred.response.userHandle) : null,
            },
          };
          picked = await (await fetch('/exp/assert-verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challengeId: o.challengeId, response: resp }),
          })).json();
        }
      } catch (e) { err = e.name + ': ' + e.message; }
      return { picked, err };
    }, [mode]);
    if (mode === 'all') {
      log('Q2 断言时给出全部凭证（浏览器按 account picker 或自动匹配）',
        r.picked && r.picked.employeeName ? `✓ 返回的是「${r.picked.employeeName}」的凭证` : `失败：${r.err || JSON.stringify(r.picked)}`,
        r.picked ? `credential ${String(r.picked.credentialId).slice(0, 12)}…` : '');
    } else {
      log('Q3 断言时完全不指定凭证（浏览器自己从本机所有凭证里挑）',
        r.picked && r.picked.employeeName ? `能识别：返回「${r.picked.employeeName}」` : `不能：${r.err || '无'}`,
        r.picked ? '—— 说明服务器能靠 credential ID 反查身份' : '—— 拿不到身份就无法签到');
    }
  }

  await browser.close();
  server.close();

  console.log('════════════════════════════════════');
  console.log('结论：');
  for (const r of out) console.log('  • ' + r.q + '\n    ' + r.ans);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
