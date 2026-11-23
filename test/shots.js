'use strict';
/* 截图脚本：用于人工核对三个界面 */
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const { Store } = require('../server/db.js');

const BASE = process.env.BASE || 'http://localhost:8099';
const PW = process.env.ADMIN_PASSWORD || 'test123';
const DB = process.env.DB_FILE || ROOT + '/data/presence.db';

(async () => {
  const store = new Store(DB);
  const terminal = store.listTerminals()[0];
  const emp = store.listEmployees()[0];
  store.close();

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1.5 });

  const t = await ctx.newPage();
  await t.goto(`${BASE}/terminal.html?tid=${terminal.id}&key=${terminal.secret}`);
  await t.waitForTimeout(2500);
  await t.screenshot({ path: '/tmp/shot-terminal.png' });

  const a = await ctx.newPage();
  await a.goto(`${BASE}/admin`);
  await a.fill('#admPass', PW);
  await a.click('#btnLogin');
  await a.waitForTimeout(1500);
  await a.screenshot({ path: '/tmp/shot-admin.png' });

  // 员工端：复用 E2E 里的已激活状态
  const e = await ctx.newPage();
  await e.setViewportSize({ width: 420, height: 880 });
  const cdp = await ctx.newCDPSession(e);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true, isUserConsenting: true,
    },
  });
  void authenticatorId;
  await e.goto(BASE);
  await e.waitForSelector('#s-setup.on');
  const emps = await (await fetch(`${BASE}/api/bootstrap`)).json();
  await e.selectOption('#selEmp', emps.employees[0].id);
  await e.click('#btnUsePin');
  await e.waitForSelector('#s-pin.on');
  await e.screenshot({ path: '/tmp/shot-employee-setup.png' });

  await browser.close();
  console.log('shots ok');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
