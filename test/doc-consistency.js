#!/usr/bin/env node
/**
 * 文档一致性检查
 *
 * README / 使用手册 里写的数字、字段、接口，必须和代码里的真值一致。
 * 文档过期是最难发现的一类 bug —— 这个脚本把它变成 CI 里的一声响。
 *
 * 用法：node test/doc-consistency.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const README = read('README.md');
const MANUAL = read('docs/使用手册.md');
const ARCH = read('docs/架构说明.md');
const SERVER = read('server/index.js');
const DB = read('server/db.js');
const SECRET = read('server/secret.js');
const ADMINJS = read('public/admin.js');
const EMPJS = read('public/employee.js');
const TERMJS = read('public/terminal.js');
const ENV = read('.env.example');
const PKG = JSON.parse(read('package.json'));

const results = [];
const ok = (id, title, pass, detail) => results.push({ id, title, pass, detail });

/* ── 1. 码的长度 ── */
ok('DOC-1', '邀请码 12 位（代码 = 文档）',
  /randomCode\(12\)/.test(SERVER) && /12 位/.test(MANUAL) && /12 位/.test(README),
  'server: randomCode(12)');
ok('DOC-2', '员工码 8 位（代码 = 文档）',
  /randomCode\(8\)/.test(SERVER) && /8 位/.test(MANUAL) && /8 位员工码/.test(README),
  'server: randomCode(8)');
ok('DOC-3', '终端会话码 8 位（代码 = 文档）',
  /randomBytes\(8\)/.test(DB) && /8 位/.test(MANUAL),
  'db.js: randomBytes(8)');
ok('DOC-4', '终端密钥 128 位（代码 = 文档）',
  /randomBytes\(16\)\.toString\('hex'\)/.test(SECRET) && /128 位/.test(README),
  'secret.js: randomBytes(16) → 32 hex = 128 bit');

/* ── 2. 默认参数 ── */
ok('DOC-5', '默认每周目标 24 小时 = 1440 分钟',
  /weeklyTargetMinutes.*1440/i.test(DB + SERVER) || /1440/.test(SERVER),
  'weeklyTargetMinutes 默认 1440');
ok('DOC-6', '每日封顶默认 12 小时 = 720 分钟',
  /dailyCapMinutes/.test(SERVER) && /720/.test(MANUAL + SERVER),
  'dailyCapMinutes');
ok('DOC-7', '午休窗口默认 12:00–13:00、阈值 45 分钟、扣 1 小时',
  /lunchMinOverlapMinutes/.test(SERVER) && /45 分钟/.test(MANUAL) && /≥ 45 分钟/.test(README),
  'lunchMinOverlapMinutes / lunchDeductionMinutes');
ok('DOC-8', '二维码有效期默认 45 秒',
  /SESSION_TTL_SECONDS=45/.test(ENV) && /45/.test(MANUAL) && /45 秒/.test(README),
  '.env.example + 文档');
ok('DOC-9', '时区默认 UTC+8 = 480',
  /TZ_OFFSET_MINUTES=480/.test(ENV) && /480/.test(MANUAL) && /480/.test(README),
  '.env.example + 文档');
ok('DOC-10', '周报推送默认周一 9 点',
  /REPORT_PUSH_HOUR/.test(ENV) && /REPORT_PUSH_HOUR/.test(SERVER) && /9 点/.test(MANUAL),
  '.env.example + reportScheduler');

/* ── 3. API 路径 ── */
for (const [id, path_, doc, label] of [
  ['DOC-11', '/api/health', MANUAL, '健康检查'],
  ['DOC-12', '/api/admin/report-push', MANUAL, '手动推送周报'],
  ['DOC-13', '/api/admin/export.csv', MANUAL, '导出 CSV'],
  ['DOC-14', '/api/auth/recover', MANUAL, '自助恢复'],
  // 服务端这条是正则匹配，写成两个片段分别核对
  ['DOC-15', 'reset-secret', MANUAL, '重置终端密钥'],
]) {
  // 服务端这条是用正则匹配的（源码里带转义反斜杠），所以按关键词核对
  const inServer = path_ === 'reset-secret'
    ? (SERVER.includes('terminals') && SERVER.includes('reset-secret'))
    : SERVER.includes(path_);
  ok(id, `${label} 接口存在且文档提到了`,
    inServer && doc.includes(path_), path_);
}

/* ── 4. 管理端五个 tab ── */
const ADMINHTML = read('public/admin.html');
for (const t of ['周报', '员工', '终端', '审批', '规则']) {
  ok(`DOC-tab-${t}`, `管理端有「${t}」页，文档提到了`,
    ADMINHTML.includes(`>${t}</button>`) && MANUAL.includes(`**${t}**`),
    `admin.html: >${t}</button>`);
}

/* ── 5. 员工端 / 终端端文案 ── */
ok('DOC-16', '员工端有「以前激活过？点这里恢复」入口（文档一致）',
  /btnRecover/.test(EMPJS) && /以前激活过/.test(read('public/index.html')) && /以前激活过/.test(MANUAL),
  'index.html + employee.js + 手册');
ok('DOC-17', '终端页有长按打开信息面板（文档提到）',
  /pressTimer/.test(TERMJS) && /长按/.test(MANUAL),
  'terminal.js');
ok('DOC-18', '员工端有手动输入终端码的兜底入口（文档提到）',
  /inpCode/.test(read('public/index.html')) && /手动输入/.test(MANUAL),
  'index.html');
ok('DOC-19', '离线提示文案与实现一致',
  /离线模式/.test(EMPJS) && /离线模式/.test(MANUAL) && /离线/.test(README),
  'employee.js + 文档');

/* ── 6. CSV 表头 ── */
const headerMatch = SERVER.match(/const header = \[([^\]]+)\]/);
const csvHeader = headerMatch
  ? headerMatch[1].split(',').map((x) => x.trim().replace(/^'|'$/g, ''))
  : [];
ok('DOC-20', `CSV 表头 ${csvHeader.length} 列，手册里写的是同一份`,
  csvHeader.length === 12
  && MANUAL.includes('姓名,工位,在岗小时,目标小时,差值小时,是否达标,出差小时,未签退天数,补卡分钟,补卡次数,员工码打卡次数,状态'),
  csvHeader.join(','));

/* ── 7. health 返回字段 ── */
for (const f of ['ok', 'secure', 'origin', 'rpID', 'configuredOrigins', 'employees', 'terminals', 'uptimeSec']) {
  ok(`DOC-health-${f}`, `health 返回 ${f}，手册示例里有`,
    SERVER.includes(f) && MANUAL.includes(`"${f}"`),
    f);
}

/* ── 8. npm scripts ── */
for (const [script, doc] of [
  ['start', 'npm start'], ['dev', 'npm run dev'], ['test', 'npm test'],
  ['e2e', 'npm run e2e'], ['backup', 'npm run backup'],
]) {
  ok(`DOC-script-${script}`, `package.json 有 ${script} 脚本，文档提到了`,
    PKG.scripts[script] && (README.includes(doc) || MANUAL.includes(doc)),
    doc);
}
ok('DOC-script-runall', '全量回归命令 node test/run-all.js 可用且文档提到',
  fs.existsSync(path.join(ROOT, 'test/run-all.js')) && README.includes('node test/run-all.js'),
  'test/run-all.js');

/* ── 9. Node 版本要求 ── */
ok('DOC-21', 'Node 版本要求一致（package.json = README = 手册）',
  PKG.engines.node === '>=22.13.0'
  && README.includes('22.13')
  && MANUAL.includes('22.13'),
  PKG.engines.node);

/* ── 10. 规则参数数量 ── */
const setFields = (ADMINJS.match(/\{ k: '/g) || []).length;
// 规则页的每个 label 都必须原样出现在手册里（名字一字不差）
const labels = (ADMINJS.match(/\{ k: '[^']+', label: '([^']+)'/g) || [])
  .map((x) => x.match(/label: '([^']+)'/)[1]);
const missing = labels.filter((l) => !MANUAL.includes(l));
ok('DOC-22', `管理端规则页 ${setFields} 项参数，手册里的名字一字不差`,
  setFields === 9 && missing.length === 0,
  missing.length ? '手册缺: ' + missing.join(' / ') : `${labels.length} 项全部对上`);

/* ── 11. 架构说明 ── */
{
  const fs2 = require('node:fs');
  const lineCount = (f) => fs2.readFileSync(path.join(ROOT, f), 'utf8').split('\n').length - 1;

  // 架构说明里写的行数要跟真值一致
  const claimed = {
    'server/index.js': 1136,
    'server/rules.js': 341,
    'server/db.js': 394,
    'server/webauthn.js': 135,
    'server/secret.js': 67,
  };
  const wrongLines = Object.entries(claimed)
    .filter(([f, n]) => lineCount(f) !== n)
    .map(([f, n]) => `${f}: 文档说 ${n}，实际 ${lineCount(f)}`);
  ok('DOC-23', '架构说明里的文件行数跟代码一致',
    wrongLines.length === 0, wrongLines.join('; ') || Object.keys(claimed).join(' '));

  // 依赖数量
  const deps = Object.keys(PKG.dependencies).length;
  ok('DOC-24', `架构说明说的依赖数量（${deps} 个）是对的`,
    deps === 3 && ARCH.includes(`其余全用 Node 标准库`) && ARCH.includes('`qrcode`'),
    `package.json 有 ${deps} 个依赖：${Object.keys(PKG.dependencies).join(', ')}`);

  // 表数量（注释里也有这句 CREATE TABLE，得排除掉）
  const dbSrc = read('server/db.js');
  const tables = dbSrc.split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    .filter((l) => l.includes('CREATE TABLE IF NOT EXISTS')).length;
  ok('DOC-25', `架构说明说的表数量（${tables} 张）是对的`,
    tables === 8 && ARCH.includes(`${tables} 张表`),
    `db.js 有 ${tables} 张表`);

  // 架构说明里列的 API 路由必须都真实存在
  const apiPaths = [...ARCH.matchAll(/`(\/api\/[a-z0-9\/:._-]+)`/g)].map((m) => m[1]);
  // 从服务端源码里反推真实路由，再跟架构说明列的路径比对
  const serverRoutes = new Set();
  for (const m of SERVER.matchAll(/p === '(\/api\/[^']+)'/g)) serverRoutes.add(m[1]);
  for (const m of SERVER.matchAll(/p\.match\(\/(\^\\\/api.+?)\$\/\)/g)) {
    // /^\/api\/terminal\/([^/]+)\/session$/ → /api/terminal/:id/session
    serverRoutes.add(
      m[1].replace(/^\^/, '').replace(/\$$/, '')
        .replace(/\\\//g, '/')
        .replace(/\(\[\^\/\]\+\)/g, ':id')   // 捕获组形式
        .replace(/\[\^\/\]\+/g, ':id')       // 非捕获形式
    );
  }
  // 把服务端路由编译成匹配器（支持 :id 和 (a|b|c) 分支），反向验证架构说明的路径
  const toMatcher = (route) => {
    let s = route.replace(/\./g, '\u0000');   // 先保护字面点号
    s = s.replace(/:id/g, '[^/]+');
    s = s.replace(/\u0000/g, '\\.');
    return new RegExp('^' + s + '$');
  };
  const matchers = [...serverRoutes].map(toMatcher);
  const badPaths = apiPaths.filter((p) => !matchers.some((re) => re.test(p)));
  ok('DOC-26', `架构说明里列的 ${apiPaths.length} 条 API 路径都真实存在`,
    badPaths.length === 0,
    badPaths.length
      ? '不存在: ' + badPaths.join(', ') + ' | 服务端实际有: ' + [...serverRoutes].sort().join(', ')
      : `${apiPaths.length} 条全部对上（服务端共 ${serverRoutes.size} 条路由）`);

  // 关键设计决策里的常量必须跟代码一致
  ok('DOC-27', '架构说明里的去重窗口（30 秒）跟代码一致',
    /DEDUPE_WINDOW_MS\s*=\s*30\s*\*\s*1000/.test(SERVER) && ARCH.includes('30 秒去重窗'),
    'DEDUPE_WINDOW_MS');
  ok('DOC-28', '架构说明里的 scrypt 参数跟代码一致',
    /N:\s*16384/.test(SECRET) && ARCH.includes('scrypt (N=16384)'),
    'secret.js SCRYPT.N');
  ok('DOC-29', '架构说明里的会话 TTL（45 秒）跟 .env.example 一致',
    /SESSION_TTL_SECONDS=45/.test(ENV) && ARCH.includes('45 秒'),
    '.env.example');
  ok('DOC-30', '架构说明提到的设备令牌强弱字段真实存在',
    /device_strong/.test(read('server/db.js')) && ARCH.includes('device_strong'),
    'db.js device_strong');
}

/* ── 输出 ── */
let fail = 0;
for (const r of results) {
  if (!r.pass) fail++;
  console.log(`${r.pass ? '✓' : '✗'} ${r.id}  ${r.title}${r.pass ? '' : '\n    ' + r.detail}`);
}
console.log(`\n通过 ${results.length - fail} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
