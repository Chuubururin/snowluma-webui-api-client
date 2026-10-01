# 架构与设计概要

## 这个仓库是什么

对 SnowLuma WebUI 管理面（5099 端口）的**契约提取 + 三语言客户端 + 套壳 demo**。
上游本体源码不在仓库里；`vendor/upstream/` 是按锚点 SHA 拉取的 47 份源码副本，
用途是让"spec 说的和上游真源码说的不一致"这件事**机器可检**（drift 门禁）。

四段产物，一条主链：

```
上游源码（锚定 SHA）──提取──▶ spec/openapi.yaml ──codegen──▶ generated/{typescript,python,go}
       │                            │                            │
       │  锚定/哈希                  │  55 操作/47 路径/101 schema │ 类型化 SDK
       ▼                            ▼                            ▼
  spec/anchor.json          门禁消费 spec              adapters/{三语适配器}   demo/server（SDK 唯一装配处）
                                                                                   │ HTTP
                                                            demo/client（浏览器端）──┘
```

## 模块边界（实测 import 矩阵，不是愿望清单）

| 边 | 判定 | 证据 |
| --- | --- | --- |
| `demo/server → adapters/*` | **0 条** | 设计裁定：adapters 的 generic request() 会绕过生成物，而"生成物够用"是 demo 的命题 |
| `demo/server → generated/typescript` | 10 条，全部是 SDK 调用 | 唯一运行时依赖面；`upstream.ts:9` 装配 + 9 个路由文件引 `sdk.gen.js` |
| `demo/server → tools/*` | **0 条** | 生产代码不引开发工具（但它 `readFileSync` spec 派生 UIN_RE/OPERATIONS——文件级单一真源耦合，见下） |
| `demo/client → demo/server / generated` | **0 条** | 浏览器端只走自家 `api.ts` 的 HTTP，跨层为零 |
| `adapters/* → demo/*` | **0 条**（仅 1 条测试边 → `tools/replay`） | 三语适配器独立成库 |
| `tools/* → demo/*` | 非测试边 3 处，全是声明过的门禁消费点 | `check-ui-coverage.ts`、`fixture.ts`、`helpers/demo-http.ts` |
| `vendor/upstream` 运行时读取 | 只在 `tools/`，且 8 个读点全汇于 `tools/lib/upstream.ts` 单模块 | demo/adapters 对 vendor 零依赖 |

## 生成面 / 手写面的判据

**能从 spec 与 SDK 导出集零判断推出的进生成面；需要人做判断的留手写面。**

- 生成面（`npm run gen:demo` 的唯一产物）：`demo/vocabulary.gen.ts` ——
  55 条操作的 operationId / 方法 / 上游路径 / isSSE / isGate / anonymous。
  上游加一条操作 → 词表重生成 → `check-vocabulary.test.ts` 三向相等立刻点名"这条没归属"。
- 手写面：demo 的全部路由与面板。`GET /overview` 聚合 7 路上游、按路降级、
  从外观配置折算轮询周期——这些是**策展出来的客户端行为**，spec 里没有任何 operation 能推出它们。

> [!CAUTION]
> 历史教训（重要，别重蹈）：曾把路由表换成机械生成的 1:1 上游镜像，整只客户端 404，
> 已回退并证伪——**这类路由不可机械生成**；1:1 代理形态正是被明确裁掉的"原始调用台"。

## 单一真源登记

同一个事实全仓只允许存在一份，其余位置都是它的读者：

| 事实 | 真源 | 读者/执法 |
| --- | --- | --- |
| API 契约 | `spec/openapi.yaml` | validate/drift/inventory/ui-coverage、`UIN_RE`（server 现读现构造，读不到就拒启动） |
| 上游锚定 | `spec/anchor.json`（40 位 SHA + 逐文件哈希） | check-drift（读侧形状执法：坏 SHA 拒绝一切声称）。写入者只有两个：`upstream-sync` 绿类 PR（零判断）与人工 `npm run extract <SHA>`（红类处置的一部分） |
| 操作清单 | spec 的 operationId | `OPERATIONS`、词表、parity、declinations 全部派生或对它断言 |
| 非 2xx 折叠 | `unwrap()`（`demo/server/upstream.ts`，全仓唯一） | ui-coverage 断言 7 盯着不许出现第二个折叠点 |
| 路由注册 | `collectRoutes()`（`demo/server/start.ts`，生产装配点） | 完备性门禁断言"门禁可见路由 == 生产注册路由"双向相等 |
| 门禁清单 | `verify-all.ts` 的 `GATES` 数组 | `verify-all.test.ts` 钉住与头注清单逐条同序——只改一边即红 |
| vendor 恢复命令 | `npm run fetch:upstream`（脚本本体 `tools/fetch-upstream.ts`） | `tools.lock.json` 只指路径，不再抄命令 |

## 三语同形

三份适配器（TS / Python / Go）对同一条 bootstrap 门控链（登录 → 同意闸 → 改密闸 → 回环）
和同一套规则引擎负责**行为逐字一致**，包括错误类别：
200 响应体不是对象 ⇒ `protocol` 错；`consentRequired` 而无字符串 `version` ⇒ `protocol` 错。
这条不变量由 golden 夹具（同一份 `cases.json` 喂三语）+ 三套同形用例钉住，
`verify:all` 里 py/go 是两条独立门禁。历史上 Go 曾因 `pm, _ :=` 吞断言失败而 fail-open——
**三语一致性只在三份套件都被同一条链真跑时才成立**。

## 测试分层

| 层 | 形态 | 位置 |
| --- | --- | --- |
| L1 契约 | spec 结构、replay 分级、形状断言 | `npm run validate` / `drift` |
| L2 路由 | 假上游 + 直调 buildHandler，不起真端口 | `tools/demo-*.test.ts` |
| L3 客户端 | happy-dom 挂载 + 状态机 | `tools/demo-*-mount.test.ts` |
| L4 活体 | 全新可牺牲实例上的 5 条硬要求 | `npm run test:fixture`（`--fixture` 才进链） |

## 相关

| 主题 | 去处 |
| --- | --- |
| 上游自动迭代流水线 | [upstream-sync](upstream-sync.md) |
| 门禁链怎么"自己保持绿" | [开发循环](workflow.md) |
| demo 目录的分层与两份账 | [`demo/README.md`](../../demo/README.md) |
| 加一条操作的全部手续 | [加一条操作](../guides/add-an-operation.md) |
