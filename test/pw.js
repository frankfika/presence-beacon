'use strict';
/**
 * Playwright 加载器
 *
 * 优先用项目本地依赖（npm i -D playwright），
 * 回退到全局安装（某些环境把 playwright 装在全局）。
 *
 * 之前测试里写死 `require('/usr/local/lib/node_modules/playwright')`，
 * 换台机器 / CI 上直接崩 —— 这个文件就是为了解决这件事。
 */
let pw;
try {
  pw = require('playwright');
} catch {
  try {
    pw = require('/usr/local/lib/node_modules/playwright');
  } catch {
    console.error(
      '\n找不到 Playwright。装一下：\n'
      + '  npm i -D playwright && npx playwright install --with-deps chromium\n'
    );
    process.exit(1);
  }
}

module.exports = pw;
