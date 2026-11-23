// 终端闪屏 + 长按面板专项测试（覆盖 C 的 R4-5 / R4-7 / R4-12 / R4-13）
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const BASE = process.env.BASE || 'http://localhost:8099';
const results = [];
const ok = (id, title, pass, detail) => results.push({ id, title, pass, detail });

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  // 管理员登录
  const tok = await page.evaluate(async (pw) => {
    const r = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    return (await r.json()).token;
  }, process.env.ADMIN_PASSWORD || 'test123');

  // 建员工 + 终端
  const fx = await page.evaluate(async ([t, nm]) => {
    const e = await (await fetch('/api/admin/employees', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': t },
      body: JSON.stringify({ name: nm, seat: 'T-01' }),
    })).json();
    const term = await (await fetch('/api/admin/terminals', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': t },
      body: JSON.stringify({ name: '测试终端', location: '前台' }),
    })).json();
    const tt = (term.terminal || term);
    const sec = await (await fetch(`/api/admin/terminals/${tt.id}/reset-secret`, {
      method: 'POST', headers: { 'x-admin-token': t },
    })).json();
    return { employee: e.employee, pin: e.pin, tid: tt.id, key: sec.secret || sec.key };
  }, [tok, '终端测试' + Math.random().toString(36).slice(2, 5)]);

  const termUrl = `${BASE}/terminal.html?tid=${fx.tid}&key=${encodeURIComponent(fx.key)}`;

  // 打开终端页，等它稳定
  await page.goto(termUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);
  const baseline = await page.evaluate(() => document.getElementById('flash').classList.contains('on'));
  ok('R4-7', '终端页刚打开不闪屏（不重播历史事件）', baseline === false, `flash.on=${baseline}`);

  // 制造一次打卡
  const sessionId = await page.evaluate(async ([tid, key]) => {
    const r = await fetch(`/api/terminal/${tid}/session`, { method: 'POST', headers: { 'x-terminal-key': key } });
    return (await r.json()).sessionId;
  }, [fx.tid, fx.key]);

  const ck = await page.evaluate(async ([empId, pin, sid]) => {
    const r = await fetch('/api/checkin/pin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: empId, pin, sessionId: sid, action: 'in' }),
    });
    return { status: r.status, body: await r.json() };
  }, [fx.employee.id, fx.pin, sessionId]);
  ok('R4-5a', '终端 session 扫码打卡成功', ck.status === 200 && ck.body.kind === 'in',
    `HTTP ${ck.status} ${JSON.stringify(ck.body).slice(0, 140)}`);

  // 等闪屏
  let flashed = false, flashInfo = null;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => ({
      on: document.getElementById('flash').classList.contains('on'),
      name: document.getElementById('flashName').textContent,
      sub: document.getElementById('flashSub').textContent,
    }));
    if (st.on) { flashed = true; flashInfo = st; break; }
  }
  ok('R4-5', '有人打卡后终端闪屏提示', flashed,
    flashed ? `${flashInfo.name} / ${flashInfo.sub}` : '10 秒内没闪');

  // 闪屏 3 秒后自动消失
  await page.waitForTimeout(3500);
  const stillOn = await page.evaluate(() => document.getElementById('flash').classList.contains('on'));
  ok('R4-6', '闪屏 3 秒后自动消失', !stillOn, `still on=${stillOn}`);

  // 制造 12 条事件（超过 recent 的 10 条上限）—— 同一员工 30 秒去重窗内只能记一条，
  // 所以用 12 个不同员工
  const many = await page.evaluate(async ([t, base]) => {
    const out = [];
    for (let i = 0; i < 12; i++) {
      const e = await (await fetch('/api/admin/employees', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': t },
        body: JSON.stringify({ name: base + i, seat: 'M-' + i }),
      })).json();
      out.push({ id: e.employee.id, pin: e.pin });
    }
    return out;
  }, [tok, '批量' + Math.random().toString(36).slice(2, 4)]);
  for (const m of many) {
    const sid = await page.evaluate(async ([tid, key]) => {
      const r = await fetch(`/api/terminal/${tid}/session`, { method: 'POST', headers: { 'x-terminal-key': key } });
      return (await r.json()).sessionId;
    }, [fx.tid, fx.key]);
    await page.evaluate(async ([empId, pin, s]) => {
      await fetch('/api/checkin/pin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: empId, pin, sessionId: s, action: 'in' }),
      });
    }, [m.id, m.pin, sid]);
  }
  await page.waitForTimeout(1000);
  let f10 = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300);
    if (await page.evaluate(() => document.getElementById('flash').classList.contains('on'))) { f10 = true; break; }
  }
  const recentLen = await page.evaluate(async ([tid, key]) => {
    const st = await (await fetch(`/api/terminal/${tid}/state`, { headers: { 'x-terminal-key': key } })).json();
    return st.recent.length;
  }, [fx.tid, fx.key]);
  ok('R4-12', '事件数超过 10 条上限后新打卡仍然闪屏', f10,
    `recent.length=${recentLen} 闪屏=${f10}`);

  // 重开页面不重播
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);
  const replay = await page.evaluate(() => document.getElementById('flash').classList.contains('on'));
  ok('R4-7b', '终端页重开不重播旧闪屏', replay === false, `flash.on=${replay}`);

  /* ── 长按（真实触摸事件） ── */
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const tp = await mctx.newPage();
  const terrs = [];
  tp.on('pageerror', (e) => terrs.push(e.message));
  await tp.goto(termUrl, { waitUntil: 'networkidle' });
  await tp.waitForTimeout(3000);
  const box = await tp.evaluate(() => {
    const r = document.getElementById('qrFrame').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  // 用真实 touch 事件序列
  const cdp = await mctx.newCDPSession(tp);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y, id: 1 }] });
  await tp.waitForTimeout(1700);
  const sheetOn = await tp.evaluate(() => document.getElementById('sheet').classList.contains('on'));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  ok('R4-13', '触摸长按能打开终端信息面板', sheetOn, `sheet.on=${sheetOn}`);

  // 鼠标长按
  await tp.waitForTimeout(500);
  await tp.mouse.move(box.x, box.y);
  await tp.mouse.down();
  await tp.waitForTimeout(1700);
  const sheetOn2 = await tp.evaluate(() => document.getElementById('sheet').classList.contains('on'));
  await tp.mouse.up();
  ok('R4-13b', '鼠标长按能打开终端信息面板', sheetOn2, `sheet.on=${sheetOn2}`);

  ok('TERM-ERR', '终端页无 JS 运行时错误', errs.length === 0 && terrs.length === 0,
    [...errs, ...terrs].slice(0, 3).join(' | '));

  await browser.close();
  let fail = 0;
  for (const r of results) {
    if (!r.pass) fail++;
    console.log(`${r.pass ? '✓' : '✗'} ${r.id}  ${r.title}\n    ${r.detail}`);
  }
  console.log(`\n通过 ${results.length - fail} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
