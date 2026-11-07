# icloud-api 构建报告

日期:2026-11-08。TypeScript + Fastify 后端,`xiaozhou26/icloud-hme`
Go 后端的完整移植,架构对齐 `naka1205/codex-api`。

## 交付内容

项目目录 `~/workspace/repos/icloud-refactor/icloud-api/`:

| 文件 | 说明 |
| --- | --- |
| `package.json` / `tsconfig.json` | fastify 4 + zod + pino + imapflow + **wreq-js 3.2.0**;严格模式,ESM,Node ≥ 22 |
| `src/index.ts` / `src/server.ts` / `src/config.ts` / `src/logger.ts` | 启动、Fastify 实例(env 校验、JSON 解析、安全头、静态托管)、pino 日志 |
| `src/response.ts` / `src/errors.ts` / `src/middleware.ts` / `src/backend.ts` / `src/routes.ts` | 统一信封、稳定错误映射、会话/CSRF 中间件、backend 适配层、全部 21 个端点 |
| `src/auth/{manager,limiter,duration}.ts` | scrypt 会话管理、登录限流、Go 风格时长解析 |
| `src/account/{store,types,validation,manager}.ts` | SQLite 存储、类型、校验与 Summary 投影、账号编排 |
| `src/hme/{http,client,auth}.ts` | wreq-js 上游层、HME 客户端、SRP 登录全流程 |
| `src/srp/{params,client}.ts` | SRP-6a 2048-bit MODP(BigInt, N 与 Go params.go 逐字节核对一致) |
| `src/mail/{client,pool,webClient,preview,mime}.ts` | imapflow IMAP 客户端与连接池、Web 邮件客户端、预览净化器、RFC822/QP/RFC2047 |
| `test/*.test.ts` | 6 个测试文件,48 个用例 |
| `Dockerfile` / `docker-compose.yml` | 4 段式 node:24 镜像;compose 端口 8081、`./data` 卷、`/health` 健康检查 |
| `.env.example` / `.gitignore` | 全部环境变量;忽略 node_modules/dist/.env/data 内容 |
| `README.md` | 架构、端点表、wreq-js 说明、与 Go 的差异、已知限制 |
| `BUILD_REPORT.md` | 本文件 |

未动 `static/`(其中已有管理台构建产物,由其他并行任务产出,本任务未触碰)。

## 验证结果(全部通过)

- `npm install`:成功(155+ 包;wreq-js 3.2.0 原生绑定在 x86_64 Linux
  上加载正常,transport + fetch + getSetCookie 已实测)。
- `npm run typecheck`:通过,0 错误。
- `npm run build`:通过,产物 `dist/`。
- `npm test`:48/48 通过(0 失败),无真实网络调用。覆盖:Cookie 解析、
  账号校验、Summary 泄密防护、预览净化器(4 个 Go 原生用例)、错误映射、
  收件箱整数解析、会话 TTL 解析、SRP 自洽性(独立重写 Go 数学交叉验证
  A/M1/M2)、HME 流程(fake fetch 注入)、管理员会话与登录限流。
- 本地烟测(已启停两个临时实例,数据已清理):
  - `/health` → 200 `{"status":"ok"}`;安全头与 `/api` no-store 均正确。
  - 登录:空密码 400、错密码 401、正确 200 置 Cookie + csrf_token。
  - 无会话 401(`AUTH_REQUIRED`/"请先登录");缺 CSRF 的变更 403
    (`CSRF_INVALID`);登录后 6 次错密码 → 第 6 次 429。
  - 未知 `/api` 路径 → 404 `VALIDATION_ERROR`("接口不存在")。
  - 账号 CRUD:201 创建(pending + "等待配置或验证凭据")、PATCH 空字段
    400、代理格式错 400、Cookie 解析失败 400、删除 200、登出后会话 401。
  - 无 `static/index.html` 时 `GET /` → 503 中文回退文本(从空目录启动
    的第二个实例验证);有构建产物时正常返回 index.html。

## 与 Go 的差异(已在 README 详述)

- 存储:SQLite(`data/icloud.db`,WAL,文件 0600),**不读取 accounts.json**。
- 密码 KDF:scrypt 代替 argon2id(派生密钥临时、启动时算出、不持久化)。
- 上游 HTTPS:**wreq-js 3.2.0** 代替 tls-client。HME 用 `chrome_147`,
  SRP 与 Web 邮件用 `chrome_146`;UA 头仍按 Go 手动设置
  (Chrome/147 与 Chrome/124)。每账号一个 transport(带代理、无共享
  Cookie jar),Cookie 手动管理;HME/SRP/Web 邮件模块均接受注入的类 fetch
  函数以便单测。Web 邮件不走代理,IMAP 仍直连。
- `AliasActive` 计数前先清零,修 Go 的重复校验累加 bug。
- `POST /api/reload` 为 no-op 成功(SQLite 每次调用都直接读库)。
- 其余 Go 怪癖均刻意保留:PUT /cookies 校验失败仍 200、别名计数只在
  新建账号校验时刷新、删除别名先停用再删(第二次失败且无 errorMessage
  时错误消息为空字符串)、收件箱详情仅 IMAP、停用/激活上游 success=false
  仍 HTTP 200、TTL 越界静默回落 12h、邮件正文不解 base64。

## 已知限制

- **未做真实 iCloud 联调**:SRP 登录、HME validate/generate/reserve、
  IMAP 与 Web 邮件均未对真实账号验证;首次部署须用真实账号走通全流程。
  wreq-js 与 tls-client 的指纹实现不同,iCloud 接受程度可能有差异。
- SQLite 单连接同步写,高并发未经压测。
- 密钥(Cookie、App 专用密码、代理、邮箱授权码)在数据库中明文存储,
  与 Go 原版一致,依赖文件权限(0600)与部署隔离。
- 未推送到 GitHub(按任务要求,推送由父代理经 GitHub MCP 处理)。
