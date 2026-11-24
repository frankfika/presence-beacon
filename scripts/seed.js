#!/usr/bin/env node
'use strict';
/**
 * 在岗哨 · 演示数据
 *
 * 部署完打开管理端是空的，不知道从哪下手？跑这个造一份样例：
 *   node scripts/seed.js
 *
 * 只在**空库**上生效。库里已经有员工了就拒绝执行，不会覆盖任何真实数据。
 * 想清掉演示数据：node scripts/seed.js --clear
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
process.env.DB_FILE = process.env.DB_FILE
  || path.join(ROOT, 'data', 'presence.db');

const { Store } = require(path.join(ROOT, 'server', 'db.js'));
const { randomCode, hashSecret } = require(path.join(ROOT, 'server', 'secret.js'));

const PEOPLE = [
  { name: '张三', seat: 'A-01' },
  { name: '李四', seat: 'A-02' },
  { name: '王五', seat: 'B-01' },
  { name: '赵六', seat: 'B-02' },
  { name: '钱七', seat: 'C-01' },
];

const store = new Store(process.env.DB_FILE);
const clear = process.argv.includes('--clear');

function count() {
  const e = store.db.prepare('SELECT COUNT(*) n FROM employees WHERE active=1').get();
  const t = store.db.prepare('SELECT COUNT(*) n FROM terminals').get();
  return { e: e.n, t: t.n };
}

if (clear) {
  const { e, t } = count();
  if (!e && !t) {
    console.log('本来就是空的，没什么可清的。');
    process.exit(0);
  }
  store.db.prepare('DELETE FROM employees').run();
  store.db.prepare('DELETE FROM terminals').run();
  console.log(`已清掉 ${e} 个员工、${t} 个终端。`);
  console.log('注意：打卡记录（events）没动，也没法通过这个脚本还原。');
  process.exit(0);
}

const { e, t } = count();
if (e > 0 || t > 0) {
  console.error(`\n拒绝执行：库里已经有 ${e} 个员工、${t} 个终端。`);
  console.error('这个脚本只在空库上跑，避免覆盖真实数据。');
  console.error('确实想清空重来：node scripts/seed.js --clear\n');
  process.exit(1);
}

console.log('\n在岗哨 · 造一份演示数据\n');

const created = [];
for (const p of PEOPLE) {
  const inviteCode = randomCode(12);
  const pin = randomCode(8);
  store.createEmployee({
    name: p.name,
    seat: p.seat,
    inviteCode,
    pinHash: hashSecret(pin),
  });
  created.push({ ...p, inviteCode, pin });
}

const terminalSecret = randomCode(24);
const term = store.createTerminal({
  name: '门口终端',
  location: '前台',
  secretHash: hashSecret(terminalSecret),
  secretHint: terminalSecret.slice(-4),
});
const termUrl = `${process.env.APP_ORIGIN || 'http://localhost:8080'}/t/${terminalSecret}`;

console.log('员工（把「邀请码」发给本人，首次登记指纹用；「员工码」是指纹坏了的兜底）：\n');
for (const c of created) {
  console.log(`  ${c.name}  工位 ${c.seat}`);
  console.log(`      邀请码  ${c.inviteCode}`);
  console.log(`      员工码  ${c.pin}`);
}
console.log('\n终端（这个链接只显示这一次，旧安卓机上打开它）：\n');
console.log(`  ${term.name}（${term.location}）`);
console.log(`  ${termUrl}`);
console.log('\n  提示：演示数据的链接在你自己的机器上，所以用 APP_ORIGIN 里的地址。');
console.log('        真实部署时改成你的域名再打开。');
console.log('\n删掉演示数据：node scripts/seed.js --clear\n');

process.exit(0);
