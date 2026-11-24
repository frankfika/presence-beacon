// C 报告遗留问题的专项验证
// 覆盖 P0-1 大小写 / P1-1 bigbtn / P1-2 对比度 / P1-3 ink-3 / P1-4 超时 /
//      P1-5 审批 tab / P2-1 rowlink / P2-2 输入框 / P2-3 表格 / P2-4 错误文案 /
//      P2-5 闪屏遮挡 / P2-6 label 关联 / P3-1 字号
const { chromium } = require('../pw.js');
const BASE = process.env.BASE || 'http://localhost:8099';
const results = [];
const ok = (id, title, pass, detail) => results.push({ id, title, pass, detail });

function lum(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(fg, bg) {
  const a = lum(fg), b = lum(bg);
  return ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2);
}
function parseRGB(s) {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(',').map((x) => parseFloat(x));
  return [p[0], p[1], p[2]];
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

  /* ── P0-1 大小写 ── */
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
      body: JSON.stringify({ name: nm, seat: 'C-01' }),
    });
    return await r.json();
  }, [tok, '大小写' + Math.random().toString(36).slice(2, 5)]);

  const lowerInvite = await page.evaluate(async ([employeeId, inviteCode]) => {
    const r = await fetch('/api/auth/register-options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, inviteCode: inviteCode.toLowerCase() }),
    });
    return { status: r.status, body: await r.json() };
  }, [emp.employee.id, emp.inviteCode]);
  ok('P0-1a', '小写邀请码也能通过（手机输入法默认小写）',
    lowerInvite.status === 200, `HTTP ${lowerInvite.status} ${JSON.stringify(lowerInvite.body).slice(0, 120)}`);

  const lowerPin = await page.evaluate(async ([employeeId, pin]) => {
    const r = await fetch('/api/checkin/pin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, pin: pin.toLowerCase(), action: 'in' }),
    });
    return { status: r.status, body: await r.json() };
  }, [emp.employee.id, emp.pin]);
  ok('P0-1b', '小写员工码也能打卡',
    lowerPin.status === 200 && lowerPin.body.kind === 'in',
    `HTTP ${lowerPin.status} ${JSON.stringify(lowerPin.body).slice(0, 120)}`);

  const lowerRecover = await page.evaluate(async ([name, pin]) => {
    const r = await fetch('/api/auth/recover', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin: pin.toLowerCase() }),
    });
    return { status: r.status, body: await r.json() };
  }, [emp.employee.name, emp.pin]);
  ok('P0-1c', '小写员工码也能自助恢复',
    lowerRecover.status === 200, `HTTP ${lowerRecover.status}`);

  /* ── P1-1 bigbtn 通栏 ── */
  const big = await page.evaluate(() => {
    const e = document.getElementById('btnCheckin');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), parentW: Math.round(e.parentElement.getBoundingClientRect().width) };
  });
  ok('P1-1', '首页主按钮是通栏（不是 51%）',
    big && big.w >= big.parentW - 4, JSON.stringify(big));

  /* ── P1-3 ink-3 对比度 ── */
  const ink3 = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--ink-3').trim();
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return { color: c, bg: getComputedStyle(document.body).backgroundColor };
  });
  const r3 = ratio(parseRGB(ink3.color), parseRGB(ink3.bg));
  ok('P1-3', `--ink-3 对比度 ≥4.5:1（实测 ${r3}:1）`, parseFloat(r3) >= 4.5, JSON.stringify(ink3));

  /* ── P1-4 fetch 超时 ── */
  const hasTimeout = await page.evaluate(async () => {
    const src = await (await fetch('/lib.js')).text();
    return /AbortSignal\.timeout/.test(src);
  });
  ok('P1-4', 'API 请求有超时保护（不会永久卡在「请按指纹…」）', hasTimeout, String(hasTimeout));

  /* ── P2-1 rowlink 可点 ── */
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const rowClickable = await page.evaluate(() => {
    const e = document.getElementById('btnExceptionRow');
    return e ? { tag: e.tagName, isButton: e.tagName === 'BUTTON' } : null;
  });
  ok('P2-1', '首页「补卡 / 请假 / 出差 ›」是可点的真按钮',
    rowClickable && rowClickable.isButton, JSON.stringify(rowClickable));

  /* ── P2-6 label 关联 ── */
  const labels = await page.evaluate(() => {
    const miss = [];
    document.querySelectorAll('label').forEach((l) => {
      if (!l.getAttribute('for')) miss.push(l.textContent.trim().slice(0, 12));
      else if (!document.getElementById(l.getAttribute('for'))) miss.push('for=' + l.getAttribute('for') + ' 不存在');
    });
    return { total: document.querySelectorAll('label').length, miss };
  });
  ok('P2-6', '所有 label 都和输入框程序化关联',
    labels.miss.length === 0, `${labels.total} 个 label，缺失 ${labels.miss.length}: ${labels.miss.join(', ')}`);

  /* ── 管理端：P1-5 审批 tab / P2-2 输入框 / P2-3 表格 ── */
  const ap = await ctx.newPage();
  await ap.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
  await ap.fill('#admPass', process.env.ADMIN_PASSWORD || 'test123');
  await ap.click('#btnLogin');
  await ap.waitForSelector('#s-main', { state: 'visible' });
  await ap.waitForTimeout(2000);

  // P1-5：切到「审批」tab 会重新拉数据
  const reloadOnTab = await ap.evaluate(async () => {
    const src = await (await fetch('/admin.js')).text();
    const m = src.match(/addEventListener\('click', \(\) => \{[\s\S]{0,400}?load\(\)/);
    return !!m;
  });
  ok('P1-5', '切 tab 会重新拉数据（审批 tab 不再显示旧数据）', reloadOnTab, String(reloadOnTab));

  // P2-2：工时输入框
  await ap.click('.tab[data-tab="t-people"]');
  await ap.waitForTimeout(1200);
  const input = await ap.evaluate(() => {
    const e = document.querySelector('[data-t]');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), aria: e.getAttribute('aria-label') };
  });
  ok('P2-2', '管理端工时输入框 ≥44px 高且有 aria-label',
    input && input.h >= 44 && !!input.aria, JSON.stringify(input));

  // P2-3：表格 td 不换行
  const nowrap = await ap.evaluate(() => {
    const td = document.querySelector('#empList td');
    return td ? getComputedStyle(td).whiteSpace : null;
  });
  ok('P2-3', '管理端表格单元格不换行（状态 tag 不再竖排）', nowrap === 'nowrap', String(nowrap));

  /* ── 终端页：P1-2 对比度 / P2-5 闪屏不挡点击 / P3-1 字号 ── */
  const term = await ctx.newPage();
  await term.goto(BASE + '/terminal.html?tid=x&key=y', { waitUntil: 'domcontentloaded' });
  await term.waitForTimeout(1500);
  const termStyles = await term.evaluate(() => {
    const foot = document.querySelector('.term .foot');
    const k = document.querySelector('.stat .k');
    const bg = getComputedStyle(document.body).backgroundColor;
    const footColor = foot ? getComputedStyle(foot).color : null;
    const kColor = k ? getComputedStyle(k).color : null;
    const flash = document.querySelector('.flash');
    const flashOn = flash ? getComputedStyle(flash).pointerEvents : null;
    return { bg, footColor, kColor, kSize: k ? getComputedStyle(k).fontSize : null, flashOn };
  });
  const rFoot = termStyles.footColor ? ratio(parseRGB(termStyles.footColor), parseRGB(termStyles.bg)) : '0';
  const rK = termStyles.kColor ? ratio(parseRGB(termStyles.kColor), parseRGB(termStyles.bg)) : '0';
  ok('P1-2', `终端深色页次要文字对比度 ≥4.5:1（foot ${rFoot}:1 / 标签 ${rK}:1）`,
    parseFloat(rFoot) >= 4.5 && parseFloat(rK) >= 4.5, JSON.stringify(termStyles));

  ok('P2-5', '闪屏提示不拦截点击（不会挡住二维码）',
    termStyles.flashOn === 'none', String(termStyles.flashOn));

  ok('P3-1', `终端页标签字号 ≥13px（${termStyles.kSize}）`,
    parseFloat(termStyles.kSize) >= 13, String(termStyles.kSize));

  /* ── P2-4 WebAuthn 错误文案 ── */
  const friendly = await page.evaluate(async () => {
    const src = await (await fetch('/employee.js')).text();
    return { hasFn: /friendlyWebauthnError/.test(src), notAllowed: /NotAllowedError/.test(src) };
  });
  ok('P2-4', 'WebAuthn 原始英文错误被翻译成中文',
    friendly.hasFn && friendly.notAllowed, JSON.stringify(friendly));

  await browser.close();
  let fail = 0;
  for (const r of results) {
    if (!r.pass) fail++;
    console.log(`${r.pass ? '✓' : '✗'} ${r.id}  ${r.title}\n    ${r.detail}`);
  }
  console.log(`\n通过 ${results.length - fail} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
