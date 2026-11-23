'use strict';
/**
 * 在岗哨 · 持久层（node:sqlite）
 */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employees (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  seat              TEXT,
  target_minutes    INTEGER NOT NULL DEFAULT 1440,
  invite_code       TEXT,
  device_token_hash TEXT,
  device_strong     INTEGER NOT NULL DEFAULT 0,
  pin               TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id          TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  public_key  TEXT NOT NULL,
  counter     INTEGER NOT NULL DEFAULT 0,
  transports  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cred_emp ON credentials(employee_id);

CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,
  employee_id    TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  ts             INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  terminal_id    TEXT,
  session_id     TEXT,
  verify_method  TEXT,
  note           TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evt_emp_ts ON events(employee_id, ts);

CREATE TABLE IF NOT EXISTS exceptions (
  id          TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  type        TEXT NOT NULL,
  minutes     INTEGER NOT NULL,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exc_emp ON exceptions(employee_id);

CREATE TABLE IF NOT EXISTS terminals (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  location   TEXT,
  secret     TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  employee_id TEXT,
  event_id    TEXT
);

CREATE TABLE IF NOT EXISTS challenges (
  id          TEXT PRIMARY KEY,
  challenge   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  employee_id TEXT,
  session_id  TEXT,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DEFAULT_SETTINGS = {
  weekStartWd: '1',
  weeklyTargetMinutes: '1440',
  dailyCapMinutes: '720',
  lunchStartMinute: '720',
  lunchWindowMinutes: '60',
  lunchMinOverlapMinutes: '45',
  lunchDeductionMinutes: '60',
  timezoneOffsetMinutes: '480',
  sessionTtlSeconds: '45',
  adminPassword: '',
};

class Store {
  constructor(file) {
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.migrate();
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k, v);
    }
  }

  /**
   * 轻量迁移：给已存在的表补上新增的列。
   * （CREATE TABLE IF NOT EXISTS 不会给老库加字段，所以这里补一下）
   */
  migrate() {
    const cols = {
      terminals: [
        ['last_seen', 'INTEGER'],
        ['pin', 'TEXT'],
        ['secret_hash', 'TEXT'],
        ['secret_hint', 'TEXT'],
      ],
      employees: [
        ['note', 'TEXT'],
        ['pin_hash', 'TEXT'],
        ['device_strong', 'INTEGER'],
      ],
      events: [
        ['original_employee_id', 'TEXT'],
        ['reassigned_by', 'TEXT'],
      ],
    };
    // 老版本把终端密钥明文存在 secret 列里 → 转成哈希并清空
    try {
      const { hashFast } = require('./secret.js');
      const olds = this.db.prepare("SELECT id, secret FROM terminals WHERE secret IS NOT NULL AND secret != ''").all();
      for (const t of olds) {
        this.db.prepare("UPDATE terminals SET secret='', secret_hash=?, secret_hint=? WHERE id=?")
          .run(hashFast(t.secret), String(t.secret).slice(-6), t.id);
      }
    } catch { /* ignore */ }

    for (const [table, specs] of Object.entries(cols)) {
      let existing;
      try {
        existing = this.db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
      } catch { continue; }
      if (!existing || !existing.length) continue;
      for (const [name, type] of specs) {
        if (!existing.includes(name)) {
          try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`); } catch { /* 忽略 */ }
        }
      }
    }
  }

  /* ── settings ── */
  getSetting(key, fallback) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? row.value : (fallback ?? DEFAULT_SETTINGS[key]);
  }
  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  }
  allSettings() {
    const out = {};
    for (const r of this.db.prepare('SELECT key,value FROM settings').all()) out[r.key] = r.value;
    return out;
  }

  /* ── employees ── */
  listEmployees({ includeInactive = false } = {}) {
    const sql = includeInactive
      ? 'SELECT * FROM employees ORDER BY active DESC, created_at ASC'
      : 'SELECT * FROM employees WHERE active=1 ORDER BY created_at ASC';
    return this.db.prepare(sql).all();
  }
  getEmployee(id) {
    return this.db.prepare('SELECT * FROM employees WHERE id=?').get(id);
  }
  /** 只返回在职员工（打卡等活跃路径必须用这个，停用员工不该再能打卡） */
  getActiveEmployee(id) {
    return this.db.prepare('SELECT * FROM employees WHERE id=? AND active=1').get(id);
  }
  createEmployee({ name, seat = null, targetMinutes = null, inviteCode = null, pinHash = null }) {
    const id = crypto.randomUUID();
    const now = Date.now();
    const target = targetMinutes ?? Number(this.getSetting('weeklyTargetMinutes'));
    this.db.prepare(
      `INSERT INTO employees(id,name,seat,target_minutes,invite_code,pin_hash,pin,active,created_at)
       VALUES(?,?,?,?,?,?,?,1,?)`
    ).run(id, name, seat, target, inviteCode, pinHash, null, now);
    return this.getEmployee(id);
  }
  updateEmployee(id, patch) {
    const allowed = ['name', 'seat', 'target_minutes', 'invite_code', 'device_token_hash', 'device_strong', 'pin', 'pin_hash', 'active'];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (!keys.length) return this.getEmployee(id);
    const sets = keys.map((k) => `${k}=?`).join(',');
    this.db.prepare(`UPDATE employees SET ${sets} WHERE id=?`).run(...keys.map((k) => patch[k]), id);
    return this.getEmployee(id);
  }
  deleteEmployee(id) {
    this.db.prepare('DELETE FROM employees WHERE id=?').run(id);
  }
  /**
   * 设置设备令牌。
   * strong=1 表示这把令牌是用「指纹/面容断言」换来的（强验证），
   * strong=0 表示是用「姓名 + 员工码」自助恢复的（弱验证）。
   * 只有强令牌才允许追加新的生物特征凭证 —— 否则拿到员工码就能在
   * 自己手机上永久注册一个假指纹，占坑别人的打卡通道。
   */
  setDeviceToken(id, token, strong = 0) {
    const hash = token ? crypto.createHash('sha256').update(token).digest('hex') : null;
    this.updateEmployee(id, { device_token_hash: hash, device_strong: strong ? 1 : 0 });
    return hash;
  }
  isDeviceTokenStrong(id) {
    const emp = this.getEmployee(id);
    return !!(emp && emp.device_strong);
  }
  verifyDeviceToken(id, token) {
    const emp = this.getEmployee(id);
    if (!emp || !emp.device_token_hash || !token) return false;
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(emp.device_token_hash, 'hex'));
  }

  /* ── credentials ── */
  listCredentials(employeeId) {
    return this.db.prepare('SELECT * FROM credentials WHERE employee_id=?').all(employeeId);
  }
  getCredential(id) {
    return this.db.prepare('SELECT * FROM credentials WHERE id=?').get(id);
  }
  addCredential({ id, employeeId, publicKey, counter = 0, transports = null }) {
    this.db.prepare(
      'INSERT INTO credentials(id,employee_id,public_key,counter,transports,created_at) VALUES(?,?,?,?,?,?)'
    ).run(id, employeeId, publicKey, counter, transports ? JSON.stringify(transports) : null, Date.now());
  }
  bumpCounter(id, counter) {
    this.db.prepare('UPDATE credentials SET counter=? WHERE id=?').run(counter, id);
  }

  /* ── events ── */
  addEvent({ employeeId, ts, kind, terminalId = null, sessionId = null, verifyMethod = null, note = null }) {
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO events(id,employee_id,ts,kind,terminal_id,session_id,verify_method,note,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`
    ).run(id, employeeId, ts, kind, terminalId, sessionId, verifyMethod, note, Date.now());
    return this.getEvent(id);
  }
  getEvent(id) {
    return this.db.prepare('SELECT * FROM events WHERE id=?').get(id);
  }
  listEvents(employeeId, sinceTs = 0) {
    return this.db.prepare('SELECT * FROM events WHERE employee_id=? AND ts>=? ORDER BY ts ASC').all(employeeId, sinceTs);
  }
  listAllEvents(sinceTs = 0) {
    return this.db.prepare('SELECT * FROM events WHERE ts>=? ORDER BY ts ASC').all(sinceTs);
  }
  /** 某个时间窗口内的事件（用于按周统计弱验证次数等） */
  listEventsBetween(employeeId, fromTs, toTs) {
    return this.db.prepare('SELECT * FROM events WHERE employee_id=? AND ts>=? AND ts<? ORDER BY ts ASC').all(employeeId, fromTs, toTs);
  }
  /** 改归属：保留原始归属痕迹 */
  reassignEvent(eventId, newEmployeeId, byWho) {
    const ev = this.getEvent(eventId);
    if (!ev) return null;
    this.db.prepare(
      'UPDATE events SET employee_id=?, original_employee_id=COALESCE(original_employee_id, employee_id), reassigned_by=? WHERE id=?'
    ).run(newEmployeeId, byWho || null, eventId);
    return this.getEvent(eventId);
  }

  /* ── exceptions ── */
  addException({ employeeId, date, type, minutes, note = null, status = 'pending' }) {
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO exceptions(id,employee_id,date,type,minutes,note,status,created_at)
       VALUES(?,?,?,?,?,?,?,?)`
    ).run(id, employeeId, date, type, minutes, note, status, Date.now());
    return this.getException(id);
  }
  getException(id) {
    return this.db.prepare('SELECT * FROM exceptions WHERE id=?').get(id);
  }
  listExceptions(employeeId = null) {
    return employeeId
      ? this.db.prepare('SELECT * FROM exceptions WHERE employee_id=? ORDER BY date DESC').all(employeeId)
      : this.db.prepare('SELECT * FROM exceptions ORDER BY date DESC').all();
  }
  updateException(id, patch) {
    const allowed = ['status', 'minutes', 'note', 'date', 'type'];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (!keys.length) return this.getException(id);
    const sets = keys.map((k) => `${k}=?`).join(',');
    this.db.prepare(`UPDATE exceptions SET ${sets} WHERE id=?`).run(...keys.map((k) => patch[k]), id);
    return this.getException(id);
  }

  /* ── terminals ── */
  createTerminal({ name, location = null, pin = null, secretHash = null, secretHint = null }) {
    const id = crypto.randomUUID();
    // secret 列在老 schema 里是 NOT NULL，这里存空串；真正的密钥只存哈希
    this.db.prepare(
      'INSERT INTO terminals(id,name,location,secret,secret_hash,secret_hint,pin,active,created_at) VALUES(?,?,?,?,?,?,?,1,?)'
    ).run(id, name, location, '', secretHash, secretHint, pin, Date.now());
    return this.getTerminal(id);
  }
  getTerminal(id) {
    return this.db.prepare('SELECT * FROM terminals WHERE id=?').get(id);
  }
  listTerminals() {
    return this.db.prepare('SELECT * FROM terminals ORDER BY created_at ASC').all();
  }
  touchTerminal(id) {
    this.db.prepare('UPDATE terminals SET last_seen=? WHERE id=?').run(Date.now(), id);
  }
  updateTerminal(id, patch) {
    const allowed = ['name', 'location', 'active', 'pin', 'secret_hash', 'secret_hint'];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (!keys.length) return this.getTerminal(id);
    const sets = keys.map((k) => `${k}=?`).join(',');
    this.db.prepare(`UPDATE terminals SET ${sets} WHERE id=?`).run(...keys.map((k) => patch[k]), id);
    return this.getTerminal(id);
  }

  /* ── sessions（终端动态二维码） ── */
  createSession(terminalId, ttlSeconds) {
    // 8 位大写字母数字（去掉 0/O/1/I 等易混字符），方便员工手动输入
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) id += alphabet[bytes[i] % alphabet.length];
    const now = Date.now();
    const expires = now + ttlSeconds * 1000;
    this.db.prepare('INSERT INTO sessions(id,terminal_id,created_at,expires_at) VALUES(?,?,?,?)').run(id, terminalId, now, expires);
    return { id, terminalId, createdAt: now, expiresAt: expires };
  }
  getSession(id) {
    return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
  }
  markSessionUsed(id, employeeId, eventId) {
    this.db.prepare('UPDATE sessions SET used_at=?, employee_id=?, event_id=? WHERE id=?').run(Date.now(), employeeId, eventId, id);
  }
  /**
   * 原子地「占用」一个会话：只有未被使用且未过期时才成功。
   * 返回 true = 占用成功（这个码归我了）；false = 已被用过或已过期。
   * 用 UPDATE ... WHERE used_at IS NULL 保证并发下不会被重复使用。
   */
  claimSession(id, employeeId, nowMs = Date.now()) {
    const res = this.db.prepare(
      'UPDATE sessions SET used_at=?, employee_id=? WHERE id=? AND used_at IS NULL AND expires_at > ?'
    ).run(nowMs, employeeId, id, nowMs);
    return res.changes === 1;
  }
  cleanSessions() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now() - 3600 * 1000);
  }

  /* ── challenges ── */
  putChallenge({ id, challenge, kind, employeeId = null, sessionId = null, ttlSeconds = 300 }) {
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO challenges(id,challenge,kind,employee_id,session_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?)'
    ).run(id, challenge, kind, employeeId, sessionId, now + ttlSeconds * 1000, now);
  }
  peekChallenge(id) {
    return this.db.prepare('SELECT * FROM challenges WHERE id=?').get(id) || null;
  }
  takeChallenge(id) {
    const row = this.db.prepare('SELECT * FROM challenges WHERE id=?').get(id);
    if (row) this.db.prepare('DELETE FROM challenges WHERE id=?').run(id);
    return row;
  }

  close() { try { this.db.close(); } catch { /* noop */ } }
}

module.exports = { Store, DEFAULT_SETTINGS };
