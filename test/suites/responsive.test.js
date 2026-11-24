// 响应式 + 触摸目标专项测试（覆盖 C 的 R2 系列）
const { chromium } = require('../pw.js');
const BASE = process.env.BASE || 'http://localhost:8099';
const results = [];
const ok = (id, title, pass, detail) => results.push({ id, title, pass, detail });

const VIEWPORTS = [
  { name: 'iphone', width: 390, height: 844, mobile: true },
  { name: 'ipad', width: 768, height: 1024, mobile: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
];

const PAGES = [
  { name: '员工端', path: '/' },
  { name: '管理端', path: '/admin' },
  { name: '终端端', path: '/terminal.html' },
];

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.mobile, hasTouch: vp.mobile,
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));

    // 管理端登录，好让周报有内容
    await page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
    if (vp.name !== 'desktop') {
      await page.fill('#admPass', 'test123').catch(() => {});
      await page.click('#btnLogin').catch(() => {});
      await page.waitForSelector('#s-main', { state: 'visible', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1800);
    }

    for (const p of PAGES) {
      await page.goto(BASE + p.path, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(p.name === '管理端' ? 2000 : 1200);
      if (p.name === '管理端') {
        await page.fill('#admPass', 'test123').catch(() => {});
        await page.click('#btnLogin').catch(() => {});
        await page.waitForSelector('#s-main', { state: 'visible', timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1800);
      }

      const m = await page.evaluate(() => {
        const doc = document.documentElement;
        const small = [];
        document.querySelectorAll('button, a, input[type=button], .tab').forEach((e) => {
          const r = e.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;
          if (getComputedStyle(e).display === 'none') return;
          if (r.height < 44) {
            small.push({
              tag: e.tagName, id: e.id, cls: String(e.className || '').slice(0, 34),
              w: Math.round(r.width), h: Math.round(r.height),
              text: (e.textContent || '').trim().slice(0, 18),
            });
          }
        });
        return {
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          innerWidth: window.innerWidth,
          small,
        };
      });

      ok(`R2-${vp.name}-${p.name}-scroll`, `${vp.name} ${p.name}：无横向滚动`,
        m.scrollWidth <= m.clientWidth + 1,
        `scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth} innerWidth=${m.innerWidth}`);

      ok(`R2-${vp.name}-${p.name}-touch`, `${vp.name} ${p.name}：触摸目标 ≥44px`,
        m.small.length === 0,
        m.small.length ? JSON.stringify(m.small.slice(0, 5)) : '全部达标');
    }

    ok(`R2-${vp.name}-err`, `${vp.name}：无 JS 运行时错误`, errs.length === 0, errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  await browser.close();
  let fail = 0;
  for (const r of results) {
    if (!r.pass) fail++;
    console.log(`${r.pass ? '✓' : '✗'} ${r.id}  ${r.title}\n    ${r.detail}`);
  }
  console.log(`\n通过 ${results.length - fail} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
