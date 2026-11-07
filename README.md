# icloud-api

技术栈：TypeScript + Fastify + SQLite + wreq-js + imapflow。

功能:管理多个 iCloud 账号的 Hide My Email 别名(创建/停用/激活/删除/列表),
并通过 IMAP 或 iCloud Web API 读取别名收到的邮件。管理台前端由
`icloud-api-admin`(Vue 3 + TypeScript)构建,产物放在 `static/` 由本服务托管。

## 快速开始

```bash
cp .env.example .env   # 填入 ICLOUD_API_ADMIN_PASSWORD(至少 8 位)
npm install
npm run dev            # 开发模式,监听 :8081
```

生产:

```bash
npm run build
npm start
# 或 Docker(镜像由 GitHub Actions 构建并推送到 GHCR,服务器只拉取):
docker compose pull && docker compose up -d
```

默认监听 `0.0.0.0:8081`,健康检查 `GET /health` → `{"status":"ok"}`。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `ICLOUD_API_ADMIN_PASSWORD` | 是 | — | 管理员密码,至少 8 个字符;启动后从进程环境删除 |
| `ICLOUD_API_SESSION_TTL` | 否 | `12h` | 会话有效期,时长格式(`12h`/`90m`/`15m`) |
| `ICLOUD_API_SECURE_COOKIE` | 否 | `false` | 会话 Cookie 是否标记 Secure(HTTPS 部署时开启) |
| `HOST` | 否 | `0.0.0.0` | 监听地址 |
| `PORT` | 否 | `8081` | 监听端口 |
| `DATA_DIR` | 否 | `./data` | SQLite 数据库目录(`data/icloud.db`) |
| `LOG_LEVEL` | 否 | `info` | 日志级别 |

注意:`ICLOUD_API_SESSION_TTL` 超出 15m–168h 范围时**静默回落到 12h**;语法非法的值会拒绝启动。

## 架构

```
src/
  index.ts            启动:读 env → 建 store/manager/auth → listen,优雅停机
  server.ts           Fastify 实例:安全头、JSON 解析、静态托管、错误处理
  config.ts           zod 环境校验(密码读后即从 process.env 删除)
  logger.ts           pino(开发环境 pino-pretty)
  response.ts         统一信封 {success:true,data} / {success:false,code,message}
  errors.ts           BackendError 与错误映射(mapAccountErr / classifyUpstreamErr / classifyLoginErr)
  middleware.ts       会话校验(401)与 CSRF 校验(403)
  backend.ts          业务适配层:把 manager 错误映射为稳定错误码
  routes.ts           全部 21 个端点
  auth/
    manager.ts        管理员会话(scrypt KDF,内存会话,32 字节随机 ID + CSRF token)
    limiter.ts        登录限流(15 分钟窗口,每 IP 5 次失败 → 429 + Retry-After)
    duration.ts       时长解析
  account/
    store.ts          SQLite 存储(node:sqlite,单文件, WAL 模式)
    types.ts          Account / AccountSummary / MailboxConfig
    validation.ts     名称/邮箱/主机/代理校验、Cookie 输入解析、Summary 投影
    manager.ts        账号编排:CRUD、Cookie 校验、SRP 登录、邮件、别名
  hme/
    http.ts           上游 HTTP 层(wreq-js,见下文)
    client.ts         Hide My Email 客户端(validate / list / generate / reserve / delete…)
    auth.ts           iCloud SRP 登录全流程(11 步)
  srp/
    params.ts         SRP-6a 2048-bit MODP 参数与 BigInt 运算
    client.ts         SRP 客户端(M1/M2 计算)
  mail/
    client.ts         IMAP 客户端(imapflow: imap.mail.me.com:993)
    pool.ts           IMAP 连接池(每账号,10 分钟空闲重建,NOOP 保活)
    webClient.ts      iCloud Web 邮件客户端(mccgateway thread/search)
    preview.ts        邮件预览净化器(stripHTML / sanitizePreview)
    mime.ts           RFC822 解析、quoted-printable 与 RFC2047 解码
```

### 认证模型

- 管理员密码**只从环境变量读取**,不走 Bearer token。
- 会话存内存:32 字节随机会话 ID + CSRF token,键以 SHA-256 hex 存储,
  默认 12 小时有效,最多 32 个会话。Cookie `hme_session` HttpOnly +
  SameSite=Strict + Path=/,Secure 仅在 `ICLOUD_API_SECURE_COOKIE=true` 时开启。
- 所有非 GET/HEAD/OPTIONS 的 `/api` 请求须带 `X-CSRF-Token` 头。
- 登录限流:15 分钟窗口内同一 IP 失败 5 次后返回 429 + `Retry-After` 秒数;
  成功登录清零计数。

### 上游 HTTPS 一律走 wreq-js

上游 Apple/iCloud 端点全部经 wreq-js 调用(Chrome 146 TLS 指纹);原生 Node fetch 会发送 Node 的 JA3/JA4 指纹,iCloud 可能标记拦截。
本项目用 **wreq-js 3.2.0**(Rust/BoringSSL,预编译原生二进制,无需 Rust
工具链)作为 TS 等价物,浏览器 TLS + HTTP/2 指纹模拟:

| 用途 | wreq-js 预设 | User-Agent 头(手动设置) |
| --- | --- | --- |
| HME 客户端 | `chrome_147` | Chrome/147.0.0.0 |
| SRP 登录流程 | `chrome_146` | Chrome/124.0.0.0 |
| Web 邮件客户端 | `chrome_146` | Chrome/147.0.0.0 |

预设只控制 TLS 指纹,User-Agent 头是另外单独设置的,两者不要混淆。

- **不用共享 Cookie jar**:每个账号一个 `createTransport({browser, proxy})`
  (连接池化 + 每账号代理),请求用独立的
  `fetch(url, {transport, headers})`,Cookie 头手动拼装
  (值不以 `"` 开头时包一层双引号),响应的 `Set-Cookie` 经
  `response.headers.getSetCookie()` 合并回客户端的 Cookie 映射。
- **代理**:HME 客户端与 SRP 流程共用账号代理(http/https/socks5,支持
  `user:pass@host:port`);Web 邮件客户端**不走代理**;
  IMAP 不走代理(仍用 imapflow 直连)。
- **可测试性**:HME/SRP/Web 邮件模块接受注入的类 fetch 函数
  (`UpstreamFetch`),单测不加载原生绑定、不触网。见 `test/hme.test.ts`。

## API

全部响应包在统一信封里。成功:`{"success":true,"data":...}`;
失败:`{"success":false,"code":"...","message":"..."}`。
`/api/*` 未知路径返回 404 `VALIDATION_ERROR`("接口不存在")。
`/api` 响应带 `Cache-Control: no-store`。

### 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | `{password}` → `{csrf_token, expires_at}`(置 Cookie) |
| GET | `/api/auth/session` | 当前会话的 `{csrf_token, expires_at}` |
| POST | `/api/auth/logout` | 需会话 + CSRF → `{logged_out:true}`,清除 Cookie |

### 账号(响应均为 AccountSummary,不含 Cookie/App 密码/代理/错误详情)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/accounts` | 列表,按 active → pending → error 再按名称排序 |
| POST | `/api/accounts` | → **201**。`{name, icloud_email, host?, proxy?, cookies?}` |
| PATCH | `/api/accounts/:id` | 至少提供一个字段 |
| PUT | `/api/accounts/:id/proxy` | 空字符串表示清除代理 |
| PUT | `/api/accounts/:id/cookies` | `cookies` 为 Header 字符串或 JSON 对象 |
| POST | `/api/accounts/:id/password` | `{icloud_email, app_password}`,先实测 IMAP 再保存 |
| PUT | `/api/accounts/:id/mailbox` | `{provider, email, imap_host, imap_port, authorization_code}`,先实测再保存 |
| POST | `/api/accounts/:id/login` | `{password, otp_code?}` iCloud 密码登录(SRP + 可选 2FA) |
| DELETE | `/api/accounts/:id` | → `{id}` |

### 业务

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/create` | `{account_id, label?}`(label ≤ 200 字符)→ `{email, label, created_at, account_id}` |
| GET | `/api/inbox` | `?account_id&alias?&limit=20(1–100)&days=7(1–90)` → `{account_id, alias?, count, messages, method}` |
| GET | `/api/inbox/:message_id` | 仅 IMAP。`?account_id` 必填 |
| DELETE | `/api/inbox/:message_id` | 仅 IMAP → `{id}`(原始字符串) |
| GET | `/api/aliases` | `?account_id` → `{account_id, count, aliases}` |
| POST | `/api/aliases/:id/deactivate` | `{account_id}` → `{anonymous_id, success}` |
| POST | `/api/aliases/:id/reactivate` | 同上 |
| DELETE | `/api/aliases/:id` | `{account_id}` → `{anonymous_id}` |
| POST | `/api/reload` | → `{message:"配置已重新加载"}`(SQLite 下为 no-op,见下文) |

### 稳定错误码

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `AUTH_REQUIRED` | 401 | 未登录 / 会话已失效 |
| `INVALID_CREDENTIALS` | 401 | 管理员密码错误 |
| `RATE_LIMITED` | 429 | 登录尝试过于频繁(带 `Retry-After` 头) |
| `CSRF_INVALID` | 403 | 缺少会话 / CSRF 校验失败 |
| `VALIDATION_ERROR` | 400/404 | 参数错误 / 接口不存在 |
| `ACCOUNT_NOT_FOUND` | 404 | 账号不存在 |
| `OTP_REQUIRED` | 409 | iCloud 登录需要 OTP 验证码 |
| `OTP_INVALID` | 401 | OTP 验证码错误 |
| `UPSTREAM_UNAUTHORIZED` | 401 | iCloud 会话失效,请更新 Cookie |
| `UPSTREAM_FAILURE` | 502 | 上游失败(消息固定,不拼接上游响应体) |
| `INTERNAL_ERROR` | 500 | 内部错误 |

### 邮件读取策略

`GET /api/inbox` 先走 IMAP 连接池(App 专用密码):成功即返回
`method:"imap"`(即使结果为空);IMAP 失败则回退 Web API(Cookie 认证),
返回 `method:"web_api"`。无可用客户端时返回 400
"无可用邮件客户端: 需要 App Password 或 Cookie";Web 端也失败时返回
502 "读取邮件失败"。`GET/DELETE /api/inbox/:message_id` 仅走 IMAP,
无 Web 回退。

### 前端托管

`static/` 由 `@fastify/static` 托管在 `/`:哈希资产 `Cache-Control:
public, max-age=31536000, immutable`,`index.html` 为 `no-cache`,其余
GET 路径回退到 `index.html`(SPA)。若 `static/index.html` 不存在,
`GET /` 返回 503 纯文本"管理界面资源未构建,请先运行 npm run build
后重新编译服务"。

## 测试

```bash
npm test          # tsx --test,48 个用例,无真实网络调用
npm run typecheck
npm run build
```

测试覆盖:Cookie 输入解析、账号校验规则、Summary 泄密防护、预览净化器
(4 个用例)、错误映射、收件箱整数解析、会话 TTL 解析、SRP
自洽性(用独立重写的数学交叉验证 A/M1/M2)、HME 辅助函数与注入
fake fetch 的端到端流程(validate/list/create/delete 回退)、管理员
会话与登录限流。
