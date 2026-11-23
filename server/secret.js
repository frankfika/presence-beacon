'use strict';
/** 在岗哨 · 口令/密钥的哈希与随机码 */
const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/** 生成口令哈希：scrypt$N$r$p$salt$hash */
function hashSecret(plain) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(plain), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

/**
 * 校验口令，恒定时间比较。
 * caseInsensitive=true 时忽略大小写 —— 员工码 / 邀请码是随机大写字母数字，
 * 手机上输入法默认小写，不忽略大小写的话员工第一次输就失败。
 */
function verifySecret(plain, stored, caseInsensitive = false) {
  if (!plain || !stored) return false;
  if (caseInsensitive) plain = String(plain).toUpperCase();
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  let salt, expected;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch { return false; }
  if (!salt.length || !expected.length) return false;
  let dk;
  try {
    dk = crypto.scryptSync(String(plain), salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  } catch { return false; }
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

/** 不含易混字符（0/O/1/I）的随机字母数字表 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 生成人类可抄写的随机码（默认 8 位；邀请码建议 12 位） */
function randomCode(len = 8, alphabet = ALPHABET) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** 生成终端密钥（十六进制，32 位） */
function randomSecret() {
  return crypto.randomBytes(16).toString('hex');
}

/** 快速哈希（sha256）。只用于高熵随机密钥（终端密钥），低熵口令请用 scrypt。 */
function hashFast(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex');
}

/** 恒定时间比较两个字符串 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = { hashSecret, verifySecret, hashFast, randomCode, randomSecret, safeEqual, ALPHABET };
