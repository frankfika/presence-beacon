// 本轮修复的专项验证
//  R5-20 / R5-20b  管理端「导出 CSV」能真正下载到文件（带 token 的 fetch + blob）
//  （终端闪屏相关由 test/terminal.test.js 完整覆盖）
const { chromium } = require('./pw.js');
const BASE = process.env.BASE || 'http://localhost:8099';

const results = [];
const ok = (id, title, pass, detail) => results.push({ id, title, pass, detail });

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  const adminErrs = [];
  admin.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/favicon|manifest|404 \(Not Found\)/.test(t)) adminErrs.push(t);
  });
  admin.on('pageerror', (e) => adminErrs.push('pageerror: ' + e.message));

  await admin.goto(BASE + '/admin', { waitUntil: 'networkidle' });
  await admin.fill('#admPass', process.env.ADMIN_PASSWORD || 'test123');
  await admin.click('#btnLogin');
  await admin.waitForSelector('#s-main', { state: 'visible', timeout: 15000 });
  await admin.waitForTimeout(1500);

  // 先造一个员工，让 CSV 不止一行
  await admin.evaluate(async () => {
    const tok = localStorage.getItem('pb.adminToken');
    await fetch('/api/admin/employees', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': tok },
      body: JSON.stringify({ name: '导出验证员', seat: 'X-01' }),
    });
  });
  await admin.waitForTimeout(800);

  const [download] = await Promise.all([
    admin.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    admin.click('#btnExport'),
  ]);

  if (download) {
    const p = await download.path();
    const text = require('node:fs').readFileSync(p, 'utf8');
    const lines = text.trim().split('\n');
    ok('R5-20', 'CSV 导出能真正下载到文件', lines.length >= 1 && lines[0].includes('姓名'),
      `${lines.length} 行 / ${text.length} 字节 / 表头: ${lines[0]}`);
    ok('R5-20b', 'CSV 内容不是错误 JSON', !text.trim().startsWith('{'),
      text.trim().slice(0, 40));
  } else {
    ok('R5-20', 'CSV 导出能真正下载到文件', false, '没有触发 download 事件');
    ok('R5-20b', 'CSV 内容不是错误 JSON', false, '没有触发 download 事件');
  }

  ok('ADMIN-ERR', '管理端无 JS 运行时错误', adminErrs.length === 0, adminErrs.slice(0, 3).join(' | '));

  await browser.close();
  let fail = 0;
  for (const r of results) {
    if (!r.pass) fail++;
    console.log(`${r.pass ? '✓' : '✗'} ${r.id}  ${r.title}\n    ${r.detail}`);
  }
  console.log(`\n通过 ${results.length - fail} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
