#!/usr/bin/env node
'use strict';
/**
 * 在岗哨 · 部署自检
 *
 * 部署完不确定配对没？跑一下这个。
 *   node scripts/doctor.js                      检查本机默认地址
 *   node scripts/doctor.js https://pb.你的域名   检查线上
 *   node scripts/doctor.js http://192.168.1.10:8080
 *   node scripts/doctor.js --self-test          自己起个临时实例冒烟测一遍
 *
 * 只读，不改任何东西。
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { spawn } = require('node:child_process');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const SELF_TEST = process.argv.includes('--self-test');
const target = SELF_TEST
  ? null
  : (process.argv[2] || process.env.APP_ORIGIN || 'http://localhost:8080');

const results = [];
let hardFail = 0;
let warn = 0;

function ok(title, pass, detail, level = 'error') {
  results.push({ title, pass, detail, level });
  if (!pass) {
    if (level === 'error') hardFail++;
    else warn++;
  }
}

function line(icon, title, detail, color) {
  console.log(`${icon} ${title}`);
  if (detail) console.log(`    ${detail}`);
}

/* ── HTTP 探测 ── */
function fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body || '{}') }); }
        catch { resolve({ status: res.statusCode, json: {}, raw: body }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: '超时' }); });
  });
}

/* ── 本地环境检查（不依赖服务在跑） ── */
function checkLocal() {
  // Node 版本
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  ok('Node 版本 ≥ 22.13（需要内置 node:sqlite）',
    major > 22 || (major === 22 && minor >= 13),
    `当前 ${process.versions.node}`,
    'warn');

  // .env
  const envPath = path.join(ROOT, '.env');
  const hasEnv = fs.existsSync(envPath);
  ok('.env 文件存在', hasEnv,
    hasEnv ? '' : '还没有 —— cp .env.example .env 并按说明改 RP_ID / APP_ORIGIN');

  let env = {};
  if (hasEnv) {
    env = Object.fromEntries(
      fs.readFileSync(envPath, 'utf8').split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    );
  }

  // RP_ID 格式
  const rpId = env.RP_ID || '';
  if (rpId) {
    const bad = rpId.startsWith('http') || rpId.includes(':') || rpId.includes('/');
    ok('RP_ID 是裸域名（不带 https://、端口、路径）', !bad,
      bad ? `现在是「${rpId}」—— 应该是 pb.你的公司.com 这种` : rpId);
  }

  // APP_ORIGIN 格式
  const origin = env.APP_ORIGIN || '';
  if (origin) {
    const trailing = origin.endsWith('/');
    const multi = origin.includes(',');
    ok('APP_ORIGIN 没有末尾斜杠', !trailing,
      trailing ? `现在是「${origin}」—— 末尾不能有 /` : origin);
    ok('APP_ORIGIN 是 HTTPS（或 localhost）', origin.startsWith('https://') || /http:\/\/(localhost|127\.0\.0\.1)/.test(origin),
      origin.startsWith('https://') || /localhost/.test(origin) ? origin
        : `现在是「${origin}」—— 非 localhost 的 http 会被浏览器禁用指纹`,
      'warn');
    if (!multi) {
      const m = origin.match(/^https?:\/\/([^/]+)/);
      if (m && rpId && m[1] !== rpId) {
        ok('RP_ID 和 APP_ORIGIN 的域名一致', false,
          `RP_ID=${rpId} 但域名是 ${m[1]} —— 两者必须一致，否则浏览器会拒绝指纹`);
      }
    }
  }

  // 时区
  const tz = env.TZ_OFFSET_MINUTES;
  if (tz !== undefined) {
    ok('时区偏移看起来合理', Number.isFinite(Number(tz)) && Math.abs(Number(tz)) <= 840,
      `TZ_OFFSET_MINUTES=${tz}（中国 = 480）`);
  }

  // 数据目录
  const dbFile = env.DB_FILE || './data/presence.db';
  const dbPath = path.isAbsolute(dbFile) ? dbFile : path.join(ROOT, dbFile);
  const dbExists = fs.existsSync(dbPath);
  ok('数据文件存在', dbExists,
    dbExists ? `${dbPath}（${(fs.statSync(dbPath).size / 1024).toFixed(0)} KB）`
      : `${dbPath} —— 还没建，首次启动会自动创建`);

  if (dbExists) {
    const st = fs.statSync(dbPath);
    ok('数据目录权限不过于开放', (st.mode & 0o077) === 0,
      `权限 ${(st.mode & 0o777).toString(8).padStart(3, '0')} —— 建议 0700`,
      'warn');
  }

  // 管理员口令
  const pwFile = path.join(path.dirname(dbPath), '.admin-password');
  if (fs.existsSync(pwFile)) {
    const st = fs.statSync(pwFile);
    ok('管理员口令文件权限是 0600', (st.mode & 0o777) === 0o600,
      `权限 ${(st.mode & 0o777).toString(8).padStart(3, '0')}`,
      'warn');
  } else if (!env.ADMIN_PASSWORD) {
    ok('管理员口令已设置', false,
      '还没有 —— 设 ADMIN_PASSWORD 环境变量，或启动一次让它自动生成', 'warn');
  } else {
    ok('管理员口令已设置（走环境变量）', true, '');
  }

  // 备份
  const backupScript = path.join(ROOT, 'scripts/backup.js');
  ok('备份脚本存在', fs.existsSync(backupScript), backupScript);

  // 时钟
  try {
    const d = new Date();
    const drift = Math.abs(d.getTime() - Date.now());
    ok('系统时钟正常', drift < 5000, `本地时间 ${d.toISOString()}`);
  } catch { /* noop */ }
}

/* ── 自检模式：自己起一个临时服务，检查完关掉 ── */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function selfTest() {
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const tmpDb = path.join(require('node:os').tmpdir(), `pb-doctor-${process.pid}.db`);
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* 不存在 */ }
  }

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DB_FILE: tmpDb,
      RP_ID: 'localhost',
      APP_ORIGIN: url,
      ADMIN_PASSWORD: 'doctor-self-test',
      TZ_OFFSET_MINUTES: '480',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', () => {});

  // 等它就绪
  let up = false;
  for (let i = 0; i < 60; i++) {
    const r = await fetchJson(`${url}/api/health`);
    if (r.status === 200) { up = true; break; }
    await new Promise((r2) => setTimeout(r2, 200));
  }

  ok('服务能启动', up, up ? `临时实例跑在 ${url}` : `起不来：${stderr.slice(-400)}`);

  if (up) {
    const h = (await fetchJson(`${url}/api/health`)).json || {};
    ok('健康检查 secure=true（指纹可用）', h.secure === true,
      h.secure === true ? 'localhost 属于安全上下文 ✓' : '不是安全上下文');
    ok('RP_ID 和访问域名对得上', h.rpID === 'localhost', `RP_ID=${h.rpID}`);
    ok('APP_ORIGIN 包含当前访问地址',
      (h.configuredOrigins || []).includes(url),
      `已配置：${(h.configuredOrigins || []).join(', ')}`);

    for (const [label, p] of [['员工端页面', '/'], ['管理端页面', '/admin']]) {
      const r = await fetchJson(`${url}${p}`);
      ok(`${label}可访问`, r.status === 200, `HTTP ${r.status}`);
    }
    ok('空库状态正常（0 员工 / 0 终端）', (h.employees || 0) === 0 && (h.terminals || 0) === 0,
      `${h.employees} 员工 / ${h.terminals} 终端`);
  }

  child.kill('SIGKILL');
  await new Promise((r2) => setTimeout(r2, 300));
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* 已清 */ }
  }
}

/* ── 远程服务检查 ── */
async function checkRemote() {
  const health = await fetchJson(`${target.replace(/\/$/, '')}/api/health`);
  ok('服务能访问', health.status === 200,
    health.status === 200 ? target : `${target} → ${health.error || 'HTTP ' + health.status}`);

  if (health.status !== 200) return;

  const h = health.json || {};

  ok('健康检查 secure=true（指纹可用）', h.secure === true,
    h.secure === true ? 'HTTPS ✓' : '当前不是 HTTPS —— 浏览器会禁用指纹，员工只能退回员工码');

  ok('RP_ID 与实际访问的域名一致', h.rpID === hostOf(target),
    `RP_ID=${h.rpID}，访问的是 ${hostOf(target)}`,
    'warn');

  ok('APP_ORIGIN 包含当前访问地址', (h.configuredOrigins || []).includes(target.replace(/\/$/, '')),
    `已配置：${(h.configuredOrigins || []).join(', ') || '（空）'}`,
    'warn');

  ok('数据库里有员工', (h.employees || 0) > 0,
    `${h.employees || 0} 个员工、${h.terminals || 0} 个终端`);

  ok('服务运行时长合理', (h.uptimeSec || 0) > 5, `已运行 ${h.uptimeSec} 秒`);

  // 员工端页面能开
  const page = await fetchJson(`${target.replace(/\/$/, '')}/`);
  ok('员工端页面可访问', page.status === 200, `HTTP ${page.status}`);

  // 管理端页面能开
  const admin = await fetchJson(`${target.replace(/\/$/, '')}/admin`);
  ok('管理端页面可访问', admin.status === 200, `HTTP ${admin.status}`);
}

function hostOf(u) {
  try { return new URL(u).host; } catch { return u; }
}

/* ── 主流程 ── */
(async () => {
  console.log(`\n在岗哨 · 部署自检`);
  if (SELF_TEST) {
    console.log('模式：自检（临时起一个实例，检查完关掉）');
  } else {
    console.log(`检查目标：${target}`);
  }
  console.log(`项目目录：${ROOT}\n`);

  if (SELF_TEST) {
    console.log('── 冒烟测试 ──');
    await selfTest();
  } else {
    console.log('── 本地配置 ──');
    checkLocal();

    console.log('\n── 线上服务 ──');
    await checkRemote();
  }

  console.log('\n════════════════════════════════════');
  for (const r of results) {
    if (r.pass) line('✓', r.title, r.detail);
    else line(r.level === 'warn' ? '!' : '✗', r.title, r.detail);
  }
  console.log('\n════════════════════════════════════');
  const total = results.length;
  console.log(`检查 ${total} 项 · 通过 ${total - hardFail - warn} · 提醒 ${warn} · 不通过 ${hardFail}`);

  if (hardFail) {
    console.log('\n有必须修的问题。先修掉标 ✗ 的，再上线。');
  } else if (warn) {
    console.log('\n没有致命问题，但标 ! 的建议看一眼。');
  } else {
    console.log('\n全部通过，可以用了。');
  }
  process.exit(hardFail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
