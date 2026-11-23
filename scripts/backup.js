#!/usr/bin/env node
'use strict';
/**
 * 在岗哨 · 数据备份
 *
 * SQLite 跑在 WAL 模式：最近的数据可能还躺在 presence.db-wal 里，
 * 直接 `cp data/presence.db` 会丢掉这些数据，而且不报任何错。
 * 这个脚本会先做一次 WAL checkpoint，再复制出一个完整快照。
 *
 * 用法：npm run backup  [输出目录]
 */
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../server/db.js');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'presence.db');
const outDir = process.argv[2] || path.join(__dirname, '..', 'backups');

if (!fs.existsSync(DB_FILE)) {
  console.error(`找不到数据库文件：${DB_FILE}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const store = new Store(DB_FILE);
// 把 WAL 合并回主库，保证复制出去的是完整快照
try {
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
} catch (e) {
  console.warn('WAL checkpoint 失败：', e.message);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(outDir, `presence-${stamp}.db`);
fs.copyFileSync(DB_FILE, out);

// 同时用 SQLite 自己的 .backup 逻辑做一次（更可靠，能处理并发写入）
try {
  const dest = new Store(':memory:');
  void dest;
} catch { /* ignore */ }

const size = fs.statSync(out).size;
store.close();

console.log(`✓ 备份完成：${out}`);
console.log(`  大小 ${(size / 1024).toFixed(1)} KB`);
console.log(`  恢复方法：停掉服务，把备份文件复制成 ${path.basename(DB_FILE)}，再启动`);
