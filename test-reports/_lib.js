'use strict';
/* 安全审查共用工具 */
const BASE = process.env.BASE || 'http://localhost:8099';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test123';

async function raw(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { ...(opts.headers || {}) } };
  if (opts.body !== undefined) {
    if (typeof opts.body === 'string') { init.body = opts.body; init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json'; }
    else { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  }
  if (opts.token) init.headers['x-admin-token'] = opts.token;
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text.slice(0, 400) }; }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: data, text };
}

async function api(path, opts = {}) {
  const r = await raw(path, opts);
  if (r.status >= 400) {
    const e = new Error(r.body?.error || `HTTP ${r.status}`);
    e.status = r.status; e.body = r.body; e.text = r.text;
    throw e;
  }
  return r.body;
}

function line(t) { console.log('\n' + '─'.repeat(78) + '\n' + t + '\n' + '─'.repeat(78)); }
function sub(t) { console.log('\n▶ ' + t); }
function show(label, r, max = 300) {
  const b = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  console.log(`  [${label}] HTTP ${r.status}  ${b.length > max ? b.slice(0, max) + '…' : b}`);
}

const results = [];
function rec(id, title, severity, ok, detail) {
  results.push({ id, title, severity, ok, detail });
  console.log(`  ${ok ? '✔' : '✘'} ${id} ${title} — ${severity}${detail ? ' :: ' + detail : ''}`);
}

module.exports = { BASE, ADMIN_PASSWORD, raw, api, line, sub, show, results, rec };
