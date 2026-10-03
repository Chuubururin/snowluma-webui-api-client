派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器

<!-- 本面由 `npm run gen:docs` 从 spec/openapi.yaml 现出，不要手改：
     手改会被 `npm run gen:check` 判红，而它已经在 CI 里。
     数字全部由生成器现算 —— 本页不手抄计数（口径见 AGENTS.md）。 -->

# 操作清单（由契约现出）

契约版本 `0.1.0` · 操作 55 · 路径 47 · schema 101。

档级口径：t1 只读可重放 / t2 可回滚写 / t3 非幂等写（永不自动重放）。

## auth（10 操作）

| 操作 | 方法 | 路径 | 档级 | 摘要 |
| --- | --- | --- | --- | --- |
| `changePassword` | POST | `/api/auth/change-password` | t3 | 修改面板密码 |
| `checkPasswordStrength` | POST | `/api/auth/check-strength` | t1 | 只判强度，不改动任何东西（回环里"先让用户试到合格"的那一步） |
| `getAuthState` | GET | `/api/auth/state` | t1 | 当前会话是否仍被要求改密（门控回环的读侧） |
| `getTotpStatus` | GET | `/api/auth/totp` | t1 | 当前会话的 TOTP 开启状态与剩余恢复码数 |
| `beginTotpEnrollment` | POST | `/api/auth/totp/begin` | t3 | 开始 2FA 绑定（发密钥 + otpauth 链接，会话级席位有 TTL） |
| `confirmTotpEnrollment` | POST | `/api/auth/totp/confirm` | t3 | 确认 2FA 绑定（验密码 + 验码，成功后踢掉其它会话） |
| `disableTotp` | POST | `/api/auth/totp/disable` | t3 | 关闭 2FA（验密码 + 第二因子，成功后踢掉其它会话） |
| `regenerateTotpRecoveryCodes` | POST | `/api/auth/totp/recovery-codes` | t3 | 重生成恢复码（验密码 + 当前 TOTP 码，旧码作废） |
| `login` | POST | `/api/login` | t2 | 密码登录，可选第二因子（TOTP） |
| `logout` | POST | `/api/logout` | t2 | 丢弃当前会话并清 avatar cookie |

## system（13 操作）

| 操作 | 方法 | 路径 | 档级 | 摘要 |
| --- | --- | --- | --- | --- |
| `getStatus` | GET | `/api/status` | t1 | 服务存活探针；顺带为仍有效的 localStorage 会话续签 avatar cookie |
| `getSystem` | GET | `/api/system` | t1 | 主机/进程运行时快照（os.* 与 process.* 直读） |
| `exportBackup` | GET | `/api/system/backup/export` | t3 | 导出配置备份（JSON 下载，可选含凭据） |
| `importBackup` | POST | `/api/system/backup/import` | t3 | 导入配置备份（32MB 上限，事务恢复） |
| `getSystemSettings` | GET | `/api/system/settings` | t1 | WebUI 监听配置与生效状态（读盘即状，只存盘不热生效） |
| `saveSystemSettings` | POST | `/api/system/settings` | t3 | 保存监听配置（校验 + 落盘，重启生效） |
| `getSystemStorage` | GET | `/api/system/storage` | t1 | 日志/暂存/分账号存储快照与最近一次清理审计 |
| `cleanupStorage` | POST | `/api/system/storage/cleanup` | t3 | 清理存储（日志/暂存/分账号/全账号，串行化互斥 + 审计） |
| `updateStorageSettings` | POST | `/api/system/storage/settings` | t2 | 更新日志存储设置（串行化互斥 + 环境锁检查 + 事务回滚） |
| `deleteTlsCert` | DELETE | `/api/system/tls/cert` | t3 | 删除 TLS 证书与私钥（须先关闭 TLS） |
| `uploadTlsCert` | POST | `/api/system/tls/cert` | t3 | 上传 TLS 证书与私钥（落盘 config/，0600 写私钥，重启生效） |
| `uploadBackgroundImage` | POST | `/api/ui/background` | t3 | 上传登录/面板背景图 |
| `checkUpdate` | GET | `/api/update/check` | t1 | 对比当前构建与最新稳定 release 的咨询式检查；只提示，从不下载或应用更新 |

## agreements（2 操作）

| 操作 | 方法 | 路径 | 档级 | 摘要 |
| --- | --- | --- | --- | --- |
| `getAgreements` | GET | `/api/agreements` | t1 | 当前协议集合与是否需要确认 |
| `recordConsent` | POST | `/api/agreements/record-consent` | t3 | 记录操作者本人的协议同意 |

## streams（3 操作）

| 操作 | 方法 | 路径 | 档级 | 摘要 |
| --- | --- | --- | --- | --- |
| `streamDebugEvents` | GET | `/api/debug/stream` | t1 | 全账号 OneBot 事件 + action 调用实况 SSE（慢客户端丢帧不背压） |
| `streamLogs` | GET | `/api/logs/stream` | t1 | 日志 SSE 推送（就绪信号 + 日志条目帧） |
| `streamState` | GET | `/api/state/stream` | t1 | 进程/QQ 列表/连接状态的统一 SSE 推送 |

## debug（4 操作）

| 操作 | 方法 | 路径 | 档级 | 摘要 |
| --- | --- | --- | --- | --- |
| `listDebugActions` | GET | `/api/debug/actions` | t1 | 动作目录与分类计数（按 name 排序） |
| `invokeDebugAction` | POST | `/api/debug/invoke` | t3 | 把任意 OneBot action 透传执行 |
| `streamDebugAction` | POST | `/api/debug/invoke-stream` | t3 | 把任意 OneBot action 经流式传输执行，逐帧回传浏览器 |
| `uploadDebugFile` | POST | `/api/debug/upload` | t3 | 把请求体原样落盘到服务端临时目录，文件名走 query |

## ui（4 操作）

| 操作 | 方法 | 路径 | 档级 | 摘要 |
| --- | --- | --- | --- | --- |
| `getUiConfig` | GET | `/api/ui` | t1 | 全量 UI 配置（鉴权后；含 customCss） |
| `saveUiConfig` | POST | `/api/ui` | t2 | 保存全量 UI 配置（落盘 ui.json） |
| `clearBackgroundImage` | DELETE | `/api/ui/background` | t3 | 清除背景图（恢复默认无图状态） |
| `getPublicUiAppearance` | GET | `/api/ui/public` | t1 | 外观子集（免认证；customCss 被剥空） |

## config（4 操作）

| 操作 | 方法 | 路径 | 档级 | 摘要 |
| --- | --- | --- | --- | --- |
| `getOneBotConfig` | GET | `/api/config/{uin}` | t1 | 某账号的 OneBot 配置（只读：GET 永不落盘补默认） |
| `saveOneBotConfig` | POST | `/api/config/{uin}` | t3 | 保存某账号 OneBot 配置（校验 + 落盘 + 热重载，崩溃分支同码） |
| `getGlobalConfig` | GET | `/api/global-config` | t1 | 全局部署配置（rkey 兜底 + 音乐签名服务） |
| `saveGlobalConfig` | POST | `/api/global-config` | t2 | 保存全局部署配置（落盘 + 热重载全部实例） |

## onebot（7 操作）

| 操作 | 方法 | 路径 | 档级 | 摘要 |
| --- | --- | --- | --- | --- |
| `listConnections` | GET | `/api/connections` | t1 | 各账号 OneBot 适配器健康（dashboard 连接卡片的数据源） |
| `listProcesses` | GET | `/api/processes` | t1 | 被 Hook 注入的 QQ 进程列表（dashboard 初始拉取；之后走 state/stream） |
| `loadProcess` | POST | `/api/processes/{pid}/load` | t3 | 加载（注入）指定进程 |
| `probeProcessLogin` | GET | `/api/processes/{pid}/probe-login` | t3 | 探测某进程的 QQ 登录信息（端口探针，只读） |
| `refreshProcess` | POST | `/api/processes/{pid}/refresh` | t3 | 刷新指定进程状态 |
| `unloadProcess` | POST | `/api/processes/{pid}/unload` | t3 | 卸载指定进程的注入 |
| `listQq` | GET | `/api/qq-list` | t1 | 在线账号的 uin/nickname 列表（dashboard 初始拉取） |

## logs（4 操作）

| 操作 | 方法 | 路径 | 档级 | 摘要 |
| --- | --- | --- | --- | --- |
| `listLogs` | GET | `/api/logs` | t1 | 内存中保留的近期日志（dashboard 日志面板的数据源） |
| `exportTraceLog` | GET | `/api/logs/export/trace` | t1 | 完整 TRACE 导出（纯文本下载，非 JSON） |
| `getLogLevel` | GET | `/api/logs/level` | t1 | 当前控制台日志级别与合法级别表 |
| `setLogLevel` | POST | `/api/logs/level` | t2 | 设置控制台日志级别（即时生效，只影响内存 logger） |

## notifications（4 操作）

| 操作 | 方法 | 路径 | 档级 | 摘要 |
| --- | --- | --- | --- | --- |
| `getNotificationsConfig` | GET | `/api/notifications/config` | t1 | 通知渠道配置（防抖秒数与渠道表） |
| `saveNotificationsConfig` | POST | `/api/notifications/config` | t2 | 保存通知渠道配置（落盘，512KB 上限） |
| `listRecentNotifications` | GET | `/api/notifications/recent` | t1 | 最近投递记录（成功失败都记） |
| `testNotificationChannel` | POST | `/api/notifications/test` | t3 | 向指定渠道发一条测试通知 |
