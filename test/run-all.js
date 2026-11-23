#!/usr/bin/env node
/**
 * 全量回归 runner
 *
 * 自己拉起服务（沙箱的常驻 background 进程不可靠，会被回收），
 * 依次跑所有测试，最后把服务关掉。一条命令跑完，退出码即结果。
 */
const { spawn, spawnSync, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8155);
const BASE = `http://localhost:${PORT}`;

const SUITES = [
  { name: '规则引擎单测', cmd: ['node', '--test', 'test/rules.test.js'] },
  { name: '方案对表测试', cmd: ['node', '--test', 'test-reports/api-parity.test.js', 'test-reports/edge-cases.test.js', 'test-reports/rules-spec-parity.test.js', 'test-reports/spec-math.test.js'] },
  { name: '安全审查', cmd: ['node', '--test', 'test/security.test.js'] },
  { name: '端到端（虚拟指纹）', cmd: ['node', 'test/e2e.js'] },
  { name: '自助恢复', cmd: ['node', 'test/recover.test.js'] },
  { name: '离线 / PWA', cmd: ['node', 'test/offline.test.js'] },
  { name: '终端大屏', cmd: ['node', 'test/terminal.test.js'] },
  { name: '响应式 / 触摸', cmd: ['node', 'test/responsive.test.js'] },
  { name: '本轮修复验证', cmd: ['node', 'test/fix-verify.js'] },
  { name: 'C 报告遗留项', cmd: ['node', 'test/c-fixes.test.js'] },
  { name: '文档一致性', cmd: ['node', 'test/doc-consistency.js'] },
];

let child = null;

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/api/health`, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

async function waitUp(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// 每次起服务用一个全新的临时库：测试造的几百个员工会把库撑大，
// 让 overview 查询变慢到超时，而且污染交付用的 data/presence.db
let dbSeq = 0;
const tempDbs = [];
function startServer() {
  const dbFile = path.join(ROOT, 'data', `.test-run-${process.pid}-${dbSeq++}.db`);
  tempDbs.push(dbFile);
  const p = spawn('node', ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'test123',
      RP_ID: process.env.RP_ID || 'localhost',
      APP_ORIGIN: BASE,
      DB_FILE: dbFile,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,      // 独立进程组，方便整组回收
  });
  p.unref();
  return p;
}

function cleanupDbs() {
  for (const f of tempDbs) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(f + suffix); } catch { /* 不存在 */ }
    }
  }
}

function stopServer(p) {
  if (!p || p.killed) return;
  try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch { /* noop */ } }
}

(async () => {
  // 预检：端口上如果还挂着上一轮遗留的服务，先踢掉。
  // 用 lsof 按端口找占用者 —— pgrep -f 会匹配到执行它的那条 shell 命令本身，
  // 结果把自己杀了，真正的服务反而没被清掉。
  try {
    const pids = execSync(`lsof -ti tcp:${PORT} 2>/dev/null || true`, { encoding: 'utf8' })
      .trim().split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch { /* 已经退出了 */ }
    }
    if (pids.length) await new Promise((r) => setTimeout(r, 800));
  } catch { /* 端口本来就空 */ }

  child = startServer();
  if (!await waitUp()) {
    console.error('✗ 服务没起来');
    stopServer(child);
    process.exit(1);
  }
  console.log(`服务已就绪 ${BASE}\n`);

  const results = [];
  for (const s of SUITES) {
    const t0 = Date.now();
    const r = spawnSync(s.cmd[0], s.cmd.slice(1), {
      cwd: ROOT,
      env: { ...process.env, BASE, PORT: String(PORT) },
      encoding: 'utf8',
      timeout: 300000,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const ok = r.status === 0;
    results.push({ name: s.name, ok, out, ms: Date.now() - t0 });
    const tail = out.trim().split('\n').filter(Boolean).slice(-2).join('\n    ');
    console.log(`${ok ? '✓' : '✗'} ${s.name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)\n    ${tail}`);
    if (!(await ping())) {
      console.log('  … 服务异常，重新拉起');
      stopServer(child);
      child = startServer();
      await waitUp();
    }
  }

  stopServer(child);
  cleanupDbs();
  const fail = results.filter((r) => !r.ok);
  console.log('\n═══════════════════════════════════');
  console.log(`通过 ${results.length - fail.length} / ${results.length} 个测试套件`);
  if (fail.length) {
    for (const f of fail) {
      console.log(`\n──── ${f.name} ────`);
      console.log(f.out.split('\n').filter((l) => /✗|not ok|失败|Error|错误/.test(l)).slice(0, 25).join('\n'));
    }
  }
  process.exit(fail.length ? 1 : 0);
})();

process.on('exit', () => { stopServer(child); cleanupDbs(); });
process.on('SIGINT', () => { stopServer(child); process.exit(130); });
process.on('SIGTERM', () => { stopServer(child); process.exit(143); });
