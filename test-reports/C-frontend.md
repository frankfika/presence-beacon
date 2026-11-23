# C · 前端真实浏览器测试报告 —— 在岗哨（Presence Beacon）

> 测试者：前端测试 agent ｜ 环境：Chromium（Playwright 1.x，`/usr/local/lib/node_modules/playwright`）｜
> 被测服务：`http://localhost:8099`（共享实例，未重启、未删数据、未改 `public/` 源码）
> 报告完成时间：2026-11-23 13:45 CST

---

## 0. 测试说明与重要前提

### 0.1 被测代码版本（测试期间 `public/` 一直在被别人改）

本轮测试横跨 12:20–13:45，期间**另一个 agent 正在同步修改 `public/`**（`employee.js` / `admin.js` /
`terminal.js` / `app.css` / `index.html` / `sw.js` / `manifest.webmanifest` 都被改过）。
因此每条问题都标注了 **「发现版本」** 和 **「13:40 终版复核」** 两个状态：

| 文件 | 测试开始时 (12:36) | 报告完成时 (13:40) |
|---|---|---|
| `index.html` | `51deabe…` | `5c282fe…` |
| `employee.js` | `9e5e4e8…` | `ca97753…` |
| `admin.js` | `fcc1c50…` | `b87b16d…` |
| `terminal.js` | `87dfc88…` | `321c811…` |
| `lib.js` | `92c5504…` | `92c5504…`（未动） |
| `app.css` | `e5a8bc9…` | `c52c4fc…` |
| `manifest.webmanifest` | `2c48dc9…` | `313386f…` |

> 结论：下面 **「仍存在」** 的条目都是在 13:40 的最新构建上**重新复现过**的；标注 **「测试期间已修复」** 的条目是
> 我复现 → 对方修掉 → 我复测通过的，每条都留了证据。**这批前端问题基本被对方逐条消化了**，剩下的才是真正需要动手的。

### 0.2 测试脚本（都在 `/workspace/presence-beacon/test-reports/`）

| 脚本 | 覆盖范围 |
|---|---|
| `fe-lib.js` | 公共工具：虚拟认证器、页面审计（横向滚动/溢出/触摸目标/label 关联）、截图 |
| `fe-employees.js` | fixture：建员工/终端、注册（WebAuthn）、等服务器就绪 |
| `fe-r1-employee.js` | 员工端完整流：激活→注册→首页→扫码→手动码→完成页→申请→员工码→退出 |
| `fe-r1b-invite-input.js` | 邀请码/员工码输入框与服务端实际码长/字符集是否匹配（**真实按键输入**） |
| `fe-r1c-recover.js` | 自助恢复流程（清缓存 / 换手机后怎么回来） |
| `fe-r2-responsive.js` | 390 / 768 / 1440 三视口 × 三界面，横向滚动 / 溢出 / 触摸目标 / 文本截断 |
| `fe-r3-compat.js` | 兼容性矩阵：iOS Safari(无 BarcodeDetector) / Android Chrome(有 BarcodeDetector) / 无 WebAuthn / 摄像头 NotAllowedError / NotFoundError / 无 mediaDevices |
| `fe-r4-terminal.js` | 终端 kiosk：45s 刷新 / 闪屏 / 长按面板 / 触摸长按 / 离线 |
| `fe-r5-admin.js` + `fe-r5b-csv.js` | 管理端：登录 / tab / 增删改 / 终端 / 审批 / 规则 / CSV 导出 |
| `fe-r6-pwa.js` | manifest / SW / 离线外壳 / 图标 / deviceToken 丢失 |
| `fe-r7-a11y.js` | WCAG 对比度、字号、label 关联、文案 |
| `fe-final.js` | 终版复核：逐条确认问题是否仍存在 |

**假摄像头**：为了真正跑通扫码链路，用 `canvas.captureStream()` 把「终端真实二维码 SVG」画到 canvas 上，
通过 `navigator.mediaDevices.getUserMedia` 注入 —— jsQR 能真的解码出 sessionId 并触发打卡。

---

## 1. 响应式与排版（390 / 768 / 1440）

### 1.1 结论速览

| 界面 | 390×844 (iPhone) | 768×1024 (iPad) | 1440×900 (桌面) |
|---|---|---|---|
| 员工端（激活/首页/扫码/指纹/完成/申请/员工码） | ✅ 无横向滚动，无文字截断，触摸目标全部 ≥44px | ✅ | ✅ |
| 终端 kiosk | ✅ 无横向滚动，竖屏可用（内容刚好一屏） | ✅ | ✅ |
| 管理端 · 周报 | ✅（**12:36 版是 ❌ 严重溢出，见 §3 P0-5，已修复**） | ✅ | ✅ |
| 管理端 · 员工/终端/审批/规则 | ✅ 无横向滚动 | ✅ | ✅ |
| 管理端表格窄屏可读性 | ⚠️ **状态列竖排成「已/登/记/指/纹」，操作列被挤到屏幕外** | ⚠️ 同左 | ✅ |

**所有员工端界面在三个视口下 scrollWidth === clientWidth**（390/390、768/768、1440/1440），没有横向滚动条。

### 1.2 截图

- 员工端： `shots/r2-{iphone,ipad,desktop}-emp-{s-setup,s-home,s-scan,s-bio,s-done,s-exception,s-pin}.png`（21 张）
- 终端： `shots/r2-{iphone,ipad,desktop}-term.png`
- 管理端：`shots/r2-{iphone,ipad,desktop}-adm-{t-week,t-people,t-term,t-req,t-set}.png`（15 张）
- 关键单张：`shots/r1-03-home-390.png`（首页）、`shots/r1-04-scan-390.png`（扫码页）、
  `shots/r2-iphone-adm-t-people.png`（管理端窄屏表格，问题证据）、
  `shots/r2-iphone-term.png`（终端竖屏）、`shots/r7-01-terminal-1440.png`（终端深色页）

### 1.3 终端 kiosk 在竖屏手机上的表现

390×844 竖屏下：时钟 44px→34px、二维码 `min(300px,44vw)`=**171px**、今日在场/团队累计两块统计、
当前在场人员列表、底部提示，**内容高度正好 844px，不需要滚动**。但：

- 二维码只有 171px，站在工位区的人用手机扫会略吃力（建议 ≥220px）。
- 闪屏遮罩 `.flash`（app.css:152）是 `position:fixed;inset:0` + `pointer-events:auto`，
  3 秒内**挡住整个屏幕**（包括二维码）。实测：有人打卡后想长按二维码看终端信息，会被这层挡住。

---

## 2. 真机兼容性（本次最关键的部分）

模拟方式：UA 改成 iPhone/Android + `isMobile:true`，并用 `page.addInitScript` 精确删改浏览器 API。

### 2.1 兼容性矩阵

| 场景 | 模拟方法 | 结果 | 证据 |
|---|---|---|---|
| **iOS Safari（无 BarcodeDetector）** | 删掉 `window.BarcodeDetector` | ✅ **jsQR 回落可用**：jsQR 真的解码出终端二维码的 sessionId，触发 `assert-options`，整条扫码→指纹→落库链路走通 | `shots/c1-02-ios-jsqr-scan.png` |
| **Android Chrome（有 BarcodeDetector）** | 注入行为等价的 `BarcodeDetector` shim（内部用 jsQR 解码） | ✅ 走 `lib.js:108` 的 BarcodeDetector 分支，识别成功 | `shots/c2-01-android-bcdetector.png` |
| **无 WebAuthn 设备** | 删掉 `navigator.credentials` + `window.PublicKeyCredential` | ✅ 不白屏；激活页提示「这个浏览器不支持指纹验证，请改用员工码」；员工码入口可达 | `shots/c3-01/02/03-nowebauthn-*.png` |
| **摄像头权限被拒** | `getUserMedia` 抛 `NotAllowedError` | ✅ 停在扫码页，提示「打不开摄像头（NotAllowedError）。可以手动输入终端上的 8 位码。」，手动码入口可用且能提交 | `shots/c4-01-NotAllowedError.png` |
| **摄像头不存在** | `getUserMedia` 抛 `NotFoundError` | ✅ 同上 | `shots/c5-01-NotFoundError.png` |
| **完全无 mediaDevices** | `navigator.mediaDevices = undefined` | ✅ 提示「这个浏览器没有摄像头权限，请用下面的手动输入码」 | `shots/c6-01-nomediadevices.png` |
| iPhone UA 下的安全上下文 | — | ✅ `isSecureContext=true`，localStorage / WebAuthn 可用，`100dvh` 支持 | — |

### 2.2 兼容性上最大的隐患

**`lib.js:107-141` 的 `scanQr()` 只有两条路：`BarcodeDetector` 或 `jsQR`。两者都不可用时返回 `null`，
`employee.js` 给的提示是「这个浏览器没有二维码识别能力，请手动输入码」——这条兜底是对的，
但 jsQR 这条路在低端安卓机上很可能是「能用但很慢」**：

- jsQR 是纯 CPU 解码，在 4 核以下的旧安卓机上，640×480 的一帧要 **80–300ms**，而且
  `scanQr` 的 jsQR 分支**每帧都做一次 `getImageData`**（`lib.js:130`），
  在低端机上会让扫码页持续掉帧、发热。
- 而 `BarcodeDetector` 分支（`lib.js:112`）的 `catch {}` 把异常**整个吞掉**（`lib.js:117`）。
  如果老安卓机上 `BarcodeDetector` 存在但 `detect()` 持续抛错，界面会**一直扫不出结果，也没有任何报错**——
  员工只会以为「摄像头坏了」。

> **建议**：① jsQR 分支把 canvas 降到 320×320 并隔帧解码（≥100ms 一次）；
> ② `BarcodeDetector` 分支的 catch 不要静默，连续 N 次失败后提示「这个手机的扫码功能异常，请手动输入码」。

### 2.3 需要真机验证的风险点（我无法在模拟器里确认）

| # | 风险点 | 为什么模拟器测不出来 | 建议验证方式 |
|---|---|---|---|
| **R1** | **iOS Safari 的 `getUserMedia` 必须在用户手势里调用**，且首次会弹系统级授权框 | Chromium 里权限是 Playwright 注入的，不会真的弹框 | 真机 Safari 点「签进」，确认能弹出摄像头授权；**拒绝后**确认提示文案和手动码兜底（模拟器已验证后者） |
| **R2** | **iOS Safari 16 以下没有 WebAuthn**。`lib.js:42 isWebAuthnAvailable()` 只判断 API 是否存在，不判断版本；`isPlatformAuth()`（`lib.js:45`）也只判断函数存在，**没有真正调用 `isUserVerifyingPlatformAuthenticatorAvailable()`** | Chromium 里 WebAuthn 永远可用 | 真机 iOS 15 / iPadOS 15 上激活，确认提示是否准确（现在会走到注册然后失败） |
| **R3** | **生产环境非 HTTPS 时 `navigator.mediaDevices` 直接是 undefined**，员工根本没法扫码（只能手输 8 位码） | localhost 是安全上下文 | 在真机用局域网 IP（非 HTTPS）打开，确认提示文案是否说清「需要 HTTPS / 只能用手动码」 |
| **R4** | **iOS Safari 键盘弹起会改变 `100dvh`**，终端页 `min-height:100dvh`（app.css `.term`）会跳变 | Chromium 桌面端没有软键盘 | 真机 Safari 聚焦输入框，观察终端页/员工端是否跳动、按钮是否被遮住 |
| **R5** | **iOS Safari 的 `playsinline` + `muted` 是否真的让 video 内联播放**（`index.html:75` 已有 `playsinline muted`） | Chromium 的 video 行为与 Safari 不同 | 真机 Safari 点签进，确认出现的是内联取景框而不是全屏播放器 |
| **R6** | **真实 iPhone「添加到主屏幕」的图标是否被裁**。manifest 现在有 4 个图标（`icon-180/192/512/maskable-512`） | 只有真机能看启动画面 | iPhone 加到主屏后看图标形状；安卓 Chrome 加到主屏看圆形裁切是否吃掉 logo |
| **R7** | **老安卓机摄像头驱动差异**：`facingMode:{ideal:'environment'}` 在部分定制 ROM 上会拿前置摄像头 | 假摄像头不区分前后 | 真机确认扫二维码用的是后置 |
| **R8** | **iOS Safari 上 `BarcodeDetector` 从 17.0 才有**，且 Safari 的 `detect()` 接受 `ImageBitmapSource`（含 `<video>`）但 API 面与 Chrome 略有差异 | 模拟器里没有原生 BarcodeDetector | 真机 Safari 17+ 确认走的是原生路径且能识别 |

---

## 3. 问题清单

> **后续修复记录（14:5x）**：本报告里标「仍存在」的问题已全部修完，并补了回归测试
> `test/c-fixes.test.js`（15 项）、`test/responsive.test.js`（21 项）、`test/offline.test.js`（9 项）、
> `test/recover.test.js`（10 项）、`test/terminal.test.js`（9 项）。
> `node test/run-all.js` → **10 / 10 个测试套件全绿**。
>
> | 原编号 | 现状 |
> |---|---|
> | P0-1 大小写 | ✅ 服务端统一大写归一化（`normCode`），前端也 `.toUpperCase()`；邀请码 / 员工码 / 恢复码三处都覆盖 |
> | P1-1 bigbtn | ✅ `.bigbtn` 补 `display:block;width:100%` |
> | P1-2 终端对比度 | ✅ foot `#6f747d→#9aa0aa`（7.06:1）、时间戳 `#7e848e→#9aa0aa`、标签 `#8a8f99→#a8aeb8`（8.33:1） |
> | P1-3 `--ink-3` | ✅ `#7c7a72→#63615a`，三端一次性修好 |
> | P1-4 fetch 超时 | ✅ `AbortSignal.timeout(20000)`，超时翻成「网络太慢了，请检查 Wi-Fi 后重试」 |
> | P1-5 审批 tab | ✅ 切 tab 触发 `load()`；并补了 `aria-label` |
> | P2-1 点不动的行 | ✅ 改成真 `<button class="row rowlink">` |
> | P2-2 工时输入框 | ✅ 92×44px + `aria-label="<姓名> 每周目标小时数"` |
> | P2-3 表格竖排 | ✅ `table.tbl td{white-space:nowrap}` |
> | P2-4 英文原文 | ✅ 新增 `friendlyWebauthnError()`，`NotAllowedError` 等 5 类翻成中文 |
> | P2-5 闪屏挡点击 | ✅ `.flash.on{pointer-events:none}` |
> | P2-6 label 关联 | ✅ 员工端 11 个 + 管理端 6 个 label 全部加 `for` |
> | P3-1 字号 | ✅ `.stat .k` 11.5px → 13px |
>
> 另外 C 报告里没列、但同期发现并修掉的：
> - **终端页一报错就每秒抛 JS 异常**（`qrState.innerHTML` 把倒计时元素整个替换掉了）
> - **终端密钥错误时无限重试**（改成停止轮询 + 明确提示 + 退避重试）
> - **连续打卡时闪屏只亮一瞬**（旧定时器把新闪屏关掉了）
> - **员工清缓存 / 换手机后被永久锁死**（新增自助恢复：`姓名+工位+员工码` 或「按一次指纹」，
>   弱令牌不能追加指纹凭证，避免拿到员工码就能在别人手机上注册假指纹）
> - **管理端周报页整页横向溢出**（`.bench` 的 `1fr` 轨道改成 `minmax(0,1fr)`，`1fr` 轨道的
>   min-content 会自我放大到 7482px）
> - **触摸目标全部 <44px**（`.btn.sm` / `.tab` 统一 44px）


严重级定义：**P0 = 阻断主流程 / 老板拿不到数据**；**P1 = 主要界面明显不好用**；**P2 = 体验瑕疵**；**P3 = 细节**。

### P0-5｜管理端「周报」页整页横向溢出（**测试期间已修复**）

| 项 | 内容 |
|---|---|
| 页面 | 管理端 → 周报 |
| 现象 | 390px 视口下 `scrollWidth=2285`、768px 下 `2285`、1440px 下 `2791`。左边的「在岗时长」柱状图被推到 2266px 外，右侧「每日明细」表（每人 1 列）撑爆整页 |
| 复现 | 打开 `/admin` → 登录 → 周报 tab；量 `document.documentElement.scrollWidth` |
| 证据 | `shots/r2-iphone-adm-t-week.png`（截图宽 6855px = 页面实际宽 3427 CSS px） |
| 根因 | `.split` 是 CSS Grid，grid item 默认 `min-width:auto`；`每日明细` 里的 `table.tbl`（每人 1 列）min-content 宽度把 grid 轨道撑爆。`.tscroll{overflow-x:auto}` 包着表格也挡不住 —— **滚动容器的 min-content 仍然由内容决定** |
| 修复 | 对方已在 `app.css:201` 加 `.split>*{min-width:0}`，并把 `.bench` 改成 `88px minmax(0,1fr) 120px`（app.css:179） |
| 复核 | ✅ 13:40 终版复测：390/390、768/768、1440/1440 三视口全部无横向滚动 |
| 严重级 | P0（曾）→ 已修复 |

### P0-4｜清缓存 / 换手机后员工被永久锁死（**测试期间已修复**）

| 项 | 内容 |
|---|---|
| 页面 | 员工端 |
| 现象 | 手机清了浏览器数据 / 换了浏览器 → 回到激活页 → ① 原邀请码已作废；② 管理员「重置邀请码」接口返回**「该员工已登记指纹，重置邀请码没有意义」**；③ 员工码通道因为 `state.employeeId` 为空也失败（"员工或员工码不正确"）。**三条路全断，员工再也无法打卡** |
| 复现 | 注册并激活 → 清掉 localStorage（等价于清浏览器数据）→ 重新打开首页 → 依次试邀请码 / 员工码 |
| 证据 | `shots/r6-03-after-cache-clear.png`、`shots/r6-04-reactivation.png`、`shots/r6-05-pin-after-clear.png` |
| 修复 | 对方已在 `index.html:48-80` 新增「以前激活过？点这里恢复」页，`employee.js:203-257` 实现员工码恢复 + 指纹恢复；服务端新增 `POST /api/auth/recover` |
| 复核 | ✅ 13:40 复测：错码提示「姓名或员工码不正确」，正确码 → 回到首页并拿到新 deviceToken（`shots/r1c-04-recover-ok.png`） |
| 遗留 | 见 P2-6（恢复页「用指纹恢复」直接抛英文原文） |

### P0-1｜邀请码 / 员工码大小写敏感 —— 手机上必踩（**已修复**）

| 项 | 内容 |
|---|---|
| 页面 | 员工端 → 激活页 / 恢复页 / 员工码页 |
| 现象 | 服务端发的是**大写字母数字**（`server/secret.js:35` ALPHABET = `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`），但前端读入时**不转大写**（`employee.js:177` 邀请码、`employee.js:364` 员工码、`employee.js:218` 恢复页员工码都是 `.value.trim()`），服务端又做**大小写敏感**比较 → 小写输入被判「员工或邀请码不正确」。<br>更坑的是：邀请码输入框加了 `style="text-transform:uppercase"`（`index.html:35`），**CSS 只改显示不改值** —— 用户屏幕上明明显示的是大写 `7RDPJHFС3B59`，提交上去却是小写，被拒后一脸懵。 |
| 复现 | 真实按键输入小写邀请码 → 点「登记指纹 / 面容」 |
| 证据 | `shots/r1b-02-invite-lowercase.png`、`shots/r1c-05/07-*.png`（截图里输入框显示大写，实际值是小写） |
| 对照 | 终端 8 位码是对的：`employee.js:310` 有 `.toUpperCase()` |
| 建议 | `employee.js:177` → `$('inpInvite').value.trim().toUpperCase()`；`employee.js:364`、`employee.js:218` 同样加 `.toUpperCase()`；或服务端比较时统一 `toUpperCase()`（更稳，前端后端都改） |
| 严重级 | **P0** —— 这是「员工第一次激活就失败」的头号原因，而且提示文案完全指不到点上 |

### P0-2｜管理端「导出 CSV」下载到的是 401 错误（**测试期间已修复**）

| 项 | 内容 |
|---|---|
| 页面 | 管理端 → 周报 → 导出 CSV |
| 现象 | 老实现用 `<a href="/api/admin/export.csv?week=…">` 触发下载，浏览器**不会**带 `x-admin-token` 头 → 服务端 401 → 老板下载到一个名为 `attendance-2026-11-23.csv` 的文件，内容是 `{"error":"需要管理员登录"}` |
| 复现 | 登录管理端 → 周报 → 点「导出 CSV」；或直接 `curl /api/admin/export.csv?week=…`（不带 token） |
| 证据 | `shots/admin-export-download.csv`（修复前内容）、`shots/r5b-01-export.png` |
| 修复 | 对方已改为 `admin.js:116-138`：先 `fetch` 带 `x-admin-token`，再 `res.blob()` + `URL.createObjectURL` 触发下载，并加了失败 `alert` |
| 复核 | ✅ 13:40 复测：下载到 136 行真 CSV，表头 `姓名,工位,在岗小时,目标小时,差值小时,是否达标,出差小时,未签退天数,补卡分钟,补卡次数,员工码打卡次数,状态`（带 BOM，Excel 不乱码 ✔） |
| 严重级 | P0（曾）→ 已修复 |

### P0-3｜断网打开员工端 = **完全白屏**（**测试期间已修复**）

| 项 | 内容 |
|---|---|
| 页面 | 员工端 |
| 现象 | 12:36 版：Service Worker 明明缓存了应用外壳，但 `boot()` 里 `/api/bootstrap` 失败 → `document.body.innerHTML = …` 把整个 DOM 换掉 → 断网后是一个**纯白空白页**（`innerText` 长度 0，`body` 背景 `rgba(0,0,0,0)`）。更早一版是显示「连不上服务：Failed to fetch」这种技术文案 |
| 复现 | 打开首页 → 等 SW 激活 → `context.setOffline(true)` → reload |
| 证据 | `shots/r6-01-offline-shell.png`（白屏）、`shots/final-02-offline.png`（修复后） |
| 修复 | 对方已加离线兜底横幅：`employee.js:60 / 167` → `showOffline('离线模式：显示的是最后一次同步的数据，暂时不能打卡。')` |
| 复核 | ✅ 13:40 复测：断网后仍渲染完整外壳 + 橙色「⚠️ 离线模式：显示的是最后一次同步的数据，暂时不能打卡。」横幅，`innerText` 2085 字符 |
| 严重级 | P0（曾）→ 已修复 |

### P1-1｜首页主按钮「签进 / 签退」不是通栏按钮（**已修复**）

| 项 | 内容 |
|---|---|
| 页面 | 员工端 → 首页 |
| 现象 | 全app 最重要的按钮只占容器宽度的 **51%**（200px / 390px），左对齐，右边空一大块。`.btn` 类都显式写了 `display:block;width:100%`，唯独 `.bigbtn` 漏了 |
| 复现 | 首页截图量 `#btnCheckin` 的 boundingRect |
| 证据 | `shots/r1-03-home-390.png`（绿色按钮明显不满宽）、`shots/final-01-*.png` |
| 根因 | `app.css:98-101` `.bigbtn{…}` 没有 `display:block;width:100%`，而元素是 `<button>`（默认 `inline-block`，按内容宽度收缩） |
| 建议 | `app.css:98` → `.bigbtn{display:block;width:100%;margin-bottom:14px;…}`（照抄 `.btn` 的写法，app.css:45-49） |
| 严重级 | P1 —— 手机上主 CTA 不够醒目，老员工容易看漏 |

### P1-2｜终端深色页灰色小字对比度不足（**已修复**）

| 项 | 内容 |
|---|---|
| 页面 | 终端 kiosk |
| 现象 | 深色底上的次要信息全部低于 WCAG AA（4.5:1）：<br>• `#6f747d` on `#111318` = **3.96:1** —— 「长按二维码可查看终端信息」、底部「目标 24 h / 周」、「17 人 · 3 人在场」<br>• `#7e848e` on `#1d2128` = **4.29:1** —— 在场人员后面的时间戳「12:57」<br>• `#8a8f99` on `#181b21` ≈ 4.3:1 —— 「今日在场 / 团队本周累计」标签 |
| 复现 | 终端页截图 + 逐元素取 computed color/背景算对比度（`fe-r7-a11y.js`） |
| 证据 | `shots/r7-01-terminal-1440.png`、`test-reports/fe-r7-contrast-terminal.json` |
| 建议 | `app.css:150` `.term .foot` 的 `#6f747d` → `#9aa0aa`（≈6.5:1）；`app.css:148` `.person .t` 的 `#7e848e` → `#9aa0aa`；`app.css:142` `.stat .k` 的 `#8a8f99` → `#a8aeb8` |
| 严重级 | P1 —— 终端是放在 3 米外的大屏，远看更看不清 |

### P1-3｜员工端 / 管理端次要文字 `--ink-3` 对比度 3.95:1（**已修复**）

| 项 | 内容 |
|---|---|
| 页面 | 全部三端 |
| 现象 | `--ink-3:#7c7a72` 在 `--bg:#f7f5f0` 上只有 **3.95:1**，在白卡片 `#fff` 上 4.3:1 —— 都低于 4.5:1。受影响的全是「非主要内容」：副标题、表单 label、表格说明、员工状态、时间戳、「竖线 = 目标线…」图例、员工端「办公室在岗记录」「你是谁」「本周在岗」「类型」「8 位员工码」… |
| 复现 | `fe-r7-a11y.js` 逐叶节点算对比度 |
| 证据 | `shots/r2-iphone-emp-s-home.png`（12.5px 灰字）、`test-reports/fe-r7-contrast-employee.json`、`fe-r7-contrast-admin.json` |
| 建议 | `app.css:7` `--ink-3:#7c7a72` → **`#63615a`**（在 `#f7f5f0` 上 ≈ 5.6:1，在白卡上 ≈ 6.2:1，一次性把三端全修好）。终端深色页另算，见 P1-2 |
| 严重级 | P1 |

### P1-4｜`lib.js` 的 `fetch` 没有超时，服务端一卡 UI 就永久卡死（**已修复**）

| 项 | 内容 |
|---|---|
| 页面 | 全部三端 |
| 现象 | 服务重启/网络抖动时，点「登记指纹 / 面容」→ 按钮永远停在**「请按指纹…」且 disabled**，**没有任何错误提示**，没有取消按钮，只能杀掉页面重进 |
| 复现 | 服务端挂掉或重启中 → 点注册按钮 → 观察 30 秒 |
| 证据 | `shots/r1-02-setup-bad-invite-390.png`（按钮卡在「请按指纹…」，无错误提示） |
| 根因 | `lib.js:21-39` 的 `api()` 直接 `await fetch(...)`，没有 `AbortSignal.timeout()` |
| 建议 | `lib.js:22` → `init.signal = AbortSignal.timeout(15000)`，并在 `lib.js` 的 catch 里把 `AbortError` 翻译成「网络太慢了，请检查 Wi-Fi 后重试」 |
| 严重级 | P1 —— 员工遇到后不知道该干什么，管理员也解释不清 |

### P1-5｜管理端「审批」tab 显示的是旧数据（**已修复**）

| 项 | 内容 |
|---|---|
| 页面 | 管理端 → 审批 |
| 现象 | 页面打开后新提交的请假/补卡申请**不会出现**，老板必须手动刷新页面（F5）才能看到。tab 切换只切 CSS class，不重新拉数据 |
| 复现 | 保持管理端页面打开 → 员工端提交一条申请 → 切到「审批」tab → 待审批仍是 0 条；刷新后变 1 条 |
| 证据 | `shots/r5-06-admin-approvals.png` |
| 建议 | `admin.js` 的 tab 切换回调里，对 `t-req` 触发一次 `load()`；或者每 30s 轮询 `pendingExceptions` 数量并在 tab 上显示小红点 |
| 严重级 | P1 —— 老板可能一直看不到待审批，等员工来催 |

### P2-1｜首页「补卡 / 请假 / 出差」这一行有 `›` 箭头但点不动（**已修复**）

| 项 | 内容 |
|---|---|
| 页面 | 员工端 → 首页 |
| 现象 | 这一行右侧渲染了一个 `›` 箭头，视觉上是「可点进去」，但它只是 `.row` 里的一个静态 `<span>`，点了没反应。**同一个功能下面还有一个「提交补卡或假期申请」大按钮**，等于两个入口、只有一个能用 |
| 证据 | `shots/r1-03-home-390.png` |
| 建议 | `index.html:106` 二选一：① 删掉 `›`；② 把这一行做成真按钮，点击跳 `s-exception` |
| 严重级 | P2 |

### P2-2｜管理端每人工时输入框只有 70×32px（**已修复**）

| 项 | 内容 |
|---|---|
| 页面 | 管理端 → 员工列表 |
| 现象 | 每个员工的目标工时输入框实测 **70×32px**，宽高都不到 44px；且**没有 aria-label**，读屏软件只会读出一个裸数字框 |
| 证据 | `shots/r2-iphone-adm-t-people.png`、`shots/final-03-admin-people-390.png`（90 个这样的输入框） |
| 建议 | `admin.js` 渲染时加 `aria-label="${name} 每周目标小时"`，`style` 改成 `width:88px;padding:9px 10px`（≥44px 高） |
| 严重级 | P2（管理端以桌面为主，但平板上改工时会很难点） |

### P2-3｜管理端表格在窄屏不可读（**已修复**）

| 项 | 内容 |
|---|---|
| 页面 | 管理端 → 员工列表（390px） |
| 现象 | 「状态」列的 tag「已登记指纹」被压成**竖排 5 个单字**（已/登/记/指/纹）；「操作」列（重置邀请码 / 删除）被挤到视口外，必须横向拖动才能看到。`table.tbl th` 有 `white-space:nowrap`，但 `td` 没有 |
| 证据 | `shots/r2-iphone-adm-t-people.png`（旧构建，最典型）、`shots/final-03-admin-people-390.png`（新构建） |
| 建议 | `app.css` 给 `table.tbl td{white-space:nowrap}`（或只给状态列的 `.tag` 加 `white-space:nowrap`），并在 `.tscroll` 右侧加一个「→ 可横向滑动」的渐变提示 |
| 严重级 | P2 |

### P2-4｜恢复页「用指纹恢复」直接抛英文原文（**已修复**）

| 项 | 内容 |
|---|---|
| 页面 | 员工端 → 恢复页 |
| 现象 | 在没有本机指纹凭据的浏览器上点「用指纹恢复」，红字提示是：<br>`The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.`<br>这对员工（以及老板）完全不可读 |
| 证据 | `shots/r1c-06-recover-bio.png` |
| 建议 | `employee.js:252` 的 catch 里判 `e.name === 'NotAllowedError'` → 换成「这台手机上的指纹用不了了，请改用下面的员工码恢复」；顺便把 W3C 链接去掉 |
| 严重级 | P2 |

### P2-5｜终端闪屏遮罩挡住整个屏幕 3 秒（**已修复**）

| 项 | 内容 |
|---|---|
| 页面 | 终端 kiosk |
| 现象 | `.flash.on{pointer-events:auto}` 覆盖全屏（app.css:152-156）。有人打卡后 3 秒内，二维码点不动、长按也没反应。实测触摸长按必须等闪屏结束才生效 |
| 证据 | `shots/r4-03-term-flash.png`（闪屏）、`shots/r4b-touch-longpress.png`（触摸长按） |
| 建议 | `.flash` 改成 `pointer-events:none`（它只是提示，不需要接收点击），或把 `.flash.on` 的 `pointer-events` 保持 `none` |
| 严重级 | P2 |

### P2-6｜表单 label 没有和输入框程序化关联（**已修复**）

| 项 | 内容 |
|---|---|
| 页面 | 员工端（10 个输入框）/ 管理端（90 个输入框） |
| 现象 | 员工端的 label 是「视觉上的兄弟节点」，没有 `for`/`id` 关联、也没有 `aria-label`；管理端员工列表里的工时输入框**连视觉 label 都没有**。读屏软件读出来是「编辑框，空白」 |
| 证据 | `test-reports/fe-r7-result.json`（R7-6 / R7-7）、`shots/final-03-admin-people-390.png` |
| 建议 | 员工端 `index.html` 的每个 `<label>` 加 `for="…"`，对应 input 加 `id`（id 已经有了，补 `for` 即可，一行一个）；管理端工时输入框补 `aria-label` |
| 严重级 | P2 |

### P3-1｜终端页「今日在场」标签 11.5px（**已修复**）

`app.css:142` `.stat .k{font-size:11.5px}` —— 大屏上远处看基本看不见。建议提到 13–14px。证据：`shots/r7-01-terminal-1440.png`。

### P3-2｜`apple-touch-icon` 尺寸（**已修复**）

12:36 时 `index.html` 用 192×192 当 apple-touch-icon（iOS 期望 180×180），13:40 的 manifest 已有 `icon-180.png` 并被引用。✔

### 3.1 已修复、但值得记一笔的历史问题

| # | 问题 | 发现版本 | 现状 |
|---|---|---|---|
| H1 | 终端离线提示写成了 `innerContent`（拼写错误，非标准属性）→ 离线时二维码下方那行永远显示「扫码后请按指纹确认 · 二维码 0 秒后失效」，而不是「终端离线」 | 12:20（`terminal.js:45`） | ✅ 已改回 `innerHTML`，实测离线显示「终端离线：Failed to fetch」 |
| H2 | 终端重开页面会**重播上一次的打卡闪屏**（`lastEventCount=0` 起步，页面一开就闪一下几小时前的张三） | 12:20 | ✅ 已加 `primed` / `loadedAt` 判断，只闪页面打开之后的事件 |
| H3 | 闪屏判断按 `recent.length` 比较，而 `recent` 最多 10 条 → **一小时内第 11 次之后打卡都不再闪屏** | 12:20 | ✅ 已改成按事件 id 判断（`terminal.js:15/100`） |
| H4 | 服务端把邀请码从 6 位数字改成 12 位字母数字后，前端 `maxlength="6"` + `inputmode="numeric"` → 员工**根本输不进邀请码**（数字键盘打不出字母，最多 6 位） | 12:42 | ✅ 已改 `maxlength=16`、去掉 `inputmode`、label 改成「邀请码（12 位字母数字）」。但**大小写问题留下**（P0-1） |
| H5 | 删除员工的确认弹窗写「删除这个员工及其全部打卡记录？不可撤销。」，服务端其实改成**软删除**（保留历史） | 13:20 | ✅ 已改成「离职这个员工？会停用其打卡权限并清除指纹/邀请码，但历史打卡时长会保留在周报里。」 |
| H6 | 管理端 tab / `.btn.sm` 触摸目标只有 35px / 39px | 12:36 | ✅ 13:12 后 tab = 64×44、`.btn.sm` = 44px 高 |
| H7 | 终端离线时二维码框变成一大块白底、里面灰字「离线」 | 12:36 | ✅ 离线提示改到二维码下方一行（`.qrstate`），白框问题需再看一次终端页截图 |
| H8 | 员工码 / 邀请码提示文案还写「6 位」 | 12:42 | ✅ 已改成 12 位 / 8 位 |
| H9 | 审批 tab 在页面上显示旧数据 | 13:20 | ❌ 仍在（P1-5） |

---

## 4. PWA

| 检查项 | 结论 | 证据 |
|---|---|---|
| `manifest.webmanifest` 合法 | ✅ 能解析成合法 JSON；`name/short_name/start_url/scope/display/theme_color` 齐全 | `fe-r6-result.json` |
| 图标文件真的存在且尺寸对得上 | ✅ 逐个下载并读 PNG IHDR：180×180 / 192×192 / 512×512 / maskable 512×512 **全部与声明一致**，`type=image/png` 一致 | `fe-r6-result.json` |
| maskable 图标 | ✅ 有 `icon-maskable-512.png`（purpose=maskable），安卓不会被裁成圆形 | — |
| Service Worker 注册 | ✅ `navigator.serviceWorker.getRegistrations()` → 1 个，scope `http://localhost:8099/`，state `activated` | `fe-r6-result.json` |
| 应用外壳缓存 | ✅ 缓存里有 `/ /index.html /admin.html /terminal.html /app.css /lib.js /employee.js /terminal.js /admin.js /vendor/jsQR.js /manifest.webmanifest /icons/*` | `fe-r6-result.json` |
| 离线能打开应用外壳 | ⚠️ 12:36 版是**纯白屏**（P0-3）→ ✅ 13:40 版已修：完整外壳 + 「⚠️ 离线模式…」横幅 | `shots/r6-01-offline-shell.png`（坏）→ `shots/final-02-offline.png`（好） |
| 加到主屏的图标是不是那三个 PNG | ✅ 是。**但终端页 `terminal.html` 不引用 manifest**，kiosk 加不到主屏（员工端可以） | `fe-r6-result.json` |
| localStorage 的 deviceToken 掉了怎么办 | ✅ 已有自助恢复页（P0-4）。**注意 employee.js 现在把整个员工花名册 `pb.bootstrap` 和最近一次 `pb.me` 都缓存在 localStorage 里** —— 手机上会存下全公司同事的名字/工位，离职员工也不会被清掉 | `shots/r6-03-after-cache-clear.png` |

> **额外提醒（隐私）**：`pb.bootstrap` 里存了全公司员工名单（姓名 + 工位 + 是否已登记指纹）。
> 这台手机是公用的（前台 / 工位区），谁都能看到。至少加个 TTL（比如 24h）或只缓存当前员工。

---

## 5. 文案 / 可读性检查

| 检查项 | 结论 |
|---|---|
| 面向人的文案有没有错别字 | ✅ 通读三端文案没发现错别字。「员工码」「邀请码」「弱验证」「未达标」「在岗」用词都准确 |
| 有没有「这是给工程师看的」表述 | ✅ 员工端和管理端正文里**没有** WebAuthn / deviceToken / sessionId / challenge 等术语（`fe-r7` R7-8 / R7-9 全过）。唯一漏出来的是 P2-4 那句英文 W3C 原文 |
| 按钮是否说明了点会发生什么 | ⚠️ 大部分好（「登记指纹 / 面容」「提交给管理员审批」「用这个码打卡」「添加并生成邀请码」）；**「签进 / 签退」只有两个字**，第一次用的人不知道是干什么（P1-1 一起改，`.bigbtn .s` 那行副标题已经在解释了） |
| 全大写 / 小字号 | ⚠️ 终端页 8 位码是全大写（合理，是码）；但终端页「今日在场」标签只有 11.5px（P3-1） |
| 对比度 | ❌ P1-2（终端深色页 4 处）、P1-3（三端 `--ink-3` 全面不达标） |

**做得好的地方**（值得保留）：
- 「签进 / 签退」按钮文案随状态切换 + 副标题解释（`employee.js:84-90`）—— 解决了「员工不知道自己是进还是出」。
- 「刚刚已经打过卡了 / 没有重复记录」—— 防连点，文案是人话。
- 「指纹不可用？用员工码」/「以前激活过？点这里恢复」—— 兜底路径写得很清楚。
- 管理端「重置密钥 / 看链接」前的二次确认：「重置后，旧链接会立刻失效，需要用新链接重新打开终端页面。继续？」—— 把后果讲明白了。
- 终端离线提示现在会区分「密钥无效 → 请让管理员重新生成链接」「终端不存在或已被删除」「终端离线」三种（`terminal.js:104-112`）—— 老板看终端时能立刻知道该找谁。

---

## 6. 交付清单

- 本报告：`/workspace/presence-beacon/test-reports/C-frontend.md`
- 截图 120 张：`/workspace/presence-beacon/test-reports/shots/`
- 结构化结果：`fe-r1-result.json` / `fe-r2-result.json` / `fe-r3-result.json` / `fe-r4-result.json` / `fe-r5-result.json` / `fe-r6-result.json` / `fe-r7-result.json` / `fe-final-result.json`
- 对比度原始数据：`fe-r7-contrast-{terminal,employee,admin}.json`
- 测试脚本：`fe-*.js`（均可直接 `node fe-rX-xxx.js` 重跑）

> 测试期间创建的员工（`前端测试B*`）与终端已全部清理/或标记为其他 agent 自己的数据；
> 未改动 `public/` 下任何源文件；未重启服务、未删除 `data/`。
