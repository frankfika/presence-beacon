// 离线外壳 + PWA 测试
//  R6-9  断网后仍能打开应用外壳（HTML+CSS 渲染，且不把页面整个换成错误）
//  R6-16 apple-touch-icon 是 180×180
//  SW    终端页 / 管理页也注册了 Service Worker
const { chromium } = require('../pw.js');
const BASE = process.env.BASE || 'http://localhost:8099';
const fs = require('node:fs');

const results = [];
const ok = (id, title, pass, detail) => results.push({ id, title, pass, detail });

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext();

  /* ── 先联网访问一次，让 SW 装好 ── */
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const swState = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    if (!r) return { reg: false };
    await navigator.serviceWorker.ready;
    return { reg: true, scope: r.scope, active: !!r.active, state: r.active && r.active.state };
  });
  ok('PWA-1', 'Service Worker 注册并激活', swState.reg && swState.active, JSON.stringify(swState));

  // 缓存里应该有外壳
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const c = await caches.open(keys[0]);
    const reqs = await c.keys();
    return { cache: keys, urls: reqs.map((r) => new URL(r.url).pathname) };
  });
  ok('PWA-2', '应用外壳已进缓存', cached.urls.includes('/index.html') && cached.urls.includes('/app.css'),
    `${cached.urls.length} 个: ${cached.urls.slice(0, 8).join(', ')}`);

  /* ── 先把设备激活掉（模拟真实员工），断网后应能看到首页 + 缓存周报 ── */
  const tok = await page.evaluate(async (pw) => {
    const r = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    return (await r.json()).token;
  }, process.env.ADMIN_PASSWORD || 'test123');
  const emp = await page.evaluate(async ([t, nm]) => {
    const r = await fetch('/api/admin/employees', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': t },
      body: JSON.stringify({ name: nm, seat: 'OFF-01' }),
    });
    return await r.json();
  }, [tok, '离线测试员' + Math.random().toString(36).slice(2, 5)]);
  // 用员工码通道走通 deviceToken（模拟已激活设备）
  await page.evaluate(async ([employeeId, pin]) => {
    const r = await fetch('/api/auth/recover', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', pin }),
    });
  }, [emp.employee.id, emp.pin]);

  /* ── 断网 ── */
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const offline = await page.evaluate(() => {
    const hero = document.getElementById('hero');
    const bar = document.getElementById('offlineBar');
    const bodyText = document.body.innerText.slice(0, 200);
    return {
      hasHero: !!hero,
      heroVisible: hero ? getComputedStyle(hero).display !== 'none' : false,
      cssApplied: getComputedStyle(document.body).backgroundColor,
      offlineBar: bar ? bar.innerText : null,
      bodyText,
    };
  });
  ok('R6-9', '断网后仍能打开应用外壳（不是一行报错）',
    offline.hasHero && offline.heroVisible && offline.bodyText.includes('在岗哨'),
    JSON.stringify(offline).slice(0, 320));

  ok('R6-9b', '断网时明确提示「离线」且不谎报数据',
    !!offline.offlineBar && /离线/.test(offline.offlineBar), String(offline.offlineBar).slice(0, 160));

  await ctx.setOffline(false);

  /* ── apple-touch-icon ── */
  const at = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="apple-touch-icon"]');
    if (!link) return { none: true };
    const r = await fetch(link.href);
    const b = await r.arrayBuffer();
    const bmp = await createImageBitmap(new Blob([b], { type: 'image/png' }));
    return { href: link.getAttribute('href'), sizes: link.getAttribute('sizes'), w: bmp.width, h: bmp.height };
  });
  ok('R6-16', 'apple-touch-icon 是 180×180（iOS 期望值）',
    at.w === 180 && at.h === 180, JSON.stringify(at));

  /* ── 终端页 / 管理页也注册 SW ── */
  const page2 = await ctx.newPage();
  await page2.goto(BASE + '/terminal.html?tid=x&key=y', { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(2000);
  const tsw = await page2.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return { reg: !!r, active: !!(r && r.active) };
  });
  ok('PWA-3', '终端页也注册了 Service Worker', tsw.reg && tsw.active, JSON.stringify(tsw));

  const page3 = await ctx.newPage();
  await page3.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
  await page3.waitForTimeout(2000);
  const asw = await page3.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return { reg: !!r, active: !!(r && r.active) };
  });
  ok('PWA-4', '管理页也注册了 Service Worker', asw.reg && asw.active, JSON.stringify(asw));

  /* ── 终端页离线兜底 ── */
  await ctx.setOffline(true);
  const page4 = await ctx.newPage();
  const errs = [];
  page4.on('pageerror', (e) => errs.push(e.message));
  await page4.goto(BASE + '/terminal.html?tid=x&key=y', { waitUntil: 'domcontentloaded' });
  await page4.waitForTimeout(2500);
  const tOff = await page4.evaluate(() => ({
    hasQr: !!document.getElementById('qrHolder'),
    qrState: document.getElementById('qrState')?.textContent,
  }));
  ok('PWA-5', '终端页断网后仍能打开（外壳兜底），并提示离线',
    tOff.hasQr && /离线|未授权/.test(String(tOff.qrState)),
    JSON.stringify(tOff).slice(0, 200));
  ok('PWA-6', '终端页离线无 JS 运行时错误', errs.length === 0, errs.slice(0, 2).join(' | '));
  await ctx.setOffline(false);

  await browser.close();
  let fail = 0;
  for (const r of results) {
    if (!r.pass) fail++;
    console.log(`${r.pass ? '✓' : '✗'} ${r.id}  ${r.title}\n    ${r.detail}`);
  }
  console.log(`\n通过 ${results.length - fail} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
