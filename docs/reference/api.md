# SnowLuma WebUI API 调用规范

> [!NOTE]
> 本文档面向基于 SnowLuma WebUI API 开发客户端的开发者。
> 契约真源：[`spec/openapi.yaml`](../../spec/openapi.yaml)（55 操作 / 47 路径 / 101 schema，drift 全覆盖）。
> 所有形状经生产实例运行时验证；当轮的原始响应样本已随旧文档目录退役，且本仓历史已
> 压缩重建为单条初始提交，这些样本**在 git 历史中已不存在**；现行可复现的验证链见 [验证体系](../operations/verification.md)（L4 活体门禁）。

## 概览

- **Base URL**：`http://<host>:5099`（默认监听 127.0.0.1:5099；可在实例配置中修改）
- **协议**：HTTP/1.1，JSON 请求与响应（SSE 流端点除外）
- **认证**：Bearer token（登录获取，`Authorization: Bearer <token>` 头携带）
- **API 契约**：OpenAPI 3.0.3；安全边界与重放分级见「注意事项」

## 认证与会话

### 登录

```
POST /api/login
Content-Type: application/json

{"password": "你的密码"}
```

成功（200）返回以下**判别联合**之一（R22：无 discriminator，按 `success` 布尔值选支）：

| 形状 | 键 | 含义 |
| --- | --- | --- |
| `LoginSuccess` | `{success:true, token, mustChangePassword}` | 登录成功，取 `token` |
| `LoginNeedsTotp` | `{success:false, needsTotp:true}` | 需第二因子：带 `totp` 字段重调 |

失败（非 200）：

| 状态码 | 形状 | 含义 |
| --- | --- | --- |
| 400 | `{success:false, message}` | 请求格式错误 |
| 401 | `{success:false, message}` | 密码错误 |
| 429 | `{success:false, message}` | 登录限速（5 次/15 分钟/IP；等待秒数仅在中文文案里） |
| 500 | `{success:false, message}` | 服务端 TOTP 状态落盘失败 |

### 门控引导（新实例必经）

新实例除 allowlist 路径外全部 403，必须按以下顺序引导：

```
1. POST /api/login → 取 token
2. GET /api/agreements → {version, consentRequired, documents}
   ├ consentRequired=true → POST /api/agreements/record-consent {version}
   │   └ 409 {currentVersion} → 用返回版本重试（仅一次）
   └ consentRequired=false → 跳过
3. mustChangePassword=true → POST /api/auth/change-password {oldPassword, newPassword}
   └ 成功后服务端已清除全部会话 → 回到步骤 1 用新密码重登
4. 会话就绪
```

> [!CAUTION]
> **`acceptAgreements` 默认 false**：同意 EULA 是替操作者做的法律行为；客户端应默认
> 抛 `ConsentRequiredError`（附 documents），调用方显式传参才解锁。

### 会话生命周期

- token 存于服务端进程内 Map，**重启即全量失效**，无 refresh 端点——不做伪 refresh。
- **401 按方法安全性分治**：
  - **GET/HEAD**：自动重登一次并重放原请求（例外：`/api/update/check` 带 external-fetch
    副作用标记，不自动重放）；
  - **POST/DELETE**：**不重放**，抛 `SessionExpiredError`（重复执行有实际后果）。
- 登出：`POST /api/logout` → 服务端清除该 token。

## 请求与响应格式

### 成功响应

所有 JSON 端点的 2xx 响应体都是 JSON 对象。两种信封：

| 信封 | 形状 | 示例端点 |
| --- | --- | --- |
| 操作特定形状 | 每端点独有（见「操作清单」） | GET /api/system |
| 通用成功 | `{success:true, …}` | POST /api/global-config |

### 错误响应

两种错误信封（**不合并**，按来源形状分别建模）：

| 信封 | 形状 | 适用 |
| --- | --- | --- |
| `SuccessFalseEnvelope` | `{success:false, message}` | 大多数写操作的业务错误 |
| `DebugEnvelopeFailure` | `{status:'failed', message}` | /api/debug/* 面 |

**判据是字面形态不是端点归属**：`c.json` 里出现 `success:false` + `message` 即为前者。

### 路径参数

OpenAPI 模板形 `{uin}`，实际 URL 用 Express 形 `:uin`——两种写法指的是同一个参数。
客户端应使用 OpenAPI 模板形构建路径。

## 操作清单（按域分组）

### auth（6 操作）

| 操作 | 方法 | 路径 | 档级 | 说明 |
| --- | --- | --- | --- | --- |
| login | POST | /api/login | t2 | 密码登录，可选 TOTP |
| logout | POST | /api/logout | t2 | 登出（清除服务端 token） |
| getAuthState | GET | /api/auth/state | t1 | 是否被要求改密 |
| checkPasswordStrength | POST | /api/auth/check-strength | t1 | 密码强度检查 |
| changePassword | POST | /api/auth/change-password | t3 | 修改密码（成功后全部会话失效） |
| getTotpStatus | GET | /api/auth/totp | t1 | TOTP 开启状态与剩余恢复码 |

### system（8 操作）

| 操作 | 方法 | 路径 | 档级 | 说明 |
| --- | --- | --- | --- | --- |
| getStatus | GET | /api/status | t1 | 服务存活探针 |
| getSystem | GET | /api/system | t1 | 主机/进程运行时快照 |
| getSystemSettings | GET | /api/system/settings | t1 | WebUI 监听设置 |
| saveSystemSettings | POST | /api/system/settings | t3 | 修改监听设置（需重启生效） |
| getSystemStorage | GET | /api/system/storage | t1 | 存储快照与清理记录 |
| updateStorageSettings | POST | /api/system/storage/settings | t2 | 修改日志存储设置 |
| cleanupStorage | POST | /api/system/storage/cleanup | t3 | 清理存储（破坏性） |
| uploadTlsCert / deleteTlsCert | POST/DELETE | /api/system/tls/cert | t3 | TLS 证书管理 |

### onebot（4 操作）

| 操作 | 方法 | 路径 | 档级 | 说明 |
| --- | --- | --- | --- | --- |
| listQq | GET | /api/qq-list | t1 | 已挂号 QQ 账号列表 |
| listConnections | GET | /api/connections | t1 | OneBot 连接健康 |
| getOneBotConfig | GET | /api/config/{uin} | t1 | 读取账号 OneBot 配置 |
| saveOneBotConfig | POST | /api/config/{uin} | t3 | 保存账号 OneBot 配置 |

### logs（5 操作）

| 操作 | 方法 | 路径 | 档级 | 说明 |
| --- | --- | --- | --- | --- |
| listLogs | GET | /api/logs | t1 | 最近日志（query.limit，缺省 300） |
| getLogLevel | GET | /api/logs/level | t1 | 当前控制台日志级别 |
| setLogLevel | POST | /api/logs/level | t2 | 设置控制台日志级别 |
| exportTraceLog | GET | /api/logs/export/trace | t1 | 导出完整追踪日志（text/plain 下载） |
| streamLogs | GET | /api/logs/stream | t1 | SSE 实时日志流 |

### notifications（3 操作）

| 操作 | 方法 | 路径 | 档级 | 说明 |
| --- | --- | --- | --- | --- |
| getNotificationsConfig | GET | /api/notifications/config | t1 | 通知渠道配置 |
| saveNotificationsConfig | POST | /api/notifications/config | t2 | 保存通知渠道配置 |
| listRecentNotifications | GET | /api/notifications/recent | t1 | 最近投递记录 |
| testNotificationChannel | POST | /api/notifications/test | t3 | 测试通知渠道 |

### ui（4 操作）

| 操作 | 方法 | 路径 | 档级 | 说明 |
| --- | --- | --- | --- | --- |
| getUiConfig | GET | /api/ui | t1 | UI 配置（外观+布局+页面） |
| saveUiConfig | POST | /api/ui | t2 | 保存 UI 配置 |
| getPublicUiAppearance | GET | /api/ui/public | t1 | 匿名可达的外观子集（登录页用） |
| uploadBackgroundImage / clearBackgroundImage | POST/DELETE | /api/ui/background | t3 | 背景图管理 |

### debug（5 操作）

| 操作 | 方法 | 路径 | 档级 | 说明 |
| --- | --- | --- | --- | --- |
| listDebugActions | GET | /api/debug/actions | t1 | OneBot action 目录 |
| invokeDebugAction | POST | /api/debug/invoke | t3 | 透传执行任意 OneBot action |
| streamDebugAction | POST | /api/debug/invoke-stream | t3 | 流式透传（SSE 回包） |
| uploadDebugFile | POST | /api/debug/upload | t3 | 上传文件到实例临时目录 |

### streams（2 操作）

| 操作 | 方法 | 路径 | 档级 | 说明 |
| --- | --- | --- | --- | --- |
| streamState | GET | /api/state/stream | t1 | SSE 实时状态流（processes/qq-list/connections） |
| streamLogs | GET | /api/logs/stream | t1 | SSE 实时日志流 |

### 全局配置与备份（4 操作）

| 操作 | 方法 | 路径 | 档级 | 说明 |
| --- | --- | --- | --- | --- |
| getGlobalConfig / saveGlobalConfig | GET/POST | /api/global-config | t1/t2 | 部署级全局设置 |
| exportBackup / importBackup | GET/POST | /api/system/backup/* | t3 | 备份导出与导入 |

## 调用示例

### TypeScript（使用生成的 SDK）

```ts
import { client, login, getStatus, getSystem } from './generated/typescript/sdk.gen.js';

// 配置基础地址
client.setConfig({ baseUrl: 'http://127.0.0.1:5099' });

// 登录
const r = await login({ body: { password: '你的密码' } });
if (r.data?.token) {
  client.setConfig({ auth: r.data.token });
}

// 调用
const sys = await getSystem();
console.log(sys.data?.hostname, sys.data?.memory);
```

### Python（使用生成的客户端）

```python
from snowluma_webui.client import Client
from snowluma_webui.api.auth.login import asyncio as login

client = Client(base_url="http://127.0.0.1:5099")
result = await login.sync(client=client, body=LoginBody(password="你的密码"))
```

### curl

```bash
# 登录
TOKEN=$(curl -s -X POST http://127.0.0.1:5099/api/login \
  -H 'content-type: application/json' \
  -d '{"password":"你的密码"}' | jq -r .token)

# 认证调用
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:5099/api/status
```

## 注意事项

### T3 操作（23 条）

> [!WARNING]
> 标记为 `x-verification-status: destructive-static-only` 的操作**永不自动重放**。
> `/api/debug/invoke` 接受任意 OneBot action 并透传执行——业务面全部 action 目录
> （发消息、改群、封成员）都能经此调用。调用方应默认弹确认框。

### 401 处理

- GET/HEAD：可安全重登并重放原请求（但 `/api/update/check` 例外——它的
  external-fetch 副作用标记意味着重放会打外部版本源）。
- POST/DELETE：**不重放**——重复执行有实际后果（如 config 写入、文件上传）。

### 限速

登录限速 5 次/15 分钟/IP。等待秒数只在中文文案里，无独立字段。
触发后 15 分钟内该 IP 的所有登录尝试均 429。

### SSE 流

四条 SSE 端点（state/stream、logs/stream、debug/stream、debug/invoke-stream）
返回 `text/event-stream`，不是 JSON——不能用 JSON 解析器读。消费方式：
- 浏览器：`EventSource` 或 `fetch` + 流式读取
- Node：`fetch` + `response.body.getReader()`

### 归一化

部分端点的响应有**双形状**（如 GET /api/config/{uin} 的 `{config}` 信封），
适配层按规则表自动解包。直接使用生成 SDK 的调用方需自行处理信封拆包
（规则表：`adapters/rules.json`）。

### 空负载与校验

服务端对空负载/缺键的 POST 一律 400（请求格式错误）。这意味着：
- **400 ≠ 服务端故障**——是调用方负载不合规；
- 带安全负载的重试是安全的（不会重复执行已生效的写操作）。

### 错误分支已验证

以下错误分支在用户生产实例上确认与 spec 一致（一轮全量 sweep）：
- 空负载 400 ×7（各类 POST 写操作）
- confirm 错码 401「当前密码不正确」
- disable/regen 400「2FA 未开启」
- cleanup 非法 scope 400「unsupported cleanup scope」

以上活体形状由 L4 夹具重放钉住（`npm run verify:all -- --fixture`，跑次报告落
`docs/operations/verify-all-report.json`，凭据已脱敏）。

## 相关

| 主题 | 去处 |
| --- | --- |
| 契约真源 | [`spec/openapi.yaml`](../../spec/openapi.yaml) |
| 上游加操作后的全部手续 | [加一条操作](../guides/add-an-operation.md) |
| 三语适配器与统一语义 | [架构与设计概要](../concepts/architecture.md) |
| 活体验证链（L4） | [验证体系](../operations/verification.md) |
| 安全姿态与已裁定豁免 | [安全姿态](../operations/security.md) |
