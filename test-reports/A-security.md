# 在岗哨（Presence Beacon）安全与权限审查报告

- **审查范围**：`/workspace/presence-beacon/`（server/ + public/），运行实例 `http://localhost:8099`（PID 3425）
- **审查方式**：只读代码审查 + 真实 HTTP 请求 / Playwright（CDP 虚拟 WebAuthn 认证器）+ 只读 SQLite 查询。**未修改任何源码**，未 kill / 重启服务进程，未删除 `data/`。
- **测试数据**：全部使用 `安全测试*` / `DBG*` / `限流测试员` 前缀，审查结束已删除（2 台终端因无删除接口保留，见 S-07）
- **证据文件**：本目录 `out-t1.txt` … `out-t10.txt` 及 `t*.js` 脚本
- **环境**：`RP_ID=localhost`，`PORT=8099`，`ADMIN_PASSWORD` 由环境变量注入（`/proc/3425/environ` 确认 `HOST` 未设置 → 默认 `0.0.0.0`）

---

## 〇、版本口径说明（务必先读）

审查期间（12:27 / 12:28 / 12:29）**另一个 agent 正在并行修改 `server/index.js`、`server/db.js`、`server/rules.js`**。因此存在两个版本：

| 版本 | 内容 | 状态 |
|---|---|---|
| **A：运行中实例（12:12 构建）** | 没有任何限流 | **正在对外提供服务，是本次黑盒测试的对象** |
| **B：磁盘源码（12:29 构建）** | 新增了限流、终端停用、软删除、错误文案统一、终端事件流隔离等 | **未重启，服务仍在跑 A 版** |

> **行号快照**：本报告所有 `server/index.js` 行号对应 `test-reports/snapshot-server-index.js`
> （mtime `2026-11-23 12:32:39`，sha256 `d1901bf091326c6b63eeff270233bd38ee4214b660f671b3f2512950cdfeea47`，837 行）；
> `server/db.js` 对应 `test-reports/snapshot-server-db.js`（sha256 `cd7d4a4bb5627d5736219827674e7126bdcf15455fc51fe30696f22c624035af`，361 行）。
> 由于源码在审查期间被并行修改，**若磁盘版本已更新，请以上述快照为准核对行号**；每条结论都同时给出了可 grep 的代码锚点（如 `p === '/api/checkin/pin'`）。

本报告的所有黑盒证据（请求/响应）都来自 **A 版（运行中实例）**；行号引用 **B 版（磁盘当前源码）**。对每条结论额外标注：

- **【A+B】** = 两个版本都存在
- **【仅 A】** = 只在运行中的实例存在（磁盘源码已修，但**没重启 = 线上仍然暴露**）
- **【仅 B】** = 只在磁盘源码里存在（12:29 新引入的问题）

---

## 一、结论表

### 高危（3 条）

| # | 问题 | 严重级 | 版本 | 复现步骤 | 证据（实际请求/响应） | 建议修法 |
|---|---|---|---|---|---|---|
| **S-01** | **员工码（PIN）6 位纯数字、无速率限制、无失败锁定 → 可爆破并伪造他人考勤** | **高** | 【仅 A】（B 版有限流但被 S-03 绕过） | 1. 管理员建员工，拿到 6 位员工码<br>2. 攻击者对 `POST /api/checkin/pin` 并发穷举 `100000..999999`<br>3. 命中即以该员工身份打卡落库 | `server/index.js:528-571`（`:534` 比对、`:696` 生成）、`server/db.js:21`（`pin TEXT` 明文列）<br><br>**A 版实测**：<br>`找到正确 PIN=100999，尝试 1000 次，用时 5721ms（175 req/s）`<br>`按此速率，爆破完整 900,000 种 PIN 约需 86 分钟`<br>`连续失败 500 次后再用正确 PIN → HTTP 200 {"ok":true,"kind":"out",...}`<br>`第 1 次失败 6ms，第 2 次失败 5ms`（无退避/无延时）<br><br>**B 版实测（隔离实例 :8097，伪造 XFF）**：<br>`结果: 命中 PIN=555555，HTTP 200 {"ok":true,"kind":"in",...}`<br>→ **限流补丁同样被绕过，爆破照旧成功** | ① `clientIp()` 改为只信 `req.socket.remoteAddress`（或只信白名单反代写入的 header，见 S-03）；② 限流键改为**按 employeeId 维度**（不绑 IP），或 IP + employeeId 双维度；③ 员工码扩到 8 位以上随机字符并**哈希存储**；④ 管理端 UI 单独标注弱验证打卡。 |
| **S-02** | **邀请码 6 位纯数字、无速率限制 → 猜中即可注册并接管该员工账号（端到端已验证）** | **高** | 【仅 A】（B 版有限流但被 S-03 绕过） | 1. 管理员建员工（未登记指纹）<br>2. 攻击者并发穷举 `POST /api/auth/register-options` 的 `inviteCode`<br>3. 命中后走完注册流程 → 拿到 `deviceToken` | `server/index.js:417-431`（`:420` 限流、`:423-426` 比对+统一文案）、`:433-448`（注册→下发 deviceToken `:445-447`）、`:695`/`:722` 生成 6 位<br><br>**A 版实测**：<br>`猜中邀请码 834438（真值 834438），共尝试 8001 次 / 45343ms ≈ 176 次/秒`<br>`按此速率，扫完完整 900,000 空间约需 85 分钟`<br><br>**接管成功**：<br>`攻击者拿到的 deviceToken = H6wAbM4mSXclYlEuEhegTf2Xzq2Lz3QE`<br>`用它读受害者周状态 → HTTP 200 {"employee":{"id":"9e6c8cee-...","name":"安全测试受害者235318"...}`<br>`用它替受害者提交例外申请 → HTTP 200` | ① 同 S-01 的 IP 信任问题；② 邀请码改 12 位随机字符（不要纯数字）；③ 邀请码一次性 + 短有效期；④ 注册成功即绑定「首次登记的设备」，并把 `deviceToken` 与 WebAuthn 凭据绑定（同一凭据才能用该 token）；⑤ B 版已统一错误文案（`server/index.js:423-426`）✔ |
| **S-03** | **限流实现无条件信任客户端可伪造的 `X-Forwarded-For` → 一行 header 即绕过全部限流** | **高** | 【仅 B】（12:29 新引入） | 1. 对 `POST /api/checkin/pin` 连续发错误员工码<br>2. 每次附带不同的 `X-Forwarded-For` | `server/index.js:73-76`（`clientIp()` 无条件取 `x-forwarded-for` 首段，**没有可信代理配置、没有校验**）、`:420`（邀请码限流键）、`:532`（员工码限流键）——两者都含 `clientIp(req)`<br><br>**B 版实测（隔离实例 :8097）**：<br>`30 次伪造 XFF 的结果分布: {"403":30}`（0 次 429）<br>`结果: 命中 PIN=555555，HTTP 200`（真的爆破成功）<br><br>对照（不带 XFF）：<br>`1:403 2:403 3:403 4:403 5:403 6:403 7:403 8:403 9:429 10:429 11:429 12:429`（补丁本身有效） | ① `clientIp()` 只用 `req.socket.remoteAddress`；② 若要支持反代，用 `app.set('trust proxy', ...)` 语义的白名单，只信可信反代注入的 header，并把反代 header 换成不可伪造的名字（如 `X-Real-IP` 由 nginx `proxy_set_header` 覆盖）；③ 限流键加 employeeId 维度，即使 IP 可伪造也挡得住针对单个员工码的爆破；④ 补一条自动化用例：**带伪造 XFF 也必须被限流**。 |

### 中危（6 条）

| # | 问题 | 严重级 | 版本 | 复现步骤 | 证据 | 建议修法 |
|---|---|---|---|---|---|---|
| **S-04** | **管理员口令在服务启动时明文打印到 stdout → 进 journal / docker logs / CI 日志** | 中 | 【A+B】 | 启动服务后看 stdout | `server/index.js:830` `console.log(\`│  管理员口令 ${ADMIN_SECRET}\`);`<br><br>**实测**（`/proc/3425/fd/1` 指向的 job 输出文件第 9 行）：<br>`│  管理员口令 test123`<br><br>同一份日志里还有完整异常栈（`server/index.js:817`） | 改为「首次启动打印一次 + 强制改密」；或只打印「口令已写入 `<path>`」；生产加 `NODE_ENV` 守卫；日志文件 0600 + 轮转。 |
| **S-05** | **管理员口令 / 员工码 / 终端密钥全部明文落 SQLite** | 中 | 【A+B】 | 只读打开 `data/presence.db` 查 `settings` / `employees` / `terminals` | `server/index.js:46-50`（未设 `ADMIN_PASSWORD` 时写库）、`:696`（员工码）、`:722`（重置邀请码）；`server/db.js:21`（`pin TEXT`）、`:65`（`secret TEXT`）、`:159`（`setSetting`）<br><br>**实测**（隔离实例 `/tmp/pb-audit/presence.db`）：<br>`settings 表里 adminPassword = {"key":"adminPassword","value":"YHEq56-1Z2NK"}`（与启动打印的 `管理员口令 YHEq56-1Z2NK` 一致）<br><br>**生产库实测**：<br>`employees 行样本: [{"id":"f1ef22b6-...","name":"安全测试A235318","invite_code":"349737","pin":"100001","device_token_hash":"db11564c8493e35a..."}]`<br>`terminals.secret 明文: [{"id":"24ce6789-...","secret":"16d153193a7a4545020906ea96c4367a"}]` | 管理员口令改存 `scrypt`/`argon2` 哈希（比对用 `timingSafeEqual` 哈希值）；员工码、终端密钥同样哈希；DB 文件 0600，明确「拿到 DB = 拿到全部权限」的边界。 |
| **S-06** | **已停用（`active=0`）员工仍可用员工码打卡（管理端没有停用入口，但 API 支持）** | 中 | 【A+B】 | 1. `PATCH /api/admin/employees/:id {active:false}`<br>2. 用该员工的员工码调 `POST /api/checkin/pin` | `server/index.js:530`（`getEmployee` 不过滤 active，`:531` 直接按 id 取人）、`server/db.js:175`；<br><br>**A 版实测**：`bootstrap 里还有他吗: false` / `用 PIN 打卡 → HTTP 200 {"ok":true,"kind":"in",...}`<br>**B 版实测**：`active=0 的员工用员工码打卡 → 200 {"ok":true,"kind":"in",...}`<br><br>（注：B 版的 `DELETE` 已改为软删除并清空 pin，`删除后用员工码打卡 → 403 {"error":"员工码不正确"}` ✔；但 `active=0` 这条路径仍漏） | `store.getEmployee()` 增加 `active=1` 过滤（或新增 `getActiveEmployee`）并应用到全部打卡/例外/查询路径；停用时同时吊销 `device_token_hash`。 |
| **S-07** | **终端密钥以 URL query 传递 + 创建后取不回 + 无吊销/删除接口 + 比较非常量时间** | 中 | 【A+B】 | 1. 打开 `/terminal.html?tid=…&key=…`<br>2. 管理端点「查看终端链接」 | `public/terminal.js:9-10`、`public/admin.js:183`、`:194`；`server/index.js:617-618`（`!==` 比较）、`:682`（overview 不返回 secret）、`:739-744`（只有创建时返回 secret）；`server/db.js:303`（`updateTerminal` 白名单里没有 secret）<br><br>**实测（管理端弹窗）**：<br>`alert 内容: "…http://localhost:8099/terminal.html?tid=24ce6789-4c42-4a96-b6b1-91d2c134b7a3&key="`<br>`链接里的 key = ''   真实 secret = 16d153193a7a4545020906ea96c4367a` → **`key=` 永远是空的**<br><br>**URL 泄露面**：<br>`终端页自身的 Referer/URL 里是否含 key: true`（当前无外链，但密钥落在浏览器历史 / 地址栏 / 肩窥 / 截图 / 浏览器同步）<br><br>**管理端无终端删除接口** → 审查结束后 2 台测试终端只能留在库里（实测 `终端无删除接口，保留: 安全测试终端1235318`） | ① 终端页首次访问用一次性激活码换长期凭据（HttpOnly + SameSite=Strict cookie），密钥不再进 URL；② 增加 `GET /api/admin/terminals/:id/secret` 或 `POST .../reset-secret`（重置即吊销）；③ 增加 `DELETE /api/admin/terminals/:id` 与 `active` 生效校验（B 版已让 `active` 生效：`server/index.js:618` `终端已停用` ✔）；④ 密钥比较改 `crypto.timingSafeEqual`。 |
| **S-08** | **CSV 导出未做公式注入转义（`=`/`+`/`-`/`@` 开头被 Excel 当公式执行）** | 中 | 【A+B】 | 1. 建员工 `name="=1+1"`、`seat="+cmd\|' /C calc'!A0"`<br>2. `GET /api/admin/export.csv` | `server/index.js:258-261`（`csvEscape` 只处理 `,` `"` `\n`）、`:656-678`<br><br>**实测 CSV 行**：<br>`"=1+1,+cmd\|' /C calc'!A0,0.00,24.00,24.00,未达标,0.00,0,0"`（未加引号、未前缀 `'`）<br><br>对照：常规 CSV 转义正确：`"\"引号\"\"逗号,换行\n测试",S,0.00,...` | `csvEscape` 对以 `= + - @ \t \r` 开头的值前置 `'`（或 tab）；`name`/`seat` 长度与控制字符一并清洗。 |
| **S-09** | **`POST /api/admin/login` 无任何限流 / 锁定** | 中 | 【A+B】 | 连续发错误管理员口令 | `server/index.js:648-655`（路由内**没有** `attemptAllowed` 调用）<br><br>**A 版实测**：`6 次错误口令尝试耗时 8ms（无延迟、无锁定、无失败计数）`；`10 次口令尝试耗时 73ms`<br>**B 版实测（隔离实例）**：`30 次错误管理员口令: {"403":30}` → **0 次 429**<br><br>叠加部署事实：当前口令是 `test123`，且**明文写在日志里**（S-04）→ 局域网内拿到日志即完成接管 | 复用 `attemptAllowed`（`admin:${ip}`，5 次失败锁 15 分钟）；口令改 12 位以上随机；登录成功/失败都写审计日志；支持改密与强制过期。 |

### 低危（10 条）

| # | 问题 | 严重级 | 版本 | 证据 | 建议 |
|---|---|---|---|---|---|
| **S-10** | `/api/bootstrap` 无鉴权暴露全员名单 + `registered` + `hasPin` + 全部终端 id/名称/位置；服务默认绑定 `0.0.0.0` | 低 | 【A+B】 | `server/index.js:400-414`、`:19`<br>实测：`HTTP 200 无任何 token / cookie`<br>`employees[0] = {"id":"f1ef22b6-…","name":"安全测试A235318","seat":"A区-01","targetMinutes":1440,"registered":true,"hasPin":true}`<br>`terminals = [{"id":"24ce6789-…","name":"安全测试终端1235318","location":"1楼"}]`（`/proc/3425/environ` 确认 `HOST` 未设置）<br><br>**3–5 人内部工具的可接受性判断**：单纯暴露花名册（姓名/工位在办公室里本就公开）可接受为低危；但 ① `registered` 泄露谁还没配指纹、② `hasPin` 泄露兜底通道存在、③ 监听全网卡使同网段任意设备可读 —— 三者叠加偏不合算 | `HOST` 默认改 `127.0.0.1`（需局域网访问时显式配）；bootstrap 只返回 `id + name`；去掉 `hasPin`（恒真噪声）；或加共享密钥 / 限流。 |
| **S-11** | 内部异常信息原样回显客户端；预期失败一律返回 **500** | 低 | 【A+B】 | `server/index.js:816-819`（`fail(res, 500, err.message)`）<br><br>实测：<br>`非法 JSON → HTTP 500 {"error":"Provided value cannot be bound to SQLite parameter 1."}`<br>`null body → HTTP 500 {"error":"Cannot read properties of null (reading 'employeeId')"}`<br>`PATCH targetMinutes='abc' → HTTP 500 {"error":"NOT NULL constraint failed: employees.target_minutes"}`<br><br>所有 WebAuthn 校验失败（重放/过期/跨员工）也是 500：<br>`重放同一 assertion → HTTP 500 {"error":"认证挑战无效或已过期"}`<br>`旧 assertion + 新 challengeId → HTTP 500 {"error":"Unexpected authentication response challenge \"…\", expected \"…\""}`<br>`D 的 assertion 用于 E → HTTP 500 {"error":"凭据不匹配"}` | 业务校验失败返回 4xx；500 只回 `{"error":"服务器内部错误"}` + 关联 ID，堆栈只进日志。 |
| **S-12** | 员工存在性枚举预言机（`/api/checkin/pin` 通道仍可枚举） | 低 | 【A+B】（B 版已修 register-options 通道） | `server/index.js:531`（404 员工不存在）vs `:534-537`（403 员工码不正确）<br><br>**B 版实测**：<br>`register-options 不存在的员工 → 403 {"error":"员工或邀请码不正确"}` ✔ 已统一<br>`register-options 存在的员工 → 403 {"error":"员工或邀请码不正确"}` ✔<br>`pin 不存在的员工 → 404 {"error":"员工不存在"}` ✘ 仍可枚举<br>`pin 存在的员工 → 403 {"error":"员工码不正确"}` | `/api/checkin/pin` 也统一文案为「员工或员工码不正确」。 |
| **S-13** | 缺安全响应头 → 点击劫持 / 终端页可被 iframe 嵌套 | 低 | 【A+B】 | `server/index.js:108-116`、`:151-157`<br>实测：`content-security-policy = (缺失)`、`x-frame-options = (缺失)`、`x-content-type-options = (缺失)`、`referrer-policy = (缺失)`、`strict-transport-security = (缺失)`、`permissions-policy = (缺失)`<br>`iframe 嵌入结果: {"w":"cross-origin-not-checked","h":304}` | `send()` 统一加 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Content-Security-Policy: default-src 'self'`。 |
| **S-14** | 请求体大小无限制（`readBody` 全量入内存） | 低 | 【A+B】 | `server/index.js:121-127`（无上限、无 Content-Length 检查）<br>实测：`20MB 请求体 → HTTP 500 {"error":"Provided value cannot be bound to SQLite parameter 1."} 用时 142ms`（整个 body 先读进内存） | 累计字节 > 256KB 直接 413；或按 `Content-Length` 先拒。 |
| **S-15** | 管理端 `PATCH /api/admin/settings` 无参数校验 → 单个脏值污染全公司周目标 | 低 | 【A+B】 | `server/index.js:755-763`（`String(Number(body[k]))` 不校验 NaN/范围）<br>实测：`overview.settings = {"weeklyTargetMinutes":null,…}`（实际写入字符串 `"NaN"`）<br>`overview.week.teamTargetMinutes = 30240`（= NaN × 24）<br>`bootstrap.config = {…,"weeklyTargetMinutes":null,…}`（已恢复 1440）<br><br>另 `sessionTtlSeconds=0` 会让所有二维码立即过期：`生成的 session: {…,"ttlSeconds":0}` → `立即使用 → HTTP 410` | 每个 setting 做 `Number.isFinite` + 范围校验（TTL 5–600、周目标 60–10080、时区 -720..840），非法值 400。 |
| **S-16** | 管理端「导出 CSV」按钮不带 `x-admin-token` → 点击必然 401 | 低 | 【A+B】 | `public/admin.js:113-118`（`a.href = '/api/admin/export.csv?week=…'`，`<a>` 无法带自定义头）<br>实测（Playwright 普通导航等价于该按钮）：`普通导航到导出 URL → HTTP 401` / `响应体: {"error":"需要管理员登录"}`；对照 `带 token 的 fetch → {"s":200,"first":"姓名,工位,在岗小时,…"}` | 改 `fetch(url,{headers:{'x-admin-token':token}}).then(r=>r.blob())` 后触发下载。 |
| **S-17** | `deviceToken` 走 query string → 进 access log / Referer / 历史记录 | 低 | 【A+B】 | `server/index.js:574-577`、`public/employee.js:57`<br>实测：`请求行: GET /api/me?employeeId=f1ef22b6-…&deviceToken=n3kouUHqGl3aFr0hHqSHruClDRELhk9c → 200` | 改 `POST /api/me`（token 放 body）或 `Authorization: Bearer`。 |
| **S-18** | 管理端 token 无服务端会话表、无吊销、7 天有效期、存 localStorage | 低 | 【A+B】 | `server/index.js:52-69`、`public/admin.js:39`<br>实测：`token payload = {"exp":1796012035311} → 有效期 7 天`（无 nonce / 无 session 表 / 无吊销）；`篡改 exp 但保留原签名 → HTTP 401`（HMAC 有效 ✔） | 加服务端会话表（可吊销、有效期缩到 12h）；或 HttpOnly + SameSite=Strict Cookie。 |
| **S-19** | 限流状态表清理逻辑有洞 → Map 只增不减；且限流可被用来**锁死受害者** | 低 | 【仅 B】 | `server/index.js:99-105` 清理条件 `v.lockedUntil < now && !v.fails` → **失败 1~7 次且此后不再访问的键永远不会被删除**<br><br>锁定 DoS：B 版实测 `锁定期间用正确 PIN → 429 {"error":"员工码尝试次数过多，请 600 秒后再试"}` —— 攻击者从同一出口 IP 连发 8 次错误码即可让**受害者**在 5~10 分钟内无法用员工码打卡（办公室 NAT 场景下同一出口 IP 很常见）；邀请码通道同理（`invite:` 键含 employeeId，可定点锁死某人的登记） | 清理条件改为 `v.lockedUntil < now && (!v.fails || now - v.firstFail > windowMs)`；锁定改成「按 employeeId 全局计数」而不是按 IP，避免互相锁死；提供管理端解锁入口。 |

### 信息（4 条）

| # | 内容 | 证据 |
|---|---|---|
| **S-20** | `register-verify` 无「已登记」二次校验（目前被 `register-options` 挡住，属纵深防御缺失） | `server/index.js:433-448` 无 `listCredentials` 检查；`:428` 有<br>实测：`POST register-options（已登记员工） → HTTP 400 {"error":"该员工已登记过生物特征"}` ✔；`POST register-verify（绕过 register-options 直接打） → HTTP 500 {"error":"注册挑战无效或已过期"}`（无有效 challenge 无法完成 ✔）→ `register-verify` 也加同一检查 |
| **S-21** | PIN / 邀请码比较非常量时间；admin 口令先比长度 | `server/index.js:425`、`:534` 用 `!==`；`:651` 先 `given.length !== ADMIN_SECRET.length` 再 `timingSafeEqual`（admin 部分 ✔ 常量时间，只泄漏长度）<br>实测时序噪声大，未测出显著差异 → PIN/邀请码比对前先算哈希再 `timingSafeEqual`；admin 口令去掉长度短路 |
| **S-22** | 员工码无强度下限，管理员可设成 `1` | `server/index.js:714` `patch.pin = String(body.pin)` 无校验<br>实测：`PIN 改成 "1" 后用 "1" 打卡 → HTTP 200` → 限制 ≥6 位数字，或只允许「重置为随机码」 |
| **S-23** | 其它杂项 | ① `hasPin` 恒为 true（`server/index.js:180`，建员工必带 PIN）→ 无信息量噪声字段；② WebAuthn `origin` 由 `Host` 头推导（`server/index.js:440`、`:474`），未强制 `APP_ORIGIN` 白名单（B 版已支持逗号分隔多 origin `:36-38`，但未强制设置）；③ 服务端日志打印完整异常栈（`:817`）——仅服务端，不回传客户端 ✔；④ admin token 存 localStorage（`public/admin.js:39`），一旦出现 XSS 即被窃取（本次实测无 XSS，风险低） |

---

## 二、实测确认安全的检查点

每一条都有实际请求/响应或 DOM 取证支撑。

### 越权与身份绑定
1. **`/api/me` 强制校验 deviceToken ↔ employeeId 匹配**（`server/index.js:574-577`、`server/db.js:204-209`）
   - `GET /api/me?employeeId=<B>&deviceToken=<A的token>` → `HTTP 403 {"error":"设备未登记"}`
   - 缺 token → `HTTP 403`；错 token → `HTTP 403`
2. **其它持 deviceToken 的接口同样绑定**：`/api/exceptions`（`:599`）、`/api/auth/assert-options`（`:455`）、`/api/auth/assert-verify`（`:473`）
   - `POST /api/exceptions {employeeId:<B>, deviceToken:<A的>}` → `HTTP 403`
   - `POST assert-options {employeeId:<B>, deviceToken:<A的>}` → `HTTP 403 {"error":"设备未登记，请重新激活"}`
3. **不能拿别人的 employeeId 给自己打卡**：`POST /api/checkin/pin {employeeId:<B>, pin:<A的>}` → `HTTP 403 {"error":"员工码不正确"}`
4. **deviceToken 不可枚举**：空串 / `a` / 32×`A` / 正确值+`x` 全部 `→403`；`deviceToken 长度=32 字符 → 192 bit 熵`；DB 内只存 SHA-256（`device_token_hash":"db11564c8493e35a…"`），比对用 `timingSafeEqual`
5. **已登记员工不能被重复登记顶号**：`POST /api/auth/register-options（已登记员工） → HTTP 400 {"error":"该员工已登记过生物特征"}`；旧 deviceToken 仍 `HTTP 200` 有效
6. **软删除后无法再打卡**（B 版新行为）：`删除后用员工码打卡 → HTTP 403 {"error":"员工码不正确"}` ✔

### 管理端鉴权
7. **全部 `/api/admin/*` 未登录一律 401**（`server/index.js:657-659`）——实测 9 条路由：`overview / employees(POST) / employees/:id(PATCH) / employees/:id/invite / employees/:id(DELETE) / terminals / settings / exceptions/:id / export.csv` → 全部 `HTTP 401 {"error":"需要管理员登录"}`
8. **未登录读不到周报、员工名单、CSV 导出**：`GET /api/admin/export.csv` 无 token → `HTTP 401`，响应体不含表头「姓名」
9. **垃圾 / 空 / 长度不符 token 全部 401**（`.`、`..`、`a.b`、`x.yyy…` 不崩溃）
10. **改 `exp` 但保留原签名 → 401**（HMAC 有效）：`[GET overview 伪造 exp] HTTP 401`
11. **管理员口令比较用 `crypto.timingSafeEqual`**（`server/index.js:651`），50 次等长错 vs 不等长 vs 正确：`105ms / 73ms / 62ms`，噪声内无显著时序差

### 终端鉴权
12. **缺 key / 空 key / 错 key 一律 403**（`server/index.js:617`）：`headers={} → HTTP 403 {"error":"终端密钥错误"}`
13. **跨终端越权被拒**：用终端1 的 key 调终端2 → `HTTP 403`
14. **跨终端取别人的二维码会话被拒**：拿终端2 的 sessionId 去终端1 取 qr.svg → `HTTP 404 {"error":"会话不存在"}`（`server/index.js:635` 校验 `sess.terminal_id !== terminal.id`）
15. **终端密钥 128 bit（32 hex）不可爆破**；`2000 次错误 key → 11226ms`（无速率限制但空间不可行）
16. **B 版已让终端停用生效**：`UPDATE terminals SET active=0` → `停用后 → HTTP 403 {"error":"终端已停用"}` ✔

### 重放
17. **二维码 sessionId 一次性**：`第一次使用 → HTTP 200`；`同一个 session 第二次使用 → HTTP 409 {"error":"这个二维码已经用过了"}`；换第二个人用同一 session 同样 `HTTP 409`
18. **二维码过期被拒**：TTL 临时改 1s 后 → `HTTP 410 {"error":"二维码已过期，请重新扫"}`（已恢复 TTL=45）
19. **WebAuthn challengeId 一次性**：`正常流程 HTTP 200` 后 `challengeId 二次使用 → HTTP 500 {"error":"认证挑战无效或已过期"}`（`server/db.js:352-356` `takeChallenge` 取出即删）
20. **同一 assertion 不可二次打卡**：`重放同一 assertion → HTTP 500 {"error":"认证挑战无效或已过期"}`
21. **旧 assertion 配新 challenge 被拒**：`HTTP 500 {"error":"Unexpected authentication response challenge \"…\", expected \"…\""}`
22. **A 的 assertion 不能用于 B**：`HTTP 500 {"error":"凭据不匹配"}`（`server/webauthn.js:119`（快照未变））
23. **sessionId 空间 32^8 ≈ 1.1e12，不可爆破**
24. **B 版新增原子占用**（`server/db.js:335-340` `claimSession`，`server/index.js:486`/`:546` 调用）——并发提交只有一个能成功

### 注入
25. **SQL 全部参数化**。5 组 payload（`' OR '1'='1`、`'; DROP TABLE employees; --`、`1' UNION SELECT invite_code, pin FROM employees--`、`\'; DROP TABLE events;--`、`%27%20OR%201=1--`）经 `POST /api/admin/employees` 与 `PATCH /api/admin/employees/:id` 后**原样存储**，无任何拼接执行：
    `PATCH name="1' UNION SELECT invite_code, pin FROM employees--" → HTTP 200 "1' UNION SELECT invite_code, pin FROM em"`（截断 40 字符，符合 `server/index.js:710` 的 `slice(0,40)`）
    `注入后数据库仍然完整：overview HTTP 200, 员工数=24, bootstrap 员工数=24`
    `employeeId="' OR 1=1--" → HTTP 404 {"error":"员工不存在"}`；`terminalId="1; DELETE FROM events" → HTTP 404 {"error":"终端不存在"}`
    `server/db.js:188-195`（`updateEmployee`）与 `:276-283`（`updateException`）的动态 SET 子句只从白名单取列名，值全部走 `?` 绑定 ✔
26. **XSS 全链路转义**（`public/lib.js:166-168` `esc()`）：
    - 管理端员工行 `innerHTML` 实测 `&lt;img src=x onerror="window.__XSS_NAME=1"` / `&lt;svg onload=…&gt;`，DOM 中**没有** `img`/`svg` 元素：`{"name":0,"seat":0,"note":0,"anyImg":false,"anySvg":false}`
    - 管理端例外说明列：`"&lt;img src=x onerror=\"window.__XSS_NOTE=1\"&gt;"`，`window.__XSS_NOTE = 0`
    - 终端页在场名单：`&lt;img src=x onerror="window.__XSS_NAME=1"`，`anyImg:false`
    - 员工端下拉：`&lt;img src=x onerror=… · &lt;svg onload=…&gt;`，`anyImg:false`
    - `alert/dialog 触发次数 = 0`

### 其它
27. **静态服务无路径穿越 / 任意文件读**（`server/index.js:144-149`）。15 条 payload 全 404：`/../server/index.js`、`/..%2fserver%2findex.js`、`/%2e%2e/server/index.js`、`/....//server/index.js`、`/..;/server/index.js`、`/../data/presence.db`、`/%2e%2e%2f%2e%2e%2fetc%2fpasswd`、`/..%5c..%5cetc%5cpasswd`、`/server/index.js`、`/data/presence.db`、`/../node_modules/@simplewebauthn/server/package.json` 等
28. **CSRF 结构上不成立**：服务端**不下发任何 Cookie**（实测无 `set-cookie`），管理端只认 `x-admin-token` 自定义头（跨站表单/图片无法设置），且**无任何 CORS 头**：`带 Origin 头 → HTTP 401，响应里有 Access-Control-Allow-Origin 吗: false`；跨域预检 `OPTIONS` → 401
29. **终端 secret 未泄漏到任何非创建接口**：bootstrap `false` / overview `false` / CSV `false`
30. **bootstrap 未泄漏 secret 类字段**：`terminal1.secret? false`、`terminal2.secret? false`、`empA.pin? false`、`empA.inviteCode? false`、`empA.deviceToken? false`
31. **B 版已把终端事件流按终端隔离**：`终端甲 recent = [{"name":"事件员工","kind":"in",…}]` / `终端乙 recent = []` ✔（`server/index.js:311-317`）

---

## 三、修复优先级

| 优先级 | 事项 | 涉及编号 | 工作量 |
|---|---|---|---|
| **P0** | **重启服务让 12:29 的限流补丁生效**（当前线上跑的仍是无限流的 A 版） | S-01、S-02 | 1 行 |
| **P0** | `clientIp()` 改为只信 `req.socket.remoteAddress`；限流键加 employeeId 维度（不绑 IP）；补「伪造 XFF 也必须被限流」的用例 | **S-03** | 小 |
| **P0** | 管理员口令：停止打印到 stdout（改哈希存储）、`/api/admin/login` 加限流、支持改密与吊销 | S-04、S-05、S-09 | 中 |
| **P1** | 员工码/邀请码扩到 8~12 位随机字符并哈希存储；停用员工立即失效 | S-01、S-02、S-05、S-06 | 中 |
| **P1** | 终端密钥脱离 URL、支持取回/重置/停用/删除、常量时间比较 | S-07 | 中 |
| **P1** | CSV 公式注入转义；错误码 4xx 化 + 500 脱敏；`readBody` 加大小上限 | S-08、S-11、S-14 | 小 |
| **P2** | 安全响应头；bootstrap 最小化 + `HOST=127.0.0.1`；settings 入参校验；导出按钮带 token；deviceToken 走 header；限流表清理 + 解锁入口 | S-10、S-13、S-15、S-16、S-17、S-19 | 小 |

---

## 四、附：本次审查使用的脚本

| 脚本 | 覆盖 |
|---|---|
| `test-reports/setup-fixtures.js` | 建夹具（2 员工 + 2 终端 + 可控 PIN） |
| `test-reports/register-A.js` | 虚拟认证器登记指纹，取 deviceToken |
| `test-reports/t1-authz.js` | 越权 / deviceToken 绑定 / 枚举预言机 |
| `test-reports/t2-admin-auth.js` | 管理端鉴权 / token 伪造 / 登录爆破 |
| `test-reports/t3-terminal.js` | 终端鉴权 / 跨终端越权 / secret 暴露面 |
| `test-reports/t4-replay.js` | 二维码 session、challenge、assertion 重放 |
| `test-reports/t5-brute.js` | PIN / 邀请码爆破速率与锁定 |
| `test-reports/t6-injection-xss.js`、`t6b-xss-verify.js` | SQL 注入、XSS（管理端 / 终端 / 员工端） |
| `test-reports/t7-misc.js` | bootstrap 暴露面、DB 明文、CSRF、路径穿越、请求体、错误信息、安全头、停用员工 |
| `test-reports/t8-extra.js` | 隔离实例验证口令落库、导出按钮、终端链接、登录爆破、iframe |
| `test-reports/t9-invite-takeover.js` | 邀请码爆破 → 账号接管（端到端） |
| `test-reports/t10-ratelimit-patch.js` | 在隔离实例（:8097）复核 12:29 限流补丁，并验证 XFF 绕过 |
