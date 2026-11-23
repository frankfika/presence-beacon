# D · 部署可行性评估报告

**项目**：在岗哨 Presence Beacon（废弃安卓机 → 每周在岗打卡机）
**仓库**：`/workspace/presence-beacon/`
**评估人**：DevOps
**评估日期**：2026-11-23
**测试环境**：Node v22.19.0（自带 `node:sqlite`）、Chromium + VirtualAuthenticator、Linux x64
**测试方式**：全部为**真实执行**，非代码走读。所有脚本与产物在 `test-reports/` 下可复跑。

---

## 0. 一句话结论

**核心功能是好的，但"直接交给一个不熟悉命令行的老板"还不行。**

「零状态 → 能打卡」这条主链路我完整跑通了（Playwright 24/25 通过），说明业务逻辑本身能上线。但仓库里**一个部署产物都没有**（无 README、无 .env.example、无 Dockerfile、无 .gitignore/.dockerignore），而且有 3 个会让部署**当场失败**的坑（见 §1）。

> ### ⚠ 关于源码并发改动的重要说明
> 评估期间**另一个 agent 正在并发修改 `server/`**（`server/index.js` 12:27、`server/db.js` 12:28 被改写）。
> 本报告区分两个快照：
> - **快照 A**（12:16）= 我在 `test-reports/cleanroom/` 留存的原始副本 → 冷启动、首次口令、环境变量矩阵（第一版）、零状态 E2E、备份/持久化测试跑在这一版。
> - **快照 B**（12:27 之后）= 当前源码 → WebAuthn origin 矩阵、升级测试、并发/可靠性复测跑在这一版。
>
> **并发改动已经修掉了我发现的 2 个问题**（`TZ_OFFSET_MINUTES` 死代码、`APP_ORIGIN` 尾斜杠处理），我在 §3.2 标注了「已复测生效」。
> **但仍有 1 个同类问题没修完**（`APP_ORIGIN` 尾斜杠 / 多 origin 在**校验路径**仍然失败，见 §4.3）——这是当前源码的真实状态。

---

## 1. 最致命的部署障碍（Top 3）

### 🔴 P0-1 · 旧安卓机走 http 打开 → 指纹功能**完全不可用**，产品前提失效

**问题**：WebAuthn / PWA 只在**安全上下文**里可用。`http://` + 非 localhost 主机 → `isSecureContext=false`、`PublicKeyCredential=undefined`。而"废弃安卓机改造成打卡机"这个前提，就是要在办公室局域网里用那台安卓机扫码 + 按指纹。

**证据**（`test-reports/out-upgrade.txt`）：

```
═══════ 2. 安全上下文（决定旧安卓机能不能用指纹） ═══════
  localhost（开发机本地）
    URL=http://localhost:8123/  isSecureContext=true  PublicKeyCredential=function
  http + 非 localhost 域名（真实部署最常见：内网 IP / http 域名）
    URL=http://pb.example.com:8123/  isSecureContext=false  PublicKeyCredential=undefined
    点「登记指纹」后 UI 提示 = "这个浏览器不支持指纹验证，请改用员工码"
```

**严重级**：🔴 致命（产品级）。老板按最直觉的方式做（`http://192.168.1.50:8080` 打开安卓机）→ 指纹这条路直接不通，只能退回 6 位 PIN，而 PIN 会被管理端标成"弱验证"。

**建议改法**（二选一，README 必须写死）：
1. **必须上 HTTPS**（推荐）：用 Caddy / Nginx 在前面做 TLS 终结，域名要能被安卓机解析（内网 DNS 或公网域名 + 内网 hosts）。
2. 退而求其次：安卓机用 `http://localhost:PORT` 打开（Chrome 把 localhost 当安全上下文）——但那台安卓机得自己跑服务，不现实。
3. 代码侧兜底（建议加）：`public/index.html` 里 `isWebAuthnAvailable()` 为 false 时，**不要只提示"请改用员工码"**，要明确写「当前是 http 访问，指纹不可用，请让管理员配置 HTTPS 域名」。现在这句提示会让老板以为手机坏了。

---

### 🔴 P0-2 · `RP_ID` / `APP_ORIGIN` 配错 = **全员一个都打不了卡**，而且报错是英文原文 + HTTP 500

**问题**：WebAuthn 要求 `RP_ID`（裸主机名）必须是浏览器地址栏主机的后缀，`APP_ORIGIN` 必须和地址栏**完全一致**（协议 + 域名 + 端口）。配错的临床表现是"服务看起来正常，但所有人都打不了卡"。

**证据**（`test-reports/out-webauthn-https.txt`，真实 https + 自签证书 + 虚拟认证器）：

| # | 配置 | 结果 | 用户看到的原文 |
|---|---|---|---|
| A | `RP_ID=pb.example.com` + `APP_ORIGIN=https://pb.example.com:8443` | ✅ 正常 | — |
| B | 只设 `RP_ID`，`APP_ORIGIN` 留空 | ✅ 正常 | — |
| C | `APP_ORIGIN` 漏了端口 | ❌ | `Unexpected response origin "https://pb.example.com:8443", expected one of: https://pb.example.com` |
| D | `APP_ORIGIN` 末尾多一个 `/` | ❌ | `"https://pb.example.com:8443/" is not a valid expected origin. Remove the trailing "/" and try again` |
| E | `RP_ID=https://pb.example.com`（写成完整 URL） | ❌ | `The relying party ID is not a registrable domain suffix of, nor equal to the current domain.` |
| F | 换域名后忘改 `RP_ID` | ❌ | `The relying party ID is not a registrable domain suffix of... .well-known/webauthn resource of the claimed RP ID failed.` |
| H | `RP_ID=域名`，员工用 IP 打开 | ❌ | `This is an invalid domain.` |
| I | 全默认（`RP_ID=localhost`）但部署在域名上 | ❌ | `The relying party ID is not a registrable domain suffix of...` |

**错误提示兜底：完全没有。** 所有失败都是把浏览器/`@simplewebauthn` 的**英文原文**直接塞进中文 UI，服务端还返回 **HTTP 500**（配置错误被当成服务器内部错误）。一个中文老板看到 `Unexpected response origin ... expected one of: ...` 无从下手。

**严重级**：🔴 致命（部署级）。配置只有两个变量，却有 6 种错法，且没有任何一处提示"是不是 RP_ID 配错了"。

**建议改法**：
1. **启动时自检 + 中文人话提示**：启动时把 `RP_ID` / `APP_ORIGIN` 打印成一张"配置表"，并在 `RP_ID` 里检测到 `://` 或 `/` 时直接打印红字警告：`⚠ RP_ID 只能写裸域名（如 pb.example.com），你写的是 "https://pb.example.com" —— 这样所有人都打不了卡`。
2. **启动时 HTTP 探测**：启动后用 `fetch(APP_ORIGIN)` 打一下自己，origin 对不上就在横幅里打印「你用 https://xxx 访问，但 APP_ORIGIN 写的是 yyy」。
3. **错误兜底**：在 `server/index.js` 的 catch 里对 WebAuthn 错误做映射，输出中文：
   ```js
   const WA_HELP = {
     'origin': '访问地址和 APP_ORIGIN 对不上。APP_ORIGIN 必须和浏览器地址栏一字不差（协议+域名+端口），末尾不要加 /',
     'relying party ID': 'RP_ID 配错了。RP_ID 只能写裸域名（不能带 https:// 、不能带路径），且必须是当前访问域名的后缀',
     'not a valid expected origin': 'APP_ORIGIN 末尾多了一个 /，去掉它',
     'invalid domain': 'RP_ID 和你访问的地址不是同一个域名，请统一',
   };
   ```
   并且 WebAuthn 失败应当返回 **400 + 中文**，而不是 500。
4. `server/webauthn.js:31` 的 `_expectedOrigin(req)` 是**死代码**，从来没被调用过 —— 要么用它，要么删掉。

---

### 🔴 P0-3 · `cp data/presence.db backup.db` 会**丢掉全部打卡记录**

**问题**：数据库开了 WAL 模式。**刚写的数据大部分还躺在 `presence.db-wal` 里没进主库文件**。最直觉的备份命令（只拷主库）会静默丢数据，没有任何报错。

**证据**（`test-reports/out-persist.txt`）：

```
    主库文件 4096 字节；WAL 文件 276072 字节
    线上库实际内容：employees=1 events=5

### 备份方式 A：只复制 presence.db（最直觉的做法）
  观察 : 备份里 employees=0 events=0（线上是 employees=1 events=5）；WAL 有 276072 字节没被带走
  判定 : ★丢数据：少了 5 条打卡记录 —— WAL 里未落盘的事实在只拷主库时会丢

### 备份方式 B：主库 + -wal + -shm 一起拷      → ✓ 数据完整
### 备份方式 C：VACUUM INTO（在线一致性快照）   → ✓ 数据完整且是单文件
```

**严重级**：🔴 致命（数据级）。3-5 人团队一个月几百条打卡记录，老板备份一次就全没了，而且不会收到任何提示。

**建议改法**：
1. **README 里只允许一种备份命令**，并且给一个现成脚本 `scripts/backup.sh`：
   ```bash
   #!/bin/sh
   # 在线一致性备份，不需要停服务
   set -e
   DB="${DB_FILE:-data/presence.db}"
   OUT="${1:-backups/presence-$(date +%Y%m%d-%H%M%S).db}"
   mkdir -p "$(dirname "$OUT")"
   node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.DB_FILE||'data/presence.db');d.exec(\"VACUUM INTO '${OUT}'\");d.close()"
   echo "备份完成：$OUT"
   ```
2. 如果一定要用 `cp`，**必须三件套**：`cp data/presence.db* backup/`（把 `-wal` `-shm` 一起带上），并在 README 里用红字标注「只拷 `.db` 会丢数据」。
3. 更稳的做法：加一个 `POST /api/admin/backup` 按钮（管理端点一下就下载 `.db`），老板根本不用碰命令行。

---

## 2. 冷启动路径实测（全新环境 → 跑起来）

### 2.1 模拟全新 clone

```bash
# 用 tar 模拟「只 clone 了源码，没有 node_modules / data / .git」
mkdir -p /workspace/presence-beacon/test-reports/cleanroom
cd /workspace/presence-beacon
tar --exclude=node_modules --exclude=data --exclude=test-reports --exclude=.git -cf - . \
  | (cd test-reports/cleanroom && tar -xf -)
```
得到一个只有 `package.json / package-lock.json / server/ / public/ / test/` 的干净目录。

### 2.2 依赖安装：✅ 没问题

```console
$ cd test-reports/cleanroom && npm ci
added 55 packages, and audited 56 packages in 7s
2 packages are looking for funding
found 0 vulnerabilities
real 0m7.245s
```

- `npm ci` ✅ 7 秒，0 漏洞。
- `npm install` ✅ 也能跑，但**会改写 `package-lock.json`**（把根包的 `engines` 字段补进去）→ 部署请用 `npm ci`。
- 生产依赖只有 3 个：`@simplewebauthn/server`、`qrcode`、`jsqr`。
  - ⚠ **`jsqr` 是无用依赖**：浏览器用的是仓库里已经 vendored 好的 `public/vendor/jsQR.js`（256KB），服务端从不 `require('jsqr')`。建议从 `package.json` 删掉（能少装一个包，语义也更干净）。
  - `node_modules` 装完 10MB / 40 个包，`npm ci --omit=dev` 同样 10MB（没有 devDependencies）。
- `npm test` ✅ 17 个用例全过（`test/rules.test.js`）。
- ⚠ `test/e2e.js` / `test/shots.js` 里硬编码了 `require('/usr/local/lib/node_modules/playwright')` 和 `/workspace/output/presence-beacon/index.html` → 换台机器就跑不了。它们不在 `npm test` 的 glob（`test/*.test.js`）里，所以**不影响部署**，但会让新同事以为测试坏了。

### 2.3 空库首启动：口令能拿到，但对非技术用户不够友好

**实测输出**（`npm start`，stdout）：

```
┌─────────────────────────────────────────────┐
│  在岗哨 Presence Beacon                      │
├─────────────────────────────────────────────┤
│  员工端   http://localhost:8123/            │
│  管理端   http://localhost:8123/admin       │
│  数据库   /.../cleanroom/data/presence.db   │
│  管理员口令 tzQwSbfoGHyi                    │
└─────────────────────────────────────────────┘
```

**stderr**（只有一行，不影响 stdout）：
```
(node:5711) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
```

实测结论：

| 检查项 | 结果 |
|---|---|
| 空库能自动建库 | ✅ `data/` 目录 + `presence.db` 自动创建（多级目录也会 `mkdir -p`） |
| 口令随机生成 | ✅ `crypto.randomBytes(9).toString('base64url')` → 12 位，base64url 字符集（`- _` 也在里，手打略别扭但可复制） |
| 口令持久化 | ✅ 存进 `settings` 表，**重启不变**（实测第 1 次 = 第 2 次 = 第 4 次启动打印的都是同一个） |
| 口令只打印一次？ | ❌ **每次启动都打印**（包括从 DB 读出来的）。好处是老板随时能翻日志找回；坏处是日志里长期留有明文口令 |
| 横幅里的网址有用吗 | ❌ **没用**。永远显示 `http://localhost:8080`——部署到服务器后，老板看到的是 `localhost`，根本不知道该让员工访问哪个地址 |
| 冷启动耗时 | ≈ 2.0 秒（主要是 `@simplewebauthn/server` + `qrcode` 的 require） |

**严重级**：🟡 中（体验级）。口令能拿到，不会卡死；但"横幅只给 localhost"会让不熟悉命令行的老板直接懵掉。

**建议改法**（按性价比排序，都需要改 `server/index.js`）：

1. **首启写一个文件**（最有用）：
   ```js
   if (!ADMIN_SECRET) {
     ADMIN_SECRET = crypto.randomBytes(9).toString('base64url');
     store.setSetting('adminPassword', ADMIN_SECRET);
     // 新增：写一份到磁盘，方便老板直接打开看
     try {
       fs.writeFileSync(path.join(path.dirname(DB_FILE), 'admin-password.txt'),
         `在岗哨 管理员口令\n${ADMIN_SECRET}\n生成时间：${new Date().toISOString()}\n`);
       fs.chmodSync(path.join(path.dirname(DB_FILE), 'admin-password.txt'), 0o600);
     } catch {}
   }
   ```
   然后横幅改成：
   ```
   │  管理员口令   tzQwSbfoGHyi
   │  已写入       data/admin-password.txt
   ```
2. **打印一条可直接复制的完整启动/访问命令**，而不是只有 `localhost`：
   ```
   │  员工端   https://pb.example.com/
   │  管理端   https://pb.example.com/admin
   │  本机访问 http://localhost:8080/
   ```
   （外网地址从 `APP_ORIGIN` 或 `PUBLIC_URL` 推导）
3. **Docker 场景**：口令会打在 `docker compose logs presence-beacon` 里，README 直接写「口令在日志里：`docker compose logs presence-beacon | grep 管理员口令`」。
4. **口令不进日志**（可选，`ADMIN_PASSWORD` 已设时不要打印）：改成
   ```js
   const shown = process.env.ADMIN_PASSWORD ? '(来自 ADMIN_PASSWORD 环境变量)' : ADMIN_SECRET;
   ```
5. `ADMIN_PASSWORD` 语义要写清楚：**它只是临时覆盖，不会写回数据库**。实测：设了 env 用 env 的口令登录成功（200），用旧口令登录失败（403）；**把 env 撤掉，旧口令立刻复活**。→ 两个口令长期共存 → 老板会懵。README 必须写「设了 `ADMIN_PASSWORD` 就一直保持它，别中途撤」。

---

## 3. 环境变量与配置（逐个实测）

### 3.1 汇总表

| 变量 | 默认值 | 实测 | 严重级 | 备注 |
|---|---|---|---|---|
| `PORT` | `8080` | ✅ 生效 | — | 横幅会显示 |
| `HOST` | `0.0.0.0` | ✅ 生效 | — | 设成 `127.0.0.1` 则只监听本机 |
| `DB_FILE` | `<repo>/data/presence.db` | ✅ 生效 | — | 绝对路径（`__dirname` 推导，**与 cwd 无关**）→ Docker 里很友好 |
| `RP_NAME` | `在岗哨` | ✅ 生效 | — | 出现在 WebAuthn `rp.name` |
| `RP_ID` | `localhost` | ✅ 生效 | 🟡 | 必须是**裸域名**；误配成 URL 会全员打不了卡（P0-2） |
| `APP_ORIGIN` | 空 | ⚠️ **部分生效** | 🟡 | 尾斜杠 / 逗号多 origin 在**校验路径**仍失败（§4.3） |
| `ADMIN_PASSWORD` | 空 | ⚠️ 生效但只是"临时覆盖" | 🟡 | 不写回 DB，撤掉 env 会回退（§2.3） |
| `TZ_OFFSET_MINUTES` | `480` | ✅ **已修**（快照 B） | — | 快照 A 是**死代码**（`server/index.js:25` 定义了 `TZ_OFFSET` 但全文没用）；快照 B 已接到 `settings.timezoneOffsetMinutes`，实测 `TZ_OFFSET_MINUTES=-480` → `/api/bootstrap` 返回 `-480` ✅ |
| `REPORT_WEBHOOK_URL` / `REPORT_PUSH_HOUR` | — | 新增（快照 B） | — | 并发 agent 新加的推送功能，README 未覆盖 |

### 3.2 补充实测细节

**`DB_FILE` 指向一个目录** → 启动直接崩，退出码 1，打印 Node 原始堆栈：
```
Error: unable to open database file
    at new Store (.../server/db.js:114:15)
```
→ 建议加一层 try/catch，输出「数据目录不可写或路径是目录，请检查 DB_FILE」。

**`DB_FILE` 指向不存在的多级父目录** → ✅ 自动 `mkdir -p` 建好。

**`.env` 文件根本不会被加载** ❌（重要）
```
$ grep -rn "dotenv\|env-file\|loadEnv" server/ package.json
  ★ 没有任何 .env 加载逻辑
```
→ 所以光给一个 `.env.example` 是不够的！README 必须写清楚怎么让它生效。可选方案（Node 22 原生支持，已实测）：
```console
$ node --env-file=.env -e "console.log(process.env.PORT)"
8199
$ node --env-file-if-exists=.env -e "..."   # 文件不存在时只打一行提示继续跑
```
建议把 `package.json` 的 start 脚本改成：
```json
"start": "node --env-file-if-exists=.env server/index.js"
```
（这样 `.env` 有没有都能跑，且**不用改任何源码**就能让 `.env` 生效。）

---

## 4. WebAuthn / HTTPS 部署

### 4.1 正确的配置长什么样

```bash
# 有域名 + 反向代理终结 TLS
RP_ID=pb.example.com          # 裸域名，不能带 https:// 、不能带路径、不能带端口
APP_ORIGIN=https://pb.example.com   # 和浏览器地址栏一字不差（协议+域名+端口），末尾不加 /
```

**实测（真实 https + 自签证书 + Chromium 虚拟认证器）**：这套配置**完整跑通登记指纹** ✅。
`APP_ORIGIN` 留空也可以（服务端会用 `x-forwarded-proto` + `Host` 头推断），实测 ✅ —— 但**反向代理必须透传 Host 和 X-Forwarded-Proto**，否则推断出来的 origin 是代理自己的地址。

### 4.2 反向代理必须满足的 4 条

1. 透传 `Host`（或 `X-Forwarded-Host`）—— 决定 `APP_ORIGIN` 留空时的推断结果
2. 透传 `X-Forwarded-Proto: https`
3. **不能改写 `Host` 成上游地址**（很多反代默认会改）
4. 最好把 `APP_ORIGIN` 显式设上，别指望推断

### 4.3 ⚠️ 当前源码仍存在的问题：`APP_ORIGIN` 尾斜杠 / 多 origin 在校验路径仍失败

并发 agent 在 `server/index.js:36-39` 加了归一化：
```js
const origins = APP_ORIGIN
  ? [...new Set(APP_ORIGIN.split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean))]
  : [];
```
**但这个归一化后的数组从来没被用上。** 校验路径仍然传原始字符串：

```
server/index.js:440:  const origin = APP_ORIGIN || `${...}://${req.headers.host}`;
server/index.js:474:  const origin = APP_ORIGIN || `${...}://${req.headers.host}`;
server/webauthn.js:70:   expectedOrigin: origin,      // ← 传的是单个原始字符串
server/webauthn.js:124:  expectedOrigin: origin,
server/webauthn.js:31:   _expectedOrigin(req)         // ← 死代码，从没被调用
```

**实测（快照 B，当前源码，真实浏览器）**：
```
单个 origin（无尾斜杠）  APP_ORIGIN=https://pb.example.com:8443
  结果=✅ 成功
单个 origin（带尾斜杠）  APP_ORIGIN=https://pb.example.com:8443/
  结果=❌ "\"https://pb.example.com:8443/\" is not a valid expected origin. Remove the trailing \"/\" and try again"
多个 origin（逗号分隔）  APP_ORIGIN=https://pb.example.com:8443,https://other.example.com
  结果=❌ "Invalid URL"
```

**建议改法**（一行）：
```js
// server/index.js，把 440 / 474 两行都改成：
const origin = APP_ORIGIN ? webauthn.origins : `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
// 或更好：让 webauthn.verify* 接受 origins 数组
await webauthn.verifyRegistration({ employee: emp, response, challengeId, origin: webauthn.origins });
```
`@simplewebauthn/server` 的 `expectedOrigin` 支持 `string | string[]`，传数组即可。

### 4.4 `.well-known/webauthn`

浏览器在 RP ID 不匹配时会去请求 `https://<rp-id>/.well-known/webauthn`，本项目**没有这个路由**（404）。
本项目不需要它（RP ID 只用于同源校验），但错误信息里会提到它 → 更容易让老板困惑。README 里说明一句即可。

---

## 5. 数据持久化与备份

### 5.1 SQLite 文件在哪

| 场景 | 路径 |
|---|---|
| 默认 | `<仓库根>/data/presence.db`（绝对路径，与 cwd 无关） |
| WAL | 同目录 `presence.db-wal`（+ `presence.db-shm`） |
| Docker | 建议 `DB_FILE=/data/presence.db` + volume 挂 `/data` |
| 实测权限 | `presence.db` = `0644`，`-wal` = `0644`，目录 = `0755`，owner = 运行用户 |

### 5.2 备份 / 恢复演练（真做了）

```
备份 A：只 cp presence.db          → ✗ 丢 5 条记录（主库才 4KB，数据在 276KB 的 WAL 里）
备份 B：cp presence.db* （三件套）  → ✓ 完整
备份 C：VACUUM INTO                → ✓ 完整，单文件 81920 字节，自带一致性  ← 推荐
恢复：备份 → 删库 → 拷回 → 重启
  → employees=1 events=5（与备份前一致），管理端能登录、能看到员工和周报  ✓
```

**严重级**：见 P0-3。数据库里存着**明文管理员口令**、员工 6 位 PIN、`device_token_hash`、终端 secret → `0644` 意味着同机器任何用户都能读。容器内跑问题不大，但宿主机直接跑要注意。

### 5.3 WAL + 多进程并发

**实测**：两个进程（8123 / 8124）各写 30 次 PIN 打卡，共 60 次：
```
成功 57 / 失败 3
错误样本：["database is locked", "database is locked"]
```
→ **确实会随机失败**。原因是 `server/db.js` 的 PRAGMA 只有 `journal_mode = WAL` 和 `foreign_keys = ON`，**没有设 `busy_timeout`**（`node:sqlite` 的默认 busy_timeout 是 0，不像 `better-sqlite3` 默认 5000）。

**严重级**：🟡 中（单机单进程部署不受影响；多副本 / 多容器共享同一个卷时会随机失败）。

**建议改法**（一行）：
```js
// server/db.js 的 SCHEMA 开头加一行
PRAGMA busy_timeout = 5000;
```
另外 README 要写死：**这是一个单进程应用，不要起多个副本共享同一个数据卷**（SQLite 也扛不住多写者）。

---

## 6. 运行可靠性

| 检查项 | 实测结果 | 判定 |
|---|---|---|
| 优雅退出 `SIGTERM` | `exit code = 0, signal = null`（`store.close()` + `process.exit(0)`） | ✅ 优雅 |
| 优雅退出 `SIGINT` | 同上，`exit code = 0` | ✅ |
| `kill -9` 后重启 | WAL 自动回放：events=10 → 重启后 events=10，员工在、管理端能登录能看周报 | ✅ 数据完好 |
| 端口被占用 | **直接崩**：退出码 1，`Unhandled 'error' event` + Node 原始堆栈（`EADDRINUSE`） | ⚠️ 无兜底 |
| 未捕获异常 | 各种畸形输入（`name` 传对象、超长字符串、非法 settings）→ 全部被路由层 try/catch 兜住，返回 400/500，**进程始终存活** | ✅ |
| 静态资源目录穿越 | `/../server/index.js`、`/..%2f..%2fserver%2findex.js`、`/%2e%2e/server/db.js`、`/package.json` → **全部 404** | ✅ 安全 |
| `node:sqlite` ExperimentalWarning | 打在 **stderr**（stdout 干净）。但 `docker logs` 会把两者混在一起 → 日志里会很丑 | ⚠️ 需消除 |
| 健康检查端点 | `/health` `/healthz` `/readyz` `/api/health` `/api/ping` `/ping` → **全部 404** | ❌ 缺失 |
| Docker 语义 | Docker 停止容器发 SIGTERM → 实测能优雅退出（退出码 0），**但如果用 `npm start` 作为 ENTRYPOINT，npm 不保证把 SIGTERM 转发给子进程** → 建议 `CMD ["node","server/index.js"]` | ⚠️ |

### 建议改法

**1) 加健康检查端点**（`server/index.js`，放在静态路由之前）：
```js
if (p === '/healthz' || p === '/health') {
  // 只返回极简信息，绝不能把员工名单之类暴露出去
  return sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()), db: 'ok' });
}
```
> ⚠️ **不要**用 `/api/bootstrap` 当健康检查 —— 它是公开接口且返回**全部员工姓名**（`/api/bootstrap` 无鉴权）。

**2) 消除 ExperimentalWarning**（Dockerfile 里一行，不改源码）：
```dockerfile
ENV NODE_OPTIONS="--disable-warning=ExperimentalWarning"
```
实测：
```console
$ NODE_OPTIONS="--disable-warning=ExperimentalWarning" node -e "require('node:sqlite'); console.log('NODE_OPTIONS OK')"
NODE_OPTIONS OK        # 没有 ExperimentalWarning
```

**3) 端口占用给出人话提示**：
```js
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ 端口 ${PORT} 已被占用。换个端口：PORT=8081 npm start`);
    process.exit(1);
  }
  throw err;
});
```

**4) 加 `process.on('uncaughtException')` / `unhandledRejection` 兜底**：当前路由层有 try/catch，但请求处理之外的异常（比如 `fs.createReadStream` 报错）没有兜底 → 进程会直接挂。加：
```js
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); store.close(); process.exit(1); });
```

---

## 7. 首次使用路径（零状态 → 能打卡）—— Playwright 全程实测

**脚本**：`test-reports/d-zerostate.js`　**输出**：`test-reports/out-zerostate.txt`　**截图**：`test-reports/shots/d01~d11*.png`

```
【0】冷启动：npm start（全新空库）
  ✓ 服务起来了
  ✓ 启动横幅里能找到管理员口令
  ✓ stderr 只有 ExperimentalWarning，没有堆栈

【1】管理员第一次打开 /admin
  ✓ 错误口令有中文提示        → "口令不正确"
  ✓ 用横幅上的口令可以登录

【2】管理员添加员工
  ✓ UI 上能看到邀请码 / 员工码

【3】管理员添加终端
  ✓ UI 上能看到终端链接

【4】★ 终端列表里的「查看终端链接」按钮
  ✗ ★「查看终端链接」给出的链接里带上了终端密钥
     → alert 里是 ...&key=      （正确密钥是 32 位 hex）
     → 正确密钥：6c662bbc87352a61d1b6d1652e3bae6b

【5】终端大屏（用管理端给的链接打开）
  ✓ 终端页渲染出二维码
  ✓ 终端页显示 8 位会话码

【6】员工第一次打开首页（零状态）
  ✓ 首次打开进入「激活这个手机」页

【8】员工登记指纹
  ✓ 登记成功后进入首页
  ✓ 认证器里真的生成了凭据

【9】员工扫码打卡
  ✓ 打卡完成且显示「已签进」

【11】终端大屏是否看到在场   → sPresent = "1 / 1 人"  ✓
【12】管理端周报是否能看到这条记录  ✓
【13】页面 JS 错误          → 员工端/管理端/终端端 均无报错  ✓

═══════════════════════════════
通过 24 · 失败 1
═══════════════════════════════
```

### 🔴 P0-4 · 「查看终端链接」按钮给的是**空密钥**链接 —— 终端链接拿不回来

**问题**：`public/admin.js:183`
```js
const url = `${location.origin}/terminal.html?tid=${t.id}&key=${t.key || ''}`;
```
但 `/api/admin/overview` 返回的 terminal 对象只有 `{ id, name, location, active }`，**没有 `key` 字段** → `t.key` 恒为 `undefined` → 链接里 `key=` 是空的。

**后果**：终端链接**只在"新建终端的那一瞬间"能看到一次**（`btnAddTerm` 用的是创建接口返回的 `secret`，是对的）。之后管理端就再也拿不到这条链接了 —— 老板刷新一下页面、或者换台电脑，就得**删掉终端重建**，而重建会换一个新 secret、旧的安卓机上的二维码立刻失效。

**证据**：见上【4】，alert 原文：
```
把下面这条链接在旧安卓机的浏览器里打开（建议加书签并锁定全屏）：

http://localhost:8123/terminal.html?tid=83717066-a7fa-4e79-94bc-031e77c83ffc&key=
```

**严重级**：🔴 高（部署级，直接卡住"创建终端 → 拿终端链接"这一步）。

**建议改法**（二选一）：
- A. **在 `/api/admin/overview` 的 terminal 列表里带上 `secret`**（管理端接口本来就要管理员 token，安全上没问题），并把 `admin.js:183` 改成 `key=${t.secret}`。
- B. **加一个"重新生成终端链接"按钮**：`POST /api/admin/terminals/:id/rotate-secret` → 换新 secret 并返回完整链接，同时让旧链接失效（更安全，避免长期暴露 secret）。
- 建议 **A + B 都要**：A 让老板随时能拿到，B 让老板在安卓机丢了/换机时能重置。

### 🟡 P1-1 · 管理端把 HTML 标签当**字面量**显示出来

**问题**：`public/admin.js` 的 `msg()` 会对整段文本做 `esc()`，而调用方传进来的 `<strong>` / `<br>` / `<code>` 也被一起转义了 → 页面里出现字面的 `<strong>`。

**证据**（截图 `test-reports/shots/d03-admin-employee.png`）：
> 已添加。邀请码：`<strong>`780641`</strong>`　员工码：`<strong>`803845`</strong>`（员工码是指纹不可用时的兜底）

> 终端已创建。在旧安卓机上打开这个链接：`<br>``<code style="word-break:break-all">`http://localhost:8123/terminal.html?tid=…&amp;key=…`</code>`

（终端那条更糟：`&` 也变成了 `&amp;` 字面量，老板复制出来的链接是坏的。）

**严重级**：🟡 中（体验级，但会直接让老板复制到错误链接）。

**建议改法**：`msg()` 不要无脑 `esc()`，要么：
- 分成"纯文本"和"HTML"两个函数（`msgText` / `msgHtml`），HTML 版本只对**用户数据**做转义；
- 或者 `msg()` 接受一个已经转义好的 HTML 片段（`msgHtml(id, html)`），调用方自己转义用户输入。
另外邀请码/员工码最好给出**一键复制**按钮（`navigator.clipboard`），别让老板手抄 6 位数字。

### 🟢 做得好的地方（别改）
- 员工端零状态 → 激活页 → 登记指纹 → 首页 → 扫码 → 打卡 → 终端显示在场 → 管理端周报，**全链路真实跑通**。
- 错误口令提示「口令不正确」、二维码过期/已用提示，都是中文人话。
- 终端页服务断开时显示「终端离线」，不会白屏。
- 员工端在没有员工时提示「管理员还没有添加任何员工。」—— 这是唯一一处 onboarding 引导。
- PWA Service Worker 缓存应用外壳、API 不缓存，逻辑正确。

### 🟡 P1-2 · 管理端**没有任何 onboarding 引导**
第一次打开 `/admin`，看到的是一张空的周报表格 +「还没有员工」。老板不知道下一步该干什么。
**建议**：在 `t-week` 顶部加一个 4 步 checklist（① 添加员工 → ② 把邀请码发给员工 → ③ 添加终端 → ④ 把终端链接打开在安卓机上），每完成一步打个勾，数据直接从 `/api/admin/overview` 取（员工数、终端数、`employees[].registered`）。

---

## 8. Schema 升级与迁移

### 8.1 现状

`server/db.js` 的 `SCHEMA` 全部是 `CREATE TABLE IF NOT EXISTS`。**这对已存在的库是空操作 —— 加不了字段。**

**实测（在副本里改，原源码未动）**：

```
### 阶段 2：v2 —— CREATE TABLE 加了 department，代码也开始用
  观察 : 服务能起来，但第一次写库就炸：HTTP 500 → {"error":"table employees has no column named department"}
  判定 : ★致命：CREATE TABLE IF NOT EXISTS 对已存在的表是空操作，永远不会加字段。

### 阶段 4：DEFAULT_SETTINGS 里加一个新配置项
  观察 : 启动正常；settings 表里 lateGraceMinutes = [{"key":"lateGraceMinutes","value":"10"}]
  判定 : ✓ 新 key 会被 INSERT OR IGNORE 补上；同名 key 老库保留旧值（改默认值不会覆盖老库的设置 —— 对运营参数是正确行为）
```

### 8.2 好消息：并发 agent 已经加了正确的迁移机制

快照 B 的 `server/db.js` 里已经有：
```js
this.db.exec(SCHEMA);
this.migrate();          // ← 新增
...
migrate() {
  const cols = {
    terminals: [['last_seen','INTEGER'], ['pin','TEXT']],
    employees: [['note','TEXT']],
    events:   [['original_employee_id','TEXT'], ['reassigned_by','TEXT']],
  };
  for (const [table, specs] of Object.entries(cols)) {
    let existing;
    try { existing = this.db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name); } catch { continue; }
    if (!existing || !existing.length) continue;
    ... ALTER TABLE ... ADD COLUMN ...
  }
}
```

**实测老库升级（用 12:16 的原版建库 → 用快照 B 启动同一个库）**：
```
老版本写入完成：employees 列=[...9 列...]，events=3
当前版本启动成功：员工数=1（老员工还在=true），events=3
employees 列：[...9 列...] → [...9 列..., "note"]
新增列 = ["note"]
升级后还能新建员工 = true
```
✅ **升级路径现在是安全的**：老数据保留、新列自动补齐、新功能正常写入。

**建议（仍需补）**：
1. `migrate()` 目前是**硬编码的字段清单**。每加一个字段都要手改这里，容易忘。建议改成"版本号 + 迁移列表"：
   ```js
   // 在 settings 里存 schema_version
   // 启动时：if (current < 3) { applyMigrations(3); setSetting('schema_version', 3); }
   ```
2. 迁移失败要**明确报错并退出**，不要静默跳过（现在的 `catch { continue; }` 会吞掉错误）。
3. README 里写一节「升级」：`git pull && docker compose up -d --build` —— 并说明**升级前先备份**（用 §5.2 的 VACUUM INTO 脚本）。
4. 迁移是**非破坏性**的（只 ADD COLUMN），旧数据永远保留 ✅，这点做得好。

---

## 9. 需要补齐的部署产物（具体内容建议）

### 9.1 Dockerfile

**要不要多阶段？不需要。** 这个项目是**纯 CommonJS、零构建步骤**（没有 TS、没有打包器），`npm ci --omit=dev` 之后直接 `node server/index.js` 就能跑。多阶段只会增加复杂度。

**要不要用 alpine？** `node:sqlite` 的 SQLite 是**编译进 Node 二进制**的（不是 native npm 模块），所以 **alpine/musl 和 debian 一样能用**，不需要 `apk add sqlite`。本项目 3 个依赖全是纯 JS，也没有 prebuilt binary 的坑。
> ⚠️ 诚实声明：**本次评估环境没有 docker daemon，alpine 镜像我没能实际构建验证**。上面是基于「SQLite 编译在 Node 二进制里」这一事实的判断。落地时请用下面的一行冒烟命令自证：
> ```bash
> docker run --rm -v "$PWD/data:/data" -e DB_FILE=/data/presence.db presence-beacon:1.0.0 \
>   node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/tmp/t.db');d.exec('create table t(a)');console.log('node:sqlite OK on this image')"
> ```

**推荐内容（可直接照抄）**：

```dockerfile
# syntax=docker/dockerfile:1
# ── 在岗哨 Presence Beacon ────────────────────────────────────────────
# 纯 Node + SQLite，无构建步骤、无外部服务依赖
# ────────────────────────────────────────────────────────────────────
FROM node:22-alpine

# node:sqlite 在 Node 22 上还是实验特性，会往 stderr 打 ExperimentalWarning，
# 混在 docker logs 里很难看。Node 22.9+ 支持 --disable-warning。
ENV NODE_ENV=production \
    NODE_OPTIONS="--disable-warning=ExperimentalWarning" \
    PORT=8080 \
    HOST=0.0.0.0 \
    DB_FILE=/data/presence.db \
    RP_NAME="在岗哨" \
    RP_ID=localhost \
    APP_ORIGIN=""

WORKDIR /app

# 先只拷依赖清单 → 这一层能被缓存，改代码不会重装依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 再拷源码
COPY server ./server
COPY public ./public

# 数据目录：跑 node 用户（uid 1000），不要用 root
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node

EXPOSE 8080
STOPSIGNAL SIGTERM

# 健康检查：用容器内的 node 自己探，不依赖 curl（alpine 没有 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/bootstrap').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 直接用 node 当 PID 1：能收到 SIGTERM 优雅退出；
# 不要用 CMD ["npm","start"]（npm 不保证转发信号给子进程）
CMD ["node", "server/index.js"]
```

**要点说明（给写 Dockerfile 的人看）**：
- `USER node` —— 别用 root 跑。数据目录 `/data` 要 `chown node:node`，否则 volume 挂上去会 EACCES。
- `DB_FILE=/data/presence.db` —— **不要用默认的 `/app/data/presence.db`**：`/app` 是镜像层，容器重建就没了；而且升级镜像时 `/app` 被覆盖，数据会丢。
- `CMD ["node","server/index.js"]` 而不是 `npm start` —— 保证 node 是 PID 1，`docker stop` 能触发 `process.on('SIGTERM')` 优雅退出（实测退出码 0）。
- `HEALTHCHECK` 里用 `node -e` 而不是 `curl` —— alpine 镜像没有 curl。
  > ⚠️ 建议：加一个真正的 `/healthz` 端点后，把上面的 URL 换掉。**不要**把 `/api/bootstrap` 暴露到公网（它无鉴权且返回全部员工姓名）。
- 需要 `package-lock.json` 一起 COPY —— 用 `npm ci` 才能锁死版本。
- **不要**把 `data/` 拷进镜像。

### 9.2 docker-compose.yml

```yaml
# 在岗哨 Presence Beacon
# 用法：cp .env.example .env && 编辑 .env，然后 docker compose up -d
services:
  presence-beacon:
    build: .
    image: presence-beacon:1.0.0
    container_name: presence-beacon
    restart: unless-stopped
    # 只监听本机，外部访问走 Caddy/Nginx 反代（需要 HTTPS 才能用指纹，见 README）
    ports:
      - "127.0.0.1:8080:8080"
    env_file:
      - .env
    environment:
      DB_FILE: /data/presence.db
    volumes:
      # ★ 一定要挂出去！不挂 = 容器一重建，打卡记录全没
      - ./data:/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/api/bootstrap').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

**配套的 HTTPS 反代（Caddy，最省事）**：

```caddyfile
# Caddyfile —— Caddy 会自动申请并续期证书
pb.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

**配套的 Nginx（如果老板的公司只有 Nginx）**：
```nginx
server {
    listen 443 ssl;
    server_name pb.example.com;
    ssl_certificate     /etc/letsencrypt/live/pb.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pb.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_set_header   Host              $host;          # ★ 必须透传
        proxy_set_header   X-Forwarded-Proto $scheme;        # ★ 必须透传
        proxy_set_header   X-Forwarded-Host   $host;         # ★ 建议
        proxy_set_header   X-Real-IP         $remote_addr;
    }
}
```
> ⚠️ **三行 `proxy_set_header` 一行都不能少** —— 少了 `Host` / `X-Forwarded-Proto`，`APP_ORIGIN` 留空时服务会推断出错误的 origin，全员打不了卡（§4.1 实测）。

### 9.3 .env.example

```bash
# ─────────────────────────────────────────────────────────────────
# 在岗哨 Presence Beacon · 环境变量
# 用法：cp .env.example .env，然后按注释改。
# ★ 源码本身不读 .env 文件！要生效必须用下面两种方式之一：
#   1) docker compose  → compose 的 env_file 会自动读（推荐）
#   2) 直接跑 node     → node --env-file=.env server/index.js
#      （或把 package.json 的 start 改成 "node --env-file-if-exists=.env server/index.js"）
# ─────────────────────────────────────────────────────────────────

# 容器内对外端口（compose 里已经映射了 8080）
PORT=8080

# 监听地址。0.0.0.0 = 所有网卡；改成 127.0.0.1 = 只有本机（配合反代时推荐）
HOST=0.0.0.0

# SQLite 数据库路径。★ 必须是挂载出来的目录，不能放在镜像层里！
#   docker: /data/presence.db（配合 volume ./data:/data）
#   裸机:   ./data/presence.db
DB_FILE=/data/presence.db

# WebAuthn 的 RP 名称 —— 显示在手机系统弹窗里
RP_NAME=在岗哨

# ★★★ RP_ID：WebAuthn 的"依赖方 ID"，必须是【裸主机名】★★★
#   对  ：pb.example.com
#   错  ：https://pb.example.com   （带协议 → 全员打不了卡）
#   错  ：pb.example.com:8443      （带端口 → 全员打不了卡）
#   错  ：localhost                （部署到域名后忘了改 → 全员打不了卡）
# 规则：必须是员工实际访问的域名的后缀。用域名部署就填域名。
RP_ID=pb.example.com

# ★★★ APP_ORIGIN：必须和员工浏览器地址栏【一字不差】★★★
#   对  ：https://pb.example.com
#   错  ：https://pb.example.com/   （末尾斜杠 → 全员打不了卡）
#   错  ：http://pb.example.com     （协议错 → 全员打不了卡）
#   错  ：https://pb.example.com:8443（端口要写，且要和实际一致）
# 留空 = 服务端按请求头自动推断（要求反代透传 Host 和 X-Forwarded-Proto）
APP_ORIGIN=https://pb.example.com

# 管理员口令。★ 留空 = 首次启动自动随机生成并打印在日志里。
#   想自己指定就填一个 ≥12 位、别人猜不到的。
#   ★ 注意：这个值只"临时覆盖"，不会写进数据库；
#     一旦撤掉这个变量，旧的数据库口令会立刻复活。两个口令别搞混。
ADMIN_PASSWORD=

# 时区偏移（分钟）。中国 = 480。改成别的时区才需要动。
TZ_OFFSET_MINUTES=480
```

**几点说明**：
- `TZ_OFFSET_MINUTES` 现在**确实生效**了（快照 B 已修）。它会写进 `settings` 表，**优先级高于管理端"规则"页里的设置** → 改了环境变量以后，管理端再改时区也会被启动时的 env 覆盖 → README 里要说一句。
- `ADMIN_PASSWORD=` 留空 → 随机生成，打印在 `docker compose logs presence-beacon` 里。
- 建议再加一个 `PUBLIC_URL=`（可选）→ 只用来让启动横幅打印正确的访问地址，代码里加 3 行即可。

### 9.4 README.md 应该有哪些章节

给一个**不懂命令行**的小老板看，README 必须按"他今天要做的事"来组织，而不是按代码结构组织。建议目录：

```markdown
# 在岗哨 Presence Beacon

> 把一台吃灰的安卓手机，变成办公室的每周在岗打卡机。
> 纯 Web + Node + SQLite，不依赖任何外部服务，数据全在自己机器上。

## 这是什么 / 不是什么
（3 行以内。说明：员工用手机扫码+指纹打卡；管理员用电脑看周报；
  不做考勤打卡机、不接企业微信/钉钉、不需要公网数据库）

## 你需要准备什么
| 要什么 | 说明 | 最低要求 |
|---|---|---|
| 一台服务器 | 办公室内网小主机 / 云主机都行 | 1 核 512M，Linux |
| 一个域名 | 员工手机要能打开 | 例：pb.你的公司.com |
| HTTPS 证书 | **没有它指纹功能用不了**（见下） | Caddy 可自动申请 |
| Node（只在不用 Docker 时要） | | ≥ 22.13（见"版本要求"） |

## ⚠️ 先读这一条：指纹功能必须 HTTPS
浏览器只在「安全上下文」里允许指纹/面容。
`http://192.168.1.50:8080` 打开 → 指纹功能**不可用**，只能退化成 6 位员工码。
所以必须配域名 + HTTPS（Caddy 三行配置，见"部署"）。

## 三分钟跑起来（推荐：Docker）
### 1. 装 Docker
### 2. 拉代码
git clone <仓库地址> presence-beacon && cd presence-beacon
### 3. 配环境变量
cp .env.example .env
nano .env      # 至少改 RP_ID 和 APP_ORIGIN
### 4. 启动
docker compose up -d
docker compose logs -f presence-beacon
# 日志里会打印管理员口令，例如：
#   │  管理员口令   tzQwSbfoGHyi
### 5. 打开管理端
https://pb.example.com/admin     ← 用这个口令登录

## 三分钟跑起来（不用 Docker：裸机 + Node）
### 版本要求
Node **≥ 22.13**。22.5–22.12 的 node:sqlite 还在实验标志后面，会启动失败：
`Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite`
检查：node -v
### 安装
npm ci
### 启动
npm start
# 想用 .env：node --env-file=.env server/index.js

## 拿到管理员口令
- 第一次启动会随机生成一个，打印在日志里
- 找回来：docker compose logs presence-beacon | grep 管理员口令
- 或者直接看 data/admin-password.txt（如果加了写文件的功能）
- 忘了也没关系：设 ADMIN_PASSWORD 重启即可

## 第一次要做这 4 件事（管理端）
① 添加员工   → 每人得到一个【邀请码】(6 位数字) 和【员工码】(兜底用)
② 把邀请码发给员工，让他在这台手机上输入 → 完成指纹登记
③ 添加终端   → 拿到【终端链接】
④ 把终端链接在旧安卓机上打开 → 屏幕上出现二维码
   ⚠ 终端链接只在"新建终端那一次"完整显示（当前版本 bug，见下方"已知问题"），
      记不下来就再新建一个终端

## 让员工每天怎么用
（配图两张：员工端首页 + 终端大屏）
1. 上班：手机打开员工端 → 扫终端二维码 → 按指纹 → 提示"已签进"
2. 下班：再扫一次 → 提示"已签退"
3. 没带手机：用 6 位员工码（管理端会看到"弱验证"标记）

## 备份（★ 重要，方式不对会丢数据）
- 正确：./scripts/backup.sh backup/presence-2026-11-23.db
- ❌ 错误：只 cp data/presence.db（会丢掉还没落盘的打卡记录）
- 恢复：停服务 → 删掉 data/presence.db* → 把备份拷回 data/presence.db → 起服务

## 环境变量对照表
（把 .env.example 的内容做成表格）

## 升级
git pull && docker compose up -d --build
（升级前先备份；schema 会自动迁移，老数据不会丢）

## 常见问题 FAQ
- 指纹按了没反应 / 提示"不支持指纹验证" → 不是 HTTPS，或者浏览器不是 Chrome
- 提示 "The relying party ID is not..." → RP_ID 配错了，见上文对照表
- 页面打得开但所有人都打不了卡 → RP_ID / APP_ORIGIN 不匹配
- 提示端口被占用 → PORT 换个数字
- 忘了管理员口令 → 设 ADMIN_PASSWORD 重启
- Android 上"添加到主屏幕"后白屏 → 试试清一下缓存
- 员工说扫不出二维码 → 手动输入终端上那 8 位码

## 开发者
npm test / npm run dev / 目录结构 / API 列表
```

**写法要求**：
- **每一步都给"完整可复制的命令"**，不要写 "配置环境变量" 这种没有具体内容的句子。
- **每张截图配一句话说明**。
- 把"必须 HTTPS""RP_ID 只能写裸域名""备份不能只拷 .db"这三条**加粗 + 单独成节**，它们是 90% 的翻车点。
- 所有命令默认 `docker compose`（新手最常见的路径），裸机 Node 作为备选。

### 9.5 .gitignore

> **交付前复核（12:36）**：`.gitignore` 已由并发 agent 在 12:15 创建，当前内容为
> `node_modules/ data/ *.log .env .env.local .DS_Store test-reports/shots/ test-reports/cleanroom/`。
> **最关键的 `data/` 已被排除 ✓**。仍建议补齐 `*.db` / `*.db-wal` / `admin-password.txt` / `backups/` /
> `playwright-report/` / `test-results/` / `.vscode/` / `.idea/` —— 否则把库文件改名成
> `attendance.db` 放在仓库根目录就会被提交。建议内容：

```gitignore
# 依赖
node_modules/

# ★ 数据库：绝不能提交（含明文管理员口令、员工 PIN、终端 secret）
data/
*.db
*.db-wal
*.db-shm
admin-password.txt

# 备份
backups/
*.backup
*.bak

# 环境变量（.env.example 要提交，.env 不能）
.env
.env.local
.env.*.local

# 测试产物
test-reports/
playwright-report/
test-results/
coverage/
*.log
npm-debug.log*

# 编辑器 / 系统
.DS_Store
Thumbs.db
.idea/
.vscode/
*.swp
```

> ⚠️ **当前仓库没有 `.gitignore`，而 `data/presence.db`（含明文管理员口令 `test123`、员工 PIN、终端 secret）就在工作区里。** 这是最优先要补的。

### 9.6 .dockerignore

```
# 依赖（镜像里用 npm ci 重装）
node_modules/

# ★ 数据：绝对不能进镜像，否则镜像里带一份旧数据 + 明文口令
data/
backups/
*.db
*.db-wal
*.db-shm
admin-password.txt

# 环境变量
.env
.env.local

# 版本控制 / CI
.git
.gitignore
.github/
.gitlab-ci.yml

# 测试与文档
test/
test-reports/
coverage/
playwright-report/
test-results/

# 开发杂项
.vscode/
.idea/
*.log
npm-debug.log*
Dockerfile
docker-compose.yml
.dockerignore
README.md
*.md
```

> ⚠️ `.dockerignore` 里 `*.md` 排除 README 是可选项（README 不进镜像没关系，体积也就几十 KB）；但 **`data/` 和 `.env` 必须排除**，这是底线。

### 9.7 其他建议

- **`scripts/backup.sh` + `scripts/restore.sh`**（见 §5.2）—— 让老板不用碰命令行。
- **管理端加一个"下载备份"按钮** —— `GET /api/admin/backup` 返回 `VACUUM INTO` 的临时文件，浏览器直接下载。3-5 人团队最实用的备份方式。
- **`package.json` 改两处**：
  ```json
  "scripts": {
    "start": "node --env-file-if-exists=.env server/index.js",
    "test": "node --test test/*.test.js"
  },
  "engines": { "node": ">=22.13.0" }
  ```
  （`>=22.13.0` 是**必须改的**：现在写的 `>=22.5.0` 低于 `node:sqlite` 去掉实验标志的版本，在 22.5–22.12 上会直接启动失败。）
- **删掉 `jsqr` 依赖**（浏览器用的是 vendored 版）。
- 加一个 `GET /healthz`。

> ⚠️ **12:15 时并发 agent 已补上 `.gitignore`（含 `data/`、`node_modules/`、`.env`）✓。**
> 但 `.dockerignore` 仍然缺失 —— 那才是会把 `data/presence.db`（含明文口令）打进镜像的那一道门。

---

## 10. 交付前最后一次复核（12:36，当前源码）

并发 agent 在评估期间又改了 `server/index.js`（12:36）和 `public/employee.js`（12:34）。
为保证结论对得上当前代码，交付前逐条复核了一遍：

| 检查项 | 12:36 状态 | 结论 |
|---|---|---|
| 健康检查端点 | `grep -c "healthz\|'/health'"` → **0** | ❌ 仍然没有 |
| `APP_ORIGIN` 校验路径 | `index.js:439` / `:487` 仍传**原始** `APP_ORIGIN`；`webauthn.js:31 _expectedOrigin()` 仍是死代码 | ❌ 尾斜杠 / 多 origin 仍失败（§4.3） |
| `admin.js:183` 终端链接 | 仍是 `key=${t.key \|\| ''}` | ❌ 仍给空密钥（§7 P0-4） |
| `admin.js:16` 双重转义 | 仍是 `esc(text)` 包整段 | ❌ 仍显示字面 `<strong>`（§7 P1-1） |
| `PRAGMA busy_timeout` | `grep -c` → **0** | ❌ 仍无（§5.3） |
| `engines.node` | 仍是 `">=22.5.0"` | ❌ 仍低于真实下限 22.13（§3.1） |
| `.gitignore` | 12:15 已创建，**已含 `data/`** | ✓ 已修 |
| `.dockerignore` | 不存在 | ❌ 仍缺 |
| `README.md` | 不存在 | ❌ 仍缺 |
| `.env.example` | 不存在 | ❌ 仍缺 |
| `Dockerfile` / `docker-compose.yml` | 不存在 | ❌ 仍缺 |

**结论不变**：业务链路能跑，但**部署产物一套都没有**，且 §1 的 3 个 P0 全部仍然存在。

---

## 11. 部署前必须做的 5 件事（Checklist）

> 按顺序做。每一条都对应本报告里一个已实测的问题。

### ✅ 1. 配好域名 + HTTPS，并确认手机能打开
- [ ] 有域名（如 `pb.example.com`），安卓机浏览器能打开 `https://pb.example.com`
- [ ] **用安卓机实测**：打开 → 员工端 → 点"登记指纹" → 出现系统指纹/面容弹窗（不是"这个浏览器不支持指纹验证"）
- [ ] 反代透传 `Host` + `X-Forwarded-Proto`（见 §9.2）
- 依据：§1 P0-1（http 下 `isSecureContext=false`，指纹功能直接没有）

### ✅ 2. 把 RP_ID / APP_ORIGIN 配对，并做一次真机打卡
- [ ] `RP_ID=pb.example.com`（**裸域名，无协议无端口无路径**）
- [ ] `APP_ORIGIN=https://pb.example.com`（**和地址栏一字不差，末尾不加 `/`**）
- [ ] 启动后用**真实手机**完整走一遍：登记指纹 → 扫码 → 打卡成功
- [ ] 把这条写进 README（§9.4）
- 依据：§1 P0-2（6 种错法，错误提示全是英文 + HTTP 500）

### ✅ 3. 修掉「终端链接拿不回来」+ 管理端 HTML 字面量
- [ ] `/api/admin/overview` 的 terminal 列表返回 `secret`，`admin.js:183` 改用 `t.secret`
- [ ] 或加「重新生成终端链接」按钮
- [ ] `msg()` 不要再无脑 `esc()`（否则邀请码显示成 `<strong>780641</strong>`）
- 依据：§7 P0-4（终端链接只有创建那一瞬间能看到）、§7 P1-1

### ✅ 4. 写好 README / .env.example / Dockerfile / compose / .dockerignore
- [ ] README 按 §9.4 的目录写，每步给可复制命令
- [ ] `.env.example` 按 §9.3 写（重点：RP_ID / APP_ORIGIN 的对错示例）
- [ ] Dockerfile 按 §9.1（`USER node`、`DB_FILE=/data/presence.db`、volume、node 当 PID 1）
- [ ] `.gitignore` 已由并发 agent 补上 `data/` ✓，再补 `*.db` / `admin-password.txt` / `backups/`
- [ ] `.dockerignore` **必须含 `data/` 和 `.env`**（目前完全没有）
- 依据：§1 P0-3、§9 全部

### ✅ 5. 验证备份/恢复 + 加健康检查 + 锁死 Node 版本
- [ ] 用 `VACUUM INTO` 做一次备份，**删库 → 恢复 → 确认打卡记录还在**
- [ ] 在 README 里明确写「❌ 不能只 cp presence.db」
- [ ] 加 `GET /healthz`，compose 里配 HEALTHCHECK
- [ ] `package.json` 的 `engines.node` 改成 `>=22.13.0`；Dockerfile 钉 `node:22-alpine`
- [ ] `PRAGMA busy_timeout = 5000;`（多进程共用卷时不报 "database is locked"）
- 依据：§5.2、§5.3、§6、§3.1

---


> 按顺序做。每一条都对应本报告里一个已实测的问题。

### ✅ 1. 配好域名 + HTTPS，并确认手机能打开
- [ ] 有域名（如 `pb.example.com`），安卓机浏览器能打开 `https://pb.example.com`
- [ ] **用安卓机实测**：打开 → 员工端 → 点"登记指纹" → 出现系统指纹/面容弹窗（不是"这个浏览器不支持指纹验证"）
- [ ] 反代透传 `Host` + `X-Forwarded-Proto`（见 §9.2）
- 依据：§1 P0-1（http 下 `isSecureContext=false`，指纹功能直接没有）

### ✅ 2. 把 RP_ID / APP_ORIGIN 配对，并做一次真机打卡
- [ ] `RP_ID=pb.example.com`（**裸域名，无协议无端口无路径**）
- [ ] `APP_ORIGIN=https://pb.example.com`（**和地址栏一字不差，末尾不加 `/`**）
- [ ] 启动后用**真实手机**完整走一遍：登记指纹 → 扫码 → 打卡成功
- [ ] 把这条写进 README（§9.4）
- 依据：§1 P0-2（6 种错法，错误提示全是英文 + HTTP 500）

### ✅ 3. 修掉「终端链接拿不回来」+ 管理端 HTML 字面量
- [ ] `/api/admin/overview` 的 terminal 列表返回 `secret`，`admin.js:183` 改用 `t.secret`
- [ ] 或加「重新生成终端链接」按钮
- [ ] `msg()` 不要再无脑 `esc()`（否则邀请码显示成 `<strong>780641</strong>`）
- 依据：§7 P0-4（终端链接只有创建那一瞬间能看到）、§7 P1-1

### ✅ 4. 写好 README / .env.example / Dockerfile / compose / .gitignore / .dockerignore
- [ ] README 按 §9.4 的目录写，每步给可复制命令
- [ ] `.env.example` 按 §9.3 写（重点：RP_ID / APP_ORIGIN 的对错示例）
- [ ] Dockerfile 按 §9.1（`USER node`、`DB_FILE=/data/presence.db`、volume、node 当 PID 1）
- [ ] `.gitignore` **必须含 `data/`**（现在仓库里有含明文口令的 `data/presence.db`）
- [ ] `.dockerignore` **必须含 `data/` 和 `.env`**
- 依据：§1 P0-3、§9 全部

### ✅ 5. 验证备份/恢复 + 加健康检查 + 锁死 Node 版本
- [ ] 用 `VACUUM INTO` 做一次备份，**删库 → 恢复 → 确认打卡记录还在**
- [ ] 在 README 里明确写「❌ 不能只 cp presence.db」
- [ ] 加 `GET /healthz`，compose 里配 HEALTHCHECK
- [ ] `package.json` 的 `engines.node` 改成 `>=22.13.0`；Dockerfile 钉 `node:22-alpine`
- [ ] `PRAGMA busy_timeout = 5000;`（多进程共用卷时不报 "database is locked"）
- 依据：§5.2、§5.3、§6、§3.1

---

## 12. 附录：测试脚本与产物清单

| 文件 | 作用 | 对应输出 |
|---|---|---|
| `test-reports/cleanroom/` | 12:16 的原始源码快照（模拟全新 clone） | — |
| `test-reports/container-sim/` | 只装生产依赖的副本（模拟 Docker 镜像） | — |
| `test-reports/d-env-matrix.js` | 8 个环境变量逐个验证 | `out-env-matrix-current.txt` |
| `test-reports/d-zerostate.js` | Playwright 零状态 → 能打卡（24/25） | `out-zerostate.txt` + `shots/d01~d11*.png` |
| `test-reports/d-webauthn-https.js` | 自签证书 + https 反代 + 虚拟认证器，9 种 origin/RP_ID 组合 | `out-webauthn-https.txt` |
| `test-reports/d-persist.js` | 备份/恢复/权限/并发/kill -9/健康检查/端口冲突 | `out-persist.txt` |
| `test-reports/d-runtime.js` | SIGTERM/SIGINT、畸形输入、目录穿越 | `out-runtime.txt` |
| `test-reports/d-upgrade.js` | 老库 → 新版本升级 + 安全上下文对比 | `out-upgrade.txt` |
| `test-reports/d-migrate.js` | schema 加字段的三种写法 | `out-migrate.txt` |
| `test-reports/cleanup-test-ports.sh` | 只清理 8123/8124/8125 的残留进程，**永不碰 8099** | — |
| `test-reports/lab/` | 所有中间产物（DB、证书、日志、JSON 结果） | — |

**复跑方式**：
```bash
cd /workspace/presence-beacon
bash test-reports/cleanup-test-ports.sh
node test-reports/d-zerostate.js          # 需要 Playwright + chromium
node test-reports/d-persist.js
node test-reports/d-upgrade.js
```

**本次评估未触碰**：`server/`、`public/` 下的源文件（只读 + 在副本里改）；8099 端口上的服务（全程未 kill、未重启、未改其 `data/`）。
