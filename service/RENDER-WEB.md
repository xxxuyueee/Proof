# Render 网页酒吧

本次只扩展 `mcp-http.mjs` 的 HTTP 入口。`server.mjs`、引擎和持久化格式不变。

## 环境变量

- `PROOF_WEB_USER`：独立的网页用户名。
- `PROOF_WEB_PASSWORD`：独立随机密码，至少 20 字符；不要复用 MCP Secret、Agent Token 或管理员口令。
- `PROOF_PUBLIC_DRINK_URL`：`https://你的公网域名/proof/drink/`。未设置时启动器使用 Render 自动提供的 `RENDER_EXTERNAL_URL` 构造；自定义域名时显式设置。
- 保留 `PROOF_MCP_SECRET`、现有磁盘目录变量、`PROOF_AGENT_TOKEN_FILE` 和全部现有 Agent 配置。
- 可选 `PROOF_ADMIN_SETUP_KEY`：仅当需要首次初始化原有管理口令且尚未配置时设置。不要打开 `PROOF_ALLOW_INSECURE_ADMIN_SETUP`。

缺少网页凭据、密码不足 20 字符或公网 URL 配置无效时，调酒台及白名单管理 API 返回 503；MCP、健康检查和公开饮酒页仍可工作。网页要求公网 HTTPS 饮酒 URL；错误配置仅关闭调酒台，不中断 MCP。应在部署前检查。

## 访问方式和安全边界

打开 `/`，浏览器通过 HTTP Basic 提示输入独立网页凭据。成功后设置有效期 8 小时的签名 `proof_web` Cookie（HttpOnly、Secure、SameSite=Strict）。Cookie 让原网页使用 Bearer 管理口令登录时仍能通过外层访问控制。更换网页密码会使旧 Cookie 失效；共享电脑使用后关闭浏览器会话并清除站点数据及缓存的 Basic 凭据。

网页登录保护页面、资源以及每一个允许代理的管理 API，直接调用 API 同样需要认证。管理 API 写请求拒绝跨站 Origin/Sec-Fetch-Site；无 Origin 的 CLI 请求仍必须认证。白名单仅包含现有 UI 使用的方法与路径，不代理整个 `/human/*`，也不代理 `/agent/*`、模型网关或任意文件。上游地址固定为 loopback，客户端无法指定。

原有管理员身份继续独立校验，reset、injection、修改管理密码等仍要求原有管理会话。在 UI 中由管理员主动输入其口令；代理不读取或注入任何管理员、Agent 或 MCP 凭据。不要将这些服务端凭据放入网页构建配置。

`/proof/drink/` 匿名可访问；`/proof-api/capability/offer` 仅转发 GET/POST，仍由现有服务校验 URL fragment 中的单杯 Bearer Token。此接口不转发管理 Cookie。MCP Bearer Secret 无法用于网页登录，网页凭据无法用于 MCP。

## 安全部署

1. 审查 diff 和测试结果；本次未部署、未自动合并。
2. 在维护窗口记录当前成功部署的 commit、环境变量名称及磁盘挂载目录；按现有备份流程备份 Persistent Disk，避免在写入期间直接复制状态文件。
3. Render Root Directory 保持 `service/`，启动命令保持 `node start-render.mjs`。仓库的 `ui/` 和 `engine/` 必须保留在同一次完整 checkout 中；静态文件按模块位置解析为 `../ui/`，不依赖工作目录。不需要额外构建命令或 npm 包。
4. 设置上述网页变量，确认公网域名和磁盘变量。不要改变磁盘挂载或清理任何 state/token 文件。先在隔离的测试服务验证；不要让两个实例同时写同一块磁盘。
5. 经人工批准部署选定提交。检查 `/health`；无 MCP Token 的 `/mcp` 应返回 401，原 TypingMind 连接能列工具和正常调用。
6. 无网页登录访问 `/` 和直接调用 `/proof-api/human/offers` 应为 401；登录后测试调酒、复制链接、保存酒单。用无痕窗口打开公开链接并喝下或拒绝；确认公网链接没有 localhost。测试杯会写状态，应与正式杯区分。
7. 检查 `/proof-api/agent/state`、模型网关和 `/state/char.token` 返回 404。

## 回滚

在 Render 选择本次之前的成功部署重新部署，保留原有磁盘和环境变量；新增网页变量可随后移除。无需迁移或恢复状态，因为未改变持久化格式。不要为了回滚删除磁盘或 token。回滚后重新检查 `/health` 和 TypingMind；旧入口不提供网页，已发饮酒链接的网页入口也将暂时不可用。

紧急关闭调酒台可移除 `PROOF_WEB_USER` 与 `PROOF_WEB_PASSWORD` 后重新部署当前代码，保留公开饮酒页和 MCP。此操作不删除数据。

## 本地验证

```sh
node --test service/tests/render-web.test.mjs
npm --prefix service test
```

新增测试在临时目录运行真实 Render 启动器、MCP 子进程和 Proof API，验证 MCP Token/工具列表、网页及 API 鉴权、公网链接生成和匿名饮酒流程；绝不使用生产磁盘。真实启动器测试占用 loopback 8791，运行前应确保该端口空闲。生产 Cookie 要求 HTTPS，本地测试通过显式 Cookie 请求验证边界。

## 本次测试记录

- `npm --prefix service run test:render`：3 项通过。
- `npm --prefix service test`：81 项通过。
- 额外运行 `node --test service/tests/*.test.mjs`：新增最后一个测试前为 111 项，97 通过、14 失败；原始 HEAD 在独立目录运行同一命令为 109 项，95 通过、14 失败。两次失败名称集合完全相同（涉及既有 Agent、gateway 和 generic 默认契约），没有新增失败。本次不修改这些无关功能。
- 未执行真实 Render 部署或浏览器视觉回归。
