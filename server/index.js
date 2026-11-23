'use strict';
/**
 * 在岗哨 · HTTP 服务
 *
 * 单进程同时提供：静态页面 + JSON API + 二维码 SVG。
 * 零外部服务依赖，数据落在本地 SQLite 文件。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const QRCode = require('qrcode');

const { Store } = require('./db.js');
const { hashSecret, verifySecret, hashFast, randomCode, randomSecret, safeEqual } = require('./secret.js');
const { WebAuthnService } = require('./webauthn.js');
const R = require('./rules.js');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'presence.db');
const RP_NAME = process.env.RP_NAME || '在岗哨';
const RP_ID = process.env.RP_ID || 'localhost';
const APP_ORIGIN = process.env.APP_ORIGIN || '';
const TZ_OFFSET = Number(process.env.TZ_OFFSET_MINUTES || 480);

const store = new Store(DB_FILE);

// TZ_OFFSET_MINUTES 之前是死代码，这里真正接到 settings 上
if (process.env.TZ_OFFSET_MINUTES !== undefined && process.env.TZ_OFFSET_MINUTES !== '') {
  const off = Number(process.env.TZ_OFFSET_MINUTES);
  if (Number.isFinite(off)) store.setSetting('timezoneOffsetMinutes', String(off));
}
// APP_ORIGIN 可能写成 "https://x.com/" 或 "https://x.com,https://y.com"，
// 尾斜杠会让 simplewebauthn 直接抛 "not a valid expected origin"
const configuredOrigins = APP_ORIGIN
  ? [...new Set(APP_ORIGIN.split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean))]
  : [];

/** 请求实际来自哪个 origin（浏览器地址栏里的那个） */
function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

/** 允许的 origin 列表：请求的实际 origin 永远在最前面 */
function expectedOrigins(req) {
  return [...new Set([requestOrigin(req), ...configuredOrigins])];
}
const webauthn = new WebAuthnService(store, {
  rpName: RP_NAME,
  rpID: RP_ID,
  origins: configuredOrigins,
});

/* ── 管理员口令（只存哈希，明文不落库不进日志） ── */
function resolveAdminHash() {
  // 环境变量指定的：直接对它做哈希比对
  if (process.env.ADMIN_PASSWORD) return hashSecret(process.env.ADMIN_PASSWORD);
  const existing = store.getSetting('adminPasswordHash', '');
  if (existing) return existing;
  // 兼容旧版本明文设置
  const legacy = store.getSetting('adminPassword', '');
  if (legacy) {
    const h = hashSecret(legacy);
    store.setSetting('adminPasswordHash', h);
    store.setSetting('adminPassword', '');
    return h;
  }
  // 首次启动：生成随机口令，明文只写进一个 0600 的文件
  const gen = randomCode(14);
  store.setSetting('adminPasswordHash', hashSecret(gen));
  try {
    fs.writeFileSync(path.join(path.dirname(DB_FILE), '.admin-password'), gen + '\n', { mode: 0o600 });
  } catch { /* ignore */ }
  return hashSecret(gen);
}
const ADMIN_HASH = resolveAdminHash();

function adminToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 7 * 24 * 3600 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', ADMIN_HASH).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function isAdmin(req) {
  const tok = req.headers['x-admin-token'] || '';
  if (!tok) return false;
  const [payload, sig] = tok.split('.');
  if (!payload || !sig) return false;
  const expect = crypto.createHmac('sha256', ADMIN_HASH).update(payload).digest('base64url');
  if (sig.length !== expect.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Date.now() < exp;
  } catch { return false; }
}

/* ── 登录/邀请码/PIN 爆破限流 ── */
const rateState = new Map();
// 只有显式设置 TRUST_PROXY=1 才信任反代写入的 X-Forwarded-For。
// 否则任何人都能伪造这个 header 来绕过限流。
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}
function attemptAllowed(key, maxFails, windowMs, lockMs) {
  const now = Date.now();
  const st = rateState.get(key) || { fails: 0, firstFail: 0, lockedUntil: 0 };
  if (st.lockedUntil > now) {
    return { ok: false, st, retryAfterSec: Math.ceil((st.lockedUntil - now) / 1000) };
  }
  if (st.fails && now - st.firstFail > windowMs) { st.fails = 0; st.firstFail = 0; }
  rateState.set(key, st);
  return { ok: true, st, maxFails, lockMs };
}
function noteFail(key, st, maxFails, lockMs) {
  const now = Date.now();
  if (!st.firstFail) st.firstFail = now;
  st.fails++;
  if (st.fails >= maxFails) {
    st.lockedUntil = now + lockMs;
    st.fails = 0;
    st.firstFail = 0;
  }
  rateState.set(key, st);
}
function noteSuccess(key) { rateState.delete(key); }
// 定期清理，避免无限增长
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateState) {
    if (v.lockedUntil < now && !v.fails) rateState.delete(k);
  }
}, 60000).unref?.();

/* ── HTTP 辅助 ── */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), payment=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(payload);
}
function sendJson(res, status, obj) { send(res, status, obj); }
function fail(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch { return {}; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  if (rel === '/terminal' || rel === '/terminal/') rel = '/terminal.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end('404');
    return;
  }
  const ext = path.extname(file);
  const isHtml = ext === '.html';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': isHtml ? 'no-store' : 'public, max-age=300',
    ...SECURITY_HEADERS,
  });
  fs.createReadStream(file).pipe(res);
}

/* ── 业务辅助 ── */

/** 终端密钥校验：库里存哈希，比对用恒定时间 */
function terminalKeyOk(terminal, key) {
  if (!key || !terminal) return false;
  if (terminal.secret_hash) return safeEqual(hashFast(key), terminal.secret_hash);
  if (terminal.secret) return safeEqual(hashFast(key), hashFast(terminal.secret));
  return false;
}
function rulesConfig() {
  const s = store.allSettings();
  return {
    weekStartWd: Number(s.weekStartWd),
    dailyCapMinutes: Number(s.dailyCapMinutes),
    lunchStartMinute: Number(s.lunchStartMinute),
    lunchWindowMinutes: Number(s.lunchWindowMinutes),
    lunchMinOverlapMinutes: Number(s.lunchMinOverlapMinutes),
    lunchDeductionMinutes: Number(s.lunchDeductionMinutes),
    timezoneOffsetMinutes: Number(s.timezoneOffsetMinutes),
  };
}

function employeeSummary(emp) {
  return {
    id: emp.id,
    name: emp.name,
    seat: emp.seat,
    targetMinutes: emp.target_minutes,
    registered: store.listCredentials(emp.id).length > 0,
    hasPin: !!emp.pin,
  };
}

/** 计算某人的周状态 */
function statusFor(emp, weekStartKey) {
  const cfg = rulesConfig();
  const events = store.listEvents(emp.id, 0).map((e) => ({
    ts: e.ts, kind: e.kind, id: e.id,
  }));
  const approved = store.listExceptions(emp.id).filter((x) => x.status === 'approved');
  const result = R.computeAttendance(events, approved, cfg, Date.now());
  const st = R.weekStatus(result, weekStartKey, emp.target_minutes, Date.now());

  // 周窗口内的事件统计：弱验证（员工码）、自动闭合等
  const from = R.dateKeyToUtcMidnight(weekStartKey, cfg.timezoneOffsetMinutes);
  const to = from + 7 * 86400000;
  const weekEvents = store.listEventsBetween(emp.id, from, to);
  st.eventCount = weekEvents.length;
  st.weakCount = weekEvents.filter((e) => e.verify_method === 'pin').length;
  st.autoClosedCount = weekEvents.filter((e) => e.verify_method === 'auto-close').length;
  st.travelDays = st.travelDays || 0;
  return st;
}

/** 团队周报 */
function teamWeek(weekStartKey) {
  // 含已离职员工：本周有记录的仍然保留（历史时长不丢）
  const employees = store.listEmployees({ includeInactive: true });
  const allRows = employees.map((emp) => {
    const st = statusFor(emp, weekStartKey);
    return {
      employeeId: emp.id,
      name: emp.name,
      seat: emp.seat,
      active: !!emp.active,
      minutes: st.minutes,
      targetMinutes: st.targetMinutes,
      effectiveTargetMinutes: st.effectiveTargetMinutes,
      gapMinutes: st.gapMinutes,
      met: st.met,
      status: st.status,
      hasTravel: st.hasTravel,
      travelMinutes: st.travelMinutes,
      travelDays: st.travelDays,
      unclosedDays: st.unclosedDays,
      cappedDays: st.cappedDays,
      adjustmentMinutes: st.adjustmentMinutes,
      adjustmentCount: st.adjustmentCount,
      weakCount: st.weakCount,
      autoClosedCount: st.autoClosedCount,
      eventCount: st.eventCount,
      days: st.days.map((d) => ({
        date: d.date, minutes: d.minutes, countedMinutes: d.countedMinutes,
        travel: !!d.travel, capped: !!d.capped, unclosed: !!d.unclosed,
        segments: d.segments.length,
      })),
    };
  });
  // 在职员工全都要出现在周报里；已离职的只在当周确实有记录时保留
  const rows = allRows.filter((r) => r.active || r.minutes > 0 || r.hasTravel || r.adjustmentMinutes > 0);
  const activeRows = rows.filter((r) => r.active);

  // 全员远程的一周：规则挂起，不把任何人标成未达标
  const suspended = activeRows.length > 0
    && activeRows.every((r) => r.minutes === 0 && !r.hasTravel && r.adjustmentMinutes === 0);

  return {
    weekStart: weekStartKey,
    teamMinutes: rows.reduce((a, b) => a + b.minutes, 0),
    teamTargetMinutes: activeRows.reduce((a, b) => a + b.effectiveTargetMinutes, 0),
    metCount: suspended ? activeRows.length : activeRows.filter((r) => r.met).length,
    suspended,
    suspendedReason: suspended ? '全员远程周：本���不考核在岗时长' : null,
    rows,
  };
}

function csvEscape(v) {
  let s = v === null || v === undefined ? '' : String(v);
  // Excel/LibreOffice 会把以 = + - @ 开头的单元格当公式执行 → 前置单引号
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 该员工最后一条打卡事件 */
function lastEventFor(employeeId) {
  const events = store.listEvents(employeeId, 0);
  return events[events.length - 1] || null;
}

/**
 * 上一次「签进」太久没闭合（超过 14 小时），自动补一个合成「签退」，
 * 避免隔夜再打卡时被算成一段 15 小时的在岗区间。
 */
function autoCloseStale(employeeId, last) {
  const staleAfterMs = 14 * 3600 * 1000;
  if (Date.now() - last.ts <= staleAfterMs) return;
  const capMs = rulesConfig().dailyCapMinutes * 60000;
  store.addEvent({
    employeeId, ts: last.ts + capMs, kind: 'out',
    terminalId: last.terminal_id, verifyMethod: 'auto-close', note: '超过 14 小时未签退，系统自动闭合',
  });
}

/**
 * 手滑连按两次去重：同一员工在去重窗口内的第二次打卡直接忽略。
 * 不做这个去重的话，第二次会被当成「签退」把在岗区间提前关闭，
 * 后半天的时长全部丢失。
 */
const DEDUPE_WINDOW_MS = 30 * 1000;
/**
 * 人类可抄写的码统一大写后比较。
 * 手机输入法默认小写，而邀请码/员工码是随机大写字母数字 ——
 * 不做归一化的话，员工第一次激活就会因为大小写被拒，而且完全看不懂原因。
 */
function normCode(v) {
  return String(v || '').trim().toUpperCase();
}

function isDuplicateTap(employeeId, nowTs) {
  const events = store.listEvents(employeeId, 0);
  const last = events[events.length - 1];
  if (!last) return null;
  if (nowTs - last.ts >= DEDUPE_WINDOW_MS) return null;
  return last;
}

/** 终端在场状态 */
function terminalState(terminalId) {
  const weekStartKey = R.currentWeekStart(rulesConfig());
  const todayKey = R.dateKeyOf(Date.now(), rulesConfig().timezoneOffsetMinutes);
  const employees = store.listEmployees();
  const present = [];
  for (const emp of employees) {
    const events = store.listEvents(emp.id, 0);
    const last = events[events.length - 1];
    if (!last) continue;
    const isPresent = last.kind === 'in' && R.dateKeyOf(last.ts, rulesConfig().timezoneOffsetMinutes) === todayKey;
    if (isPresent) present.push({ id: emp.id, name: emp.name, seat: emp.seat, since: last.ts });
  }
  const teamMinutes = teamWeek(weekStartKey).teamMinutes;
  // 只暴露本终端产生的事件，不泄露全公司打卡流水
  const recent = store.listAllEvents(Date.now() - 3600 * 1000)
    .filter((e) => e.terminal_id === terminalId)
    .slice(-10)
    .map((e) => {
      const emp = store.getEmployee(e.employee_id);
      return { id: e.id, name: emp ? emp.name : '?', kind: e.kind, ts: e.ts, method: e.verify_method };
    });
  return {
    today: todayKey,
    weekStart: weekStartKey,
    present,
    teamMinutes,
    recent,
    totalPeople: employees.length,
  };
}

/* ── 定时周报推送 ── */
const REPORT_WEBHOOK = process.env.REPORT_WEBHOOK_URL || '';
const REPORT_PUSH_HOUR = Number(process.env.REPORT_PUSH_HOUR ?? 9);

function renderWeekText(weekStartKey) {
  const report = teamWeek(weekStartKey);
  const lines = [];
  lines.push(`📊 ${weekStartKey} 起的一周 · 在岗周报`);
  lines.push('');
  lines.push(`达标 ${report.metCount} / ${report.rows.filter((r) => r.active).length} 人 · 团队合计 ${R.formatMinutes(report.teamMinutes, 'decimal')} h`);
  if (report.suspended) lines.push(`（${report.suspendedReason}）`);
  lines.push('');
  for (const r of report.rows) {
    const flags = [];
    if (r.hasTravel) flags.push(`出差 ${R.formatMinutes(r.travelMinutes, 'decimal')}h`);
    if (r.adjustmentCount) flags.push(`补卡 ${r.adjustmentCount} 次`);
    if (r.weakCount) flags.push(`员工码 ${r.weakCount} 次`);
    if (r.unclosedDays) flags.push(`未签退 ${r.unclosedDays} 天`);
    if (!r.active) flags.push('已离职');
    lines.push(`${r.met ? '✅' : '❌'} ${r.name}：${R.formatMinutes(r.minutes, 'decimal')} / ${R.formatMinutes(r.effectiveTargetMinutes, 'decimal')} h${flags.length ? '（' + flags.join('、') + '）' : ''}`);
  }
  return { text: lines.join('\n'), report };
}

async function pushWeeklyReport(force = false) {
  if (!REPORT_WEBHOOK && !force) return { pushed: false, reason: '未配置 REPORT_WEBHOOK_URL' };
  // 推送刚结束的那一周
  const cfg = rulesConfig();
  const thisWeek = R.currentWeekStart(cfg);
  const lastWeek = new Date(Date.parse(thisWeek + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10);
  const { text, report } = renderWeekText(lastWeek);
  const payload = { weekStart: lastWeek, text, week: report, generatedAt: new Date().toISOString() };
  if (!REPORT_WEBHOOK) return { pushed: false, reason: '未配置 REPORT_WEBHOOK_URL', payload };
  try {
    const res = await fetch(REPORT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const ok = res.ok;
    if (ok) store.setSetting('lastReportPush', String(Date.now()));
    return { pushed: ok, status: res.status, payload };
  } catch (e) {
    return { pushed: false, error: e.message };
  }
}

function reportScheduler() {
  if (!REPORT_WEBHOOK) return;
  const now = new Date();
  if (now.getHours() !== REPORT_PUSH_HOUR || now.getMinutes() !== 0) return;
  const todayKey = R.dateKeyOf(Date.now(), rulesConfig().timezoneOffsetMinutes);
  const last = store.getSetting('lastReportPushDate', '');
  if (last === todayKey) return;
  store.setSetting('lastReportPushDate', todayKey);
  pushWeeklyReport().then((r) => {
    if (r.pushed) console.log('[report] 周报已推送', r.payload.weekStart);
    else console.warn('[report] 周报推送失败', r.error || r.reason);
  });
}
setInterval(reportScheduler, 30000).unref?.();

/* ── 定期把 WAL 合并回主库 ──
 * SQLite 的 WAL 模式下数据可能还躺在 presence.db-wal 里，
 * 直接 cp presence.db 会丢掉最近的数据（而且不报错）。
 * 这里定期 checkpoint，让「复制主库」这种土办法也基本安全。
 */
function walCheckpoint() {
  try {
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (e) {
    console.warn('[wal] checkpoint 失败', e.message);
  }
}
setInterval(walCheckpoint, 60000).unref?.();

/* ── 路由 ── */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const q = url.searchParams;

  try {
    /* ───── 健康检查 ───── */
    if (p === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        secure: requestOrigin(req).startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin(req)),
        origin: requestOrigin(req),
        rpID: RP_ID,
        configuredOrigins,
        employees: store.listEmployees().length,
        terminals: store.listTerminals().length,
        uptimeSec: Math.round(process.uptime()),
      });
    }

    /* ───── 公共 ───── */
    if (p === '/api/bootstrap' && req.method === 'GET') {
      // 只暴露员工端真正需要的字段（花名册在办公室里本来就是公开信息）
      const employees = store.listEmployees().map((e) => ({
        id: e.id, name: e.name, seat: e.seat,
        registered: store.listCredentials(e.id).length > 0,
      }));
      const terminals = store.listTerminals();
      return sendJson(res, 200, {
        employees,
        terminals: terminals.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name, location: t.location })),
        config: {
          weekStartWd: rulesConfig().weekStartWd,
          weeklyTargetMinutes: Number(store.getSetting('weeklyTargetMinutes')),
          timezoneOffsetMinutes: rulesConfig().timezoneOffsetMinutes,
          sessionTtlSeconds: Number(store.getSetting('sessionTtlSeconds')),
        },
        serverTime: Date.now(),
      });
    }

    /* ───── 注册（邀请码） ───── */
    if (p === '/api/auth/register-options' && req.method === 'POST') {
      const body = await readBody(req);
      const emp = store.getEmployee(body.employeeId);
      // 限流键只按员工走，不绑 IP —— 否则伪造 XFF 就能换一个桶继续爆破
      const rl = attemptAllowed(`invite:${body.employeeId}`, 8, 10 * 60 * 1000, 10 * 60 * 1000);
      if (!rl.ok) return fail(res, 429, `尝试次数过多，请 ${rl.retryAfterSec} 秒后再试`);
      // 统一错误文案，避免通过错误信息枚举员工是否存在
      const inviteOk = emp && emp.invite_code && normCode(body.inviteCode) === emp.invite_code.toUpperCase();
      // 追加凭证（换手机 / 重新登记）：需要「强设备令牌」——
      // 也就是用指纹断言换来的令牌。弱令牌（姓名+员工码恢复的）不给追加，
      // 否则拿到员工码就能在别人手机上注册一个假指纹。
      const addOn = !!(emp && emp.device_strong && store.verifyDeviceToken(emp.id, body.deviceToken)
        && store.listCredentials(emp.id).length);
      if (!inviteOk && !addOn) {
        noteFail(`invite:${body.employeeId}`, rl.st, 8, 10 * 60 * 1000);
        return fail(res, 403, '员工或邀请码不正确');
      }
      noteSuccess(`invite:${body.employeeId}`);
      if (store.listCredentials(emp.id).length && !addOn) return fail(res, 400, '该员工已登记过生物特征');
      const { challengeId, options } = await webauthn.registrationOptions({ employee: emp });
      return sendJson(res, 200, { challengeId, options, addOn });
    }

    if (p === '/api/auth/register-verify' && req.method === 'POST') {
      const body = await readBody(req);
      const emp = store.getEmployee(body.employeeId);
      if (!emp) return fail(res, 404, '员工不存在');
      const inviteOk = emp.invite_code && normCode(body.inviteCode) === emp.invite_code.toUpperCase();
      const addOn = !!(emp.device_strong && store.verifyDeviceToken(emp.id, body.deviceToken)
        && store.listCredentials(emp.id).length);
      if (!inviteOk && !addOn) {
        return fail(res, 403, '邀请码不正确');
      }
      await webauthn.verifyRegistration({
        employee: emp, response: body.response, challengeId: body.challengeId,
        origin: expectedOrigins(req),
      });
      store.updateEmployee(emp.id, { invite_code: null });
      const deviceToken = crypto.randomBytes(24).toString('base64url');
      store.setDeviceToken(emp.id, deviceToken, 1);   // 指纹登记 → 强令牌
      return sendJson(res, 200, { ok: true, deviceToken, employeeId: emp.id, strong: true });
    }

    /* ───── 打卡：认证选项 ───── */
    if (p === '/api/auth/assert-options' && req.method === 'POST') {
      const body = await readBody(req);
      let emp = body.employeeId ? store.getActiveEmployee(body.employeeId) : null;
      // 恢复场景：本地数据丢了，只记得姓名 —— 按姓名找员工。
      // 这里只发 challenge 和 credential id，不验证任何东西，
      // 真正的身份确认在 assert-verify（必须通过指纹/面容签名）。
      if (!emp && body.employeeName) {
        const key = `recover:${String(body.employeeName).trim().toLowerCase()}`;
        const rl = attemptAllowed(key, 8, 10 * 60 * 1000, 5 * 60 * 1000);
        if (!rl.ok) return fail(res, 429, `尝试次数过多，请 ${rl.retryAfterSec} 秒后再试`);
        const cands = store.listEmployees({ includeInactive: false })
          .filter((e) => e.name === String(body.employeeName).trim());
        if (cands.length === 1) emp = cands[0];
        else noteFail(key, rl.st, 8, 10 * 60 * 1000);
      }
      // 统一文案：不要通过错误信息区分「人不存在」和「没登记指纹」
      if (!emp) return fail(res, 404, '找不到这个员工，或他还没有登记指纹');
      if (!store.verifyDeviceToken(emp.id, body.deviceToken) && !body.recover) {
        return fail(res, 403, '设备未登记，请重新激活');
      }
      if (body.sessionId) {
        const sess = store.getSession(body.sessionId);
        if (!sess) return fail(res, 404, '二维码无效，请重新扫码');
        if (sess.expires_at < Date.now()) return fail(res, 410, '二维码已过期，请重新扫');
        if (sess.used_at) return fail(res, 409, '这个二维码已经用过了');
      }

      // 意图由客户端明确给出（'in' / 'out'），服务端只做校验，不再盲猜。
      // 这样「手滑连按两次签进」会被拦，而「签进 → 签退」不受影响。
      const last = lastEventFor(emp.id);
      const action = body.action === 'out' ? 'out' : 'in';
      if (action === 'out' && (!last || last.kind !== 'in')) {
        return fail(res, 409, '你当前不在岗状态，请先签进');
      }
      if (action === 'in' && last && last.kind === 'in'
          && Date.now() - last.ts < DEDUPE_WINDOW_MS) {
        // 刚刚已经签过了，连指纹都不用按
        return sendJson(res, 200, { duplicate: true, kind: 'in', at: last.ts });
      }

      const { challengeId, options } = await webauthn.authenticationOptions({
        employee: emp, sessionId: body.sessionId || null,
      });
      return sendJson(res, 200, { challengeId, options, action });
    }

    /* ───── 打卡：验证并落库 ───── */
    if (p === '/api/auth/assert-verify' && req.method === 'POST') {
      const body = await readBody(req);
      let emp = body.employeeId ? store.getActiveEmployee(body.employeeId) : null;
      // 恢复场景：本地数据丢了，只知道姓名 —— 从 challenge 里取回员工
      if (!emp) {
        const ch = store.peekChallenge(body.challengeId);
        if (ch && ch.kind === 'assert') emp = store.getActiveEmployee(ch.employee_id);
      }
      if (!emp) return fail(res, 404, '员工不存在');
      // 设备令牌对不上时，只允许「恢复模式」：这次断言成功后
      // 会重新签发一把强令牌（指纹验证过 = 强身份）
      const tokenStale = !store.verifyDeviceToken(emp.id, body.deviceToken);
      if (tokenStale && !body.recover) return fail(res, 403, '设备未登记');
      await webauthn.verifyAuthentication({
        employee: emp, response: body.response, challengeId: body.challengeId,
        origin: expectedOrigins(req),
      });

      // 指纹/面容验证通过 → 重新绑定这台设备，签发强令牌
      let rebound = null;
      if (tokenStale) {
        rebound = crypto.randomBytes(24).toString('base64url');
        store.setDeviceToken(emp.id, rebound, 1);
      }

      // 纯恢复请求：只重新绑定设备，不产生任何打卡记录
      if (body.recover) {
        return sendJson(res, 200, {
          ok: true, recovered: true,
          employeeId: emp.id,
          deviceToken: rebound || body.deviceToken,
          employee: employeeSummary(emp),
          strong: true,
          hint: '指纹验证通过，这台手机已重新激活。',
        });
      }

      let terminalId = null;
      if (body.sessionId) {
        const sess = store.getSession(body.sessionId);
        if (!sess) return fail(res, 404, '二维码无效');
        if (sess.expires_at < Date.now()) return fail(res, 410, '二维码已过期，请重新扫');
        if (sess.used_at) return fail(res, 409, '这个二维码已经用过了');
        // 原子占用：并发提交时只有一个能成功
        if (!store.claimSession(body.sessionId, emp.id)) {
          return fail(res, 409, '这个二维码已经用过了');
        }
        terminalId = sess.terminal_id;
      }

      const now = Date.now();
      const action = body.action === 'out' ? 'out' : 'in';
      const last = lastEventFor(emp.id);

      // 双保险：服务端再查一次 30 秒去重窗（防止并发/竞态）
      // 但「刚签进 → 现在签退」是合法的一对，不算重复
      const dup = isDuplicateTap(emp.id, now);
      const legitSignOut = action === 'out' && dup && dup.kind === 'in';
      if (dup && !legitSignOut) {
        const st0 = statusFor(emp, R.currentWeekStart(rulesConfig()));
        return sendJson(res, 200, {
          ok: true, duplicate: true, kind: dup.kind, at: dup.ts,
          deviceToken: rebound || undefined,
          week: {
            weekStart: st0.weekStart, minutes: st0.minutes, targetMinutes: st0.targetMinutes,
            gapMinutes: st0.gapMinutes, met: st0.met, status: st0.status, daysLeft: st0.daysLeft,
          },
        });
      }

      let kind;
      if (action === 'out') {
        if (!last || last.kind !== 'in') return fail(res, 409, '你当前不在岗状态，请先签进');
        kind = 'out';
      } else {
        if (last && last.kind === 'in') {
          // 上一次 in 太久没闭合 → 先自动补一个 out，再重新签进
          autoCloseStale(emp.id, last);
        }
        kind = 'in';
      }
      const ev = store.addEvent({
        employeeId: emp.id, ts: now, kind, terminalId,
        sessionId: body.sessionId || null, verifyMethod: 'webauthn',
      });

      const weekStartKey = R.currentWeekStart(rulesConfig());
      const st = statusFor(emp, weekStartKey);
      return sendJson(res, 200, {
        ok: true, kind, at: now,
        deviceToken: rebound || undefined,
        week: {
          weekStart: st.weekStart,
          minutes: st.minutes,
          targetMinutes: st.targetMinutes,
          gapMinutes: st.gapMinutes,
          met: st.met,
          status: st.status,
          daysLeft: st.daysLeft,
        },
      });
    }

    /* ───── 自助恢复：本地数据丢了 / 换手机 ─────
     * 员工清了浏览器缓存或换了手机 → deviceToken 没了 → 之前只能找管理员。
     * 这里给一条自助通道：姓名 + 工位 + 8 位员工码 → 重新绑定这台设备。
     * 这是「弱验证」（等同于员工码打卡本身的强度），所以签发的是弱令牌：
     * 弱令牌不能追加新的生物特征凭证（否则拿到员工码就能注册假指纹占坑）。
     * 想恢复成强令牌：用手机上的旧指纹做一次断言即可（assert-verify 会自动换发强令牌）。
     */
    if (p === '/api/auth/recover' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const seat = String(body.seat || '').trim();
      if (!name) return fail(res, 400, '请填写姓名');
      const rl = attemptAllowed(`recover:${name.toLowerCase()}`, 8, 10 * 60 * 1000, 5 * 60 * 1000);
      if (!rl.ok) return fail(res, 429, `尝试次数过多，请 ${rl.retryAfterSec} 秒后再试`);

      const cands = store.listEmployees({ includeInactive: false })
        .filter((e) => e.name === name && (!seat || String(e.seat || '').trim() === seat));
      const emp = cands.length === 1 ? cands[0] : null;
      const pinOk = emp && (emp.pin_hash ? verifySecret(body.pin, emp.pin_hash, true)
        : (emp.pin && safeEqual(normCode(body.pin), emp.pin)));
      if (!pinOk) {
        noteFail(`recover:${name.toLowerCase()}`, rl.st, 8, 10 * 60 * 1000);
        // 同名多人时提示补工位，但不要泄露「这个姓名是否存在」
        return fail(res, 403, cands.length > 1 ? '有重名的同事，请补充工位' : '姓名或员工码不正确');
      }
      noteSuccess(`recover:${name.toLowerCase()}`);
      const deviceToken = crypto.randomBytes(24).toString('base64url');
      store.setDeviceToken(emp.id, deviceToken, 0);   // 弱令牌
      return sendJson(res, 200, {
        ok: true, deviceToken, employeeId: emp.id,
        employee: employeeSummary(emp),
        weak: true,
        hint: '已用员工码恢复。若手机上的指纹还在，建议再按一次指纹升级为强验证。',
      });
    }

    /* ───── 打卡：PIN 兜底 ───── */
    if (p === '/api/checkin/pin' && req.method === 'POST') {
      const body = await readBody(req);
      const emp = store.getActiveEmployee(body.employeeId);
      if (!emp) return fail(res, 403, '员工或员工码不正确');
      const rl = attemptAllowed(`pin:${emp.id}`, 8, 10 * 60 * 1000, 5 * 60 * 1000);
      if (!rl.ok) return fail(res, 429, `员工码尝试次数过多，请 ${rl.retryAfterSec} 秒后再试`);
      const pinOk = emp.pin_hash ? verifySecret(body.pin, emp.pin_hash, true) : (emp.pin && safeEqual(normCode(body.pin), emp.pin));
      if (!pinOk) {
        noteFail(`pin:${emp.id}`, rl.st, 8, 10 * 60 * 1000);
        return fail(res, 403, '员工或员工码不正确');
      }
      noteSuccess(`pin:${emp.id}`);
      let terminalId = null;
      if (body.sessionId) {
        const sess = store.getSession(body.sessionId);
        if (!sess) return fail(res, 404, '二维码无效');
        if (sess.expires_at < Date.now()) return fail(res, 410, '二维码已过期，请重新扫');
        if (sess.used_at) return fail(res, 409, '这个二维码已经用过了');
        // 原子占用：并发提交时只有一个能成功
        if (!store.claimSession(body.sessionId, emp.id)) {
          return fail(res, 409, '这个二维码已经用过了');
        }
        terminalId = sess.terminal_id;
      }
      const now = Date.now();
      const action = body.action === 'out' ? 'out' : 'in';
      const last = lastEventFor(emp.id);
      const dup = isDuplicateTap(emp.id, now);
      const legitSignOut = action === 'out' && dup && dup.kind === 'in';
      if (dup && !legitSignOut) {
        const st0 = statusFor(emp, R.currentWeekStart(rulesConfig()));
        return sendJson(res, 200, {
          ok: true, duplicate: true, kind: dup.kind, at: dup.ts, weak: true,
          week: { weekStart: st0.weekStart, minutes: st0.minutes, targetMinutes: st0.targetMinutes, gapMinutes: st0.gapMinutes, met: st0.met },
        });
      }
      let kind;
      if (action === 'out') {
        if (!last || last.kind !== 'in') return fail(res, 409, '你当前不在岗状态，请先签进');
        kind = 'out';
      } else {
        if (last && last.kind === 'in') autoCloseStale(emp.id, last);
        kind = 'in';
      }
      const ev = store.addEvent({
        employeeId: emp.id, ts: now, kind, terminalId,
        sessionId: body.sessionId || null, verifyMethod: 'pin', note: '员工码打卡（弱验证）',
      });
      const weekStartKey = R.currentWeekStart(rulesConfig());
      const st = statusFor(emp, weekStartKey);
      return sendJson(res, 200, {
        ok: true, kind, at: now, weak: true,
        week: { weekStart: st.weekStart, minutes: st.minutes, targetMinutes: st.targetMinutes, gapMinutes: st.gapMinutes, met: st.met },
      });
    }

    /* ───── 我的状态 ───── */
    if (p === '/api/me' && req.method === 'GET') {
      const emp = store.getActiveEmployee(q.get('employeeId'));
      if (!emp) return fail(res, 404, '员工不存在');
      if (!store.verifyDeviceToken(emp.id, q.get('deviceToken'))) return fail(res, 403, '设备未登记');
      const weekStartKey = q.get('week') || R.currentWeekStart(rulesConfig());
      const st = statusFor(emp, weekStartKey);
      const events = store.listEvents(emp.id, 0).slice(-8).map((e) => ({ ts: e.ts, kind: e.kind, method: e.verify_method }));
      const lastEv = events[events.length - 1] || null;
      return sendJson(res, 200, {
        employee: employeeSummary(emp),
        lastEvent: lastEv,
        nextAction: lastEv && lastEv.kind === 'in' ? 'out' : 'in',
        week: {
          weekStart: st.weekStart, minutes: st.minutes, targetMinutes: st.targetMinutes,
          effectiveTargetMinutes: st.effectiveTargetMinutes, gapMinutes: st.gapMinutes,
          met: st.met, status: st.status, daysLeft: st.daysLeft, hasTravel: st.hasTravel,
          travelMinutes: st.travelMinutes, unclosedDays: st.unclosedDays,
          days: st.days.map((d) => ({ date: d.date, minutes: d.minutes })),
        },
        recentEvents: events,
      });
    }

    /* ───── 员工提交例外（请假 / 出差 / 补卡） ───── */
    if (p === '/api/exceptions' && req.method === 'POST') {
      const body = await readBody(req);
      const emp = store.getActiveEmployee(body.employeeId);
      if (!emp) return fail(res, 404, '员工不存在');
      if (!store.verifyDeviceToken(emp.id, body.deviceToken)) return fail(res, 403, '设备未登记');
      const type = ['leave', 'travel', 'adjust', 'holiday'].includes(body.type) ? body.type : null;
      if (!type) return fail(res, 400, '类型不合法');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) return fail(res, 400, '日期格式应为 YYYY-MM-DD');
      const minutes = Math.max(0, Math.min(24 * 60, Number(body.minutes) || 0));
      const ex = store.addException({
        employeeId: emp.id, date: body.date, type, minutes,
        note: body.note || null, status: 'pending',
      });
      return sendJson(res, 200, { ok: true, exception: ex });
    }

    /* ───── 终端 ───── */
    const tMatch = p.match(/^\/api\/terminal\/([^/]+)\/(session|qr\.svg|state)$/);
    if (tMatch) {
      const terminal = store.getTerminal(tMatch[1]);
      if (!terminal) return fail(res, 404, '终端不存在');
      const key = req.headers['x-terminal-key'];
      if (!terminalKeyOk(terminal, key)) return fail(res, 403, '终端密钥错误');
      if (!terminal.active) return fail(res, 403, '终端已停用');
      store.touchTerminal(terminal.id);

      if (tMatch[2] === 'session' && req.method === 'POST') {
        store.cleanSessions();
        const ttl = Number(store.getSetting('sessionTtlSeconds'));
        const sess = store.createSession(terminal.id, ttl);
        return sendJson(res, 200, {
          sessionId: sess.id,
          payload: `PB1:${sess.id}`,
          expiresAt: sess.expiresAt,
          ttlSeconds: ttl,
        });
      }
      if (tMatch[2] === 'qr.svg' && req.method === 'GET') {
        const sid = q.get('session');
        const sess = store.getSession(sid);
        if (!sess || sess.terminal_id !== terminal.id) return fail(res, 404, '会话不存在');
        const svg = await QRCode.toString(`PB1:${sess.id}`, {
          type: 'svg', margin: 1, width: 320, errorCorrectionLevel: 'M',
          color: { dark: '#14171e', light: '#ffffff' },
        });
        return send(res, 200, svg, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
      }
      if (tMatch[2] === 'state' && req.method === 'GET') {
        return sendJson(res, 200, terminalState(terminal.id));
      }
    }

    /* ───── 管理端 ───── */
    if (p === '/api/admin/login' && req.method === 'POST') {
      const body = await readBody(req);
      const rl = attemptAllowed(`admin:${clientIp(req)}`, 5, 15 * 60 * 1000, 15 * 60 * 1000);
      if (!rl.ok) return fail(res, 429, `登录尝试次数过多，请 ${rl.retryAfterSec} 秒后再试`);
      if (!verifySecret(String(body.password || ''), ADMIN_HASH)) {
        noteFail(`admin:${clientIp(req)}`, rl.st, 5, 15 * 60 * 1000);
        return fail(res, 403, '口令不正确');
      }
      noteSuccess(`admin:${clientIp(req)}`);
      return sendJson(res, 200, { token: adminToken() });
    }

    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return fail(res, 401, '需要管理员登录');
    }

    if (p === '/api/admin/report-preview' && req.method === 'GET') {
      const wk = q.get('week') || R.currentWeekStart(rulesConfig());
      const { text, report } = renderWeekText(wk);
      return sendJson(res, 200, { text, week: report });
    }

    if (p === '/api/admin/report-push' && req.method === 'POST') {
      const r = await pushWeeklyReport(true);
      return sendJson(res, r.pushed ? 200 : 502, r);
    }

    if (p === '/api/admin/overview' && req.method === 'GET') {
      const weekStartKey = q.get('week') || R.currentWeekStart(rulesConfig());
      return sendJson(res, 200, {
        week: teamWeek(weekStartKey),
        config: rulesConfig(),
        settings: {
          weeklyTargetMinutes: Number(store.getSetting('weeklyTargetMinutes')),
          sessionTtlSeconds: Number(store.getSetting('sessionTtlSeconds')),
        },
        employees: store.listEmployees().map(employeeSummary),
        terminals: store.listTerminals().map((t) => ({
          id: t.id, name: t.name, location: t.location, active: t.active,
          lastSeen: t.last_seen || null,
          offlineMinutes: t.last_seen ? Math.round((Date.now() - t.last_seen) / 60000) : null,
        })),
        pendingExceptions: store.listExceptions().filter((x) => x.status === 'pending'),
        exceptions: store.listExceptions(),
      });
    }

    if (p === '/api/admin/employees' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.name) return fail(res, 400, '请填写姓名');
      // 邀请码 12 位（60 bit 熵）、员工码 8 位并只存哈希
      const inviteCode = randomCode(12);
      const pin = randomCode(8);
      const emp = store.createEmployee({
        name: String(body.name).slice(0, 40),
        seat: body.seat ? String(body.seat).slice(0, 40) : null,
        targetMinutes: body.targetMinutes ? Number(body.targetMinutes) : null,
        inviteCode, pinHash: hashSecret(pin),
      });
      return sendJson(res, 200, { employee: employeeSummary(emp), inviteCode, pin });
    }

    if (p.match(/^\/api\/admin\/employees\/[^/]+$/) && req.method === 'PATCH') {
      const id = p.split('/')[4];
      const body = await readBody(req);
      const patch = {};
      if (body.name !== undefined) patch.name = String(body.name).slice(0, 40);
      if (body.seat !== undefined) patch.seat = body.seat ? String(body.seat).slice(0, 40) : null;
      if (body.targetMinutes !== undefined) patch.target_minutes = Number(body.targetMinutes);
      if (body.active !== undefined) patch.active = body.active ? 1 : 0;
      if (body.pin !== undefined) { patch.pin_hash = hashSecret(String(body.pin)); patch.pin = null; }
      const emp = store.updateEmployee(id, patch);
      if (!emp) return fail(res, 404, '员工不存在');
      return sendJson(res, 200, { employee: employeeSummary(emp) });
    }

    if (p.match(/^\/api\/admin\/employees\/[^/]+\/invite$/) && req.method === 'POST') {
      const id = p.split('/')[4];
      const emp = store.getEmployee(id);
      if (!emp) return fail(res, 404, '员工不存在');
      if (store.listCredentials(id).length) return fail(res, 400, '该员工已登记指纹，重置邀请码没有意义');
      const inviteCode = randomCode(12);
      store.updateEmployee(id, { invite_code: inviteCode });
      return sendJson(res, 200, { inviteCode });
    }

    if (p.match(/^\/api\/admin\/employees\/[^/]+$/) && req.method === 'DELETE') {
      const id = p.split('/')[4];
      const emp = store.getEmployee(id);
      if (!emp) return fail(res, 404, '员工不存在');
      // 软删除：清掉生物凭据与登录凭据，但保留历史打卡记录
      store.db.prepare('DELETE FROM credentials WHERE employee_id=?').run(id);
      store.updateEmployee(id, {
        active: 0, invite_code: null, device_token_hash: null, pin: null,
      });
      return sendJson(res, 200, { ok: true, softDeleted: true, note: '历史打卡记录已保留' });
    }

    if (p === '/api/admin/terminals' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.name) return fail(res, 400, '请填写终端名称');
      const secret = randomSecret();
      const t = store.createTerminal({
        name: String(body.name).slice(0, 40),
        location: body.location || null,
        secretHash: hashFast(secret),
        secretHint: secret.slice(-6),
      });
      return sendJson(res, 200, {
        terminal: { id: t.id, name: t.name, location: t.location, secretHint: t.secret_hint },
        secret,   // 明文只在创建时返回这一次
      });
    }

    if (p.match(/^\/api\/admin\/terminals\/[^/]+\/reset-secret$/) && req.method === 'POST') {
      const id = p.split('/')[4];
      const t = store.getTerminal(id);
      if (!t) return fail(res, 404, '终端不存在');
      const secret = randomSecret();
      store.updateTerminal(id, { secret_hash: hashFast(secret), secret_hint: secret.slice(-6) });
      return sendJson(res, 200, { secret, terminal: { id: t.id, secretHint: secret.slice(-6) } });
    }

    if (p.match(/^\/api\/admin\/terminals\/[^/]+$/) && req.method === 'PATCH') {
      const id = p.split('/')[4];
      const body = await readBody(req);
      const patch = {};
      if (body.name !== undefined) patch.name = String(body.name).slice(0, 40);
      if (body.location !== undefined) patch.location = body.location ? String(body.location).slice(0, 40) : null;
      if (body.active !== undefined) patch.active = body.active ? 1 : 0;
      const t = store.updateTerminal(id, patch);
      if (!t) return fail(res, 404, '终端不存在');
      return sendJson(res, 200, { terminal: { id: t.id, name: t.name, active: t.active, secretHint: t.secret_hint } });
    }

    if (p === '/api/admin/settings/apply-target' && req.method === 'POST') {
      const body = await readBody(req);
      const minutes = Number(body.targetMinutes);
      if (!Number.isFinite(minutes) || minutes < 0) return fail(res, 400, '目标小时数不合法');
      const emps = store.listEmployees();
      for (const e of emps) store.updateEmployee(e.id, { target_minutes: Math.round(minutes) });
      return sendJson(res, 200, { ok: true, applied: emps.length });
    }

    if (p === '/api/admin/settings' && req.method === 'PATCH') {
      const body = await readBody(req);
      const allowed = ['weekStartWd', 'weeklyTargetMinutes', 'dailyCapMinutes', 'lunchStartMinute',
        'lunchWindowMinutes', 'lunchMinOverlapMinutes', 'lunchDeductionMinutes', 'sessionTtlSeconds', 'timezoneOffsetMinutes'];
      for (const k of allowed) {
        if (body[k] !== undefined) store.setSetting(k, String(Number(body[k])));
      }
      return sendJson(res, 200, { ok: true, config: rulesConfig() });
    }

    if (p.match(/^\/api\/admin\/exceptions\/[^/]+$/) && req.method === 'PATCH') {
      const id = p.split('/')[4];
      const body = await readBody(req);
      const status = ['approved', 'rejected', 'pending'].includes(body.status) ? body.status : null;
      if (!status) return fail(res, 400, '状态不合法');
      const ex = store.updateException(id, { status });
      return sendJson(res, 200, { exception: ex });
    }

    if (p.match(/^\/api\/admin\/events\/[^/]+$/) && req.method === 'PATCH') {
      const id = p.split('/')[4];
      const body = await readBody(req);
      const to = store.getEmployee(body.employeeId);
      if (!to) return fail(res, 404, '目标员工不存在');
      const ev = store.reassignEvent(id, to.id, 'admin');
      if (!ev) return fail(res, 404, '打卡记录不存在');
      return sendJson(res, 200, { event: ev });
    }

    if (p === '/api/admin/export.csv' && req.method === 'GET') {
      const weekStartKey = q.get('week') || R.currentWeekStart(rulesConfig());
      const report = teamWeek(weekStartKey);
      const header = ['姓名', '工位', '在岗小时', '目标小时', '差值小时', '是否达标', '出差小时', '未签退天数', '补卡分钟', '补卡次数', '员工码打卡次数', '状态'];
      const lines = [header.join(',')];
      for (const r of report.rows) {
        lines.push([
          csvEscape(r.name), csvEscape(r.seat),
          (r.minutes / 60).toFixed(2),
          (r.effectiveTargetMinutes / 60).toFixed(2),
          (r.gapMinutes / 60).toFixed(2),
          r.met ? '达标' : '未达标',
          (r.travelMinutes / 60).toFixed(2),
          r.unclosedDays,
          r.adjustmentMinutes,
          r.adjustmentCount,
          r.weakCount,
          r.active ? '在职' : '已离职',
        ].join(','));
      }
      const csv = '﻿' + lines.join('\r\n');
      return send(res, 200, csv, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="attendance-${weekStartKey}.csv"`,
      });
    }

    /* ───── 静态 ───── */
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, p);
    }
    return fail(res, 404, '没有这个接口');
  } catch (err) {
    // 业务层的可预期错误（校验失败、凭据不匹配、挑战过期…）给 4xx，
    // 内部错误只回通用文案，细节只进日志。
    const msg = String(err && err.message || '');
    const isBusiness = /无效|已过期|不匹配|不正确|失败|不能|没有|不存在|未登记|已取消|不合法|锁定|过多/.test(msg);
    console.error('[error]', req.method, p, err);
    if (isBusiness) return fail(res, 400, msg);
    return fail(res, 500, '服务器内部错误');
  }
});

/* ── 启动自检：把「配错了会导致全员打不了卡」的问题提前说清楚 ── */
function startupSelfCheck() {
  const warns = [];
  if (APP_ORIGIN && !/^https:\/\//.test(APP_ORIGIN)
      && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(APP_ORIGIN)) {
    warns.push('APP_ORIGIN 不是 https：浏览器只在安全上下文（HTTPS / localhost）里启用指纹，'
      + '用 http:// 的局域网地址打开会导致「指纹功能不存在」');
  }
  if (/^https?:\/\//.test(RP_ID)) {
    warns.push(`RP_ID 写成了 URL：应该只填裸域名（如 pb.example.com），不能带 https://、端口或路径`);
  }
  if (RP_ID.includes(':')) {
    warns.push('RP_ID 不能带端口');
  }
  if (!process.env.ADMIN_PASSWORD && !store.getSetting('adminPasswordHash', '')) {
    warns.push('首次启动：已生成管理员口令，写在 data/.admin-password');
  }
  return warns;
}

server.listen(PORT, HOST, () => {
  const warns = startupSelfCheck();
  if (warns.length) {
    console.log('\n⚠ 启动自检发现以下问题：');
    for (const w of warns) console.log('  · ' + w);
    console.log('');
  }
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log('┌─────────────────────────────────────────────┐');
  console.log('│  在岗哨 Presence Beacon                      │');
  console.log('├─────────────────────────────────────────────┤');
  console.log(`│  员工端   ${url}/`);
  console.log(`│  管理端   ${url}/admin`);
  console.log(`│  数据库   ${DB_FILE}`);
  console.log(`│  管理员口令 见 ${path.join(path.dirname(DB_FILE), '.admin-password')}`);
  console.log('│  （或用 ADMIN_PASSWORD 环境变量指定；口令只存哈希，不进日志）');
  console.log('└─────────────────────────────────────────────┘');
});

process.on('SIGINT', () => { store.close(); process.exit(0); });
process.on('SIGTERM', () => { store.close(); process.exit(0); });

module.exports = { server, store };
