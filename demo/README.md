# SnowLuma 轻量客户端 demo（重做版）

参照物是 SnowLuma 自带的 5099 WebUI。目标写在设计口径：**屏幕与面板级对齐**——
真 WebUI 有的每一屏、每一个控件替它调哪些操作，这里都要有；不做的是视觉系统本身
（主题变量、自定义 CSS、挂件布局编辑器——全部登记在 `demo/declinations.ts`）。

启动：`npm run demo` → http://127.0.0.1:6097（**只绑环回**：这个进程持有操作者口令）。
前置：目标实例在跑（默认 `http://127.0.0.1:5099`，登录页可改址）。
端口约束：目标端口不能落在 WHATWG fetch 的 bad-port 表上（1719、2049、5060、6000、6665-6669、
6697、10080……）——那种端口 bind 得成、`python`/`go` 客户端也连得上，但本 demo 走的 fetch
会在连接之前直接拒掉，报 `fetch failed`。夹具侧同一判据（`tools/lib/port-probe.ts`）。

## 分层

```
demo/
  dashboard.ts            6 行入口 shim：端口与启动，实现全在 server/
  server/
    upstream.ts           生成客户端的唯一装配处（地址 / token / fetch 注入缝 / unwrap 唯一折叠点）
    http.ts               路由表骨架、ok/fail、gateGuard、gateDispatch
    assets.ts             把 client 侧 .ts 用 esbuild 只剥类型后发给浏览器（见"无构建步骤"）
    index.ts              请求分发与静态装配
    start.ts              collectRoutes()：八张表拼成一张，加一块删一块，不留两份
    account-presence.ts   账号存在性判据（uin 必须在 listQq 里）；不在 routes/ 是因为那目录只准放路由表
    routes/{gates,overview,processes,config,logs,settings,debug,streams}.ts
  client/
    app.ts                哈希路由 + 面板切换 + 标签页跳转
    api.ts                浏览器侧唯一的上行口
    state.ts              三条流的状态机（看门狗、重拨、慢速对账）
    ui.ts                 共用的 DOM 小件
    pages/{gate,overview,processes,config,logs,settings,debug}.ts
  vocabulary.gen.ts        操作词表（生成面唯一产物，`npm run gen:demo`，勿手改）
  parity.ts               面板→控件→操作对照表（单一事实源之一）
  declinations.ts         放弃清单（单一事实源之二）
```

七屏：`gate`（登录 / 同意 / 改密三段）、`overview`、`processes`、`config`、`logs`、`settings`、`debug`。
55 条操作**全部**经 `generated/typescript/sdk.gen.ts` 调用；本目录里没有任何手写 URL 的上行口
（`npm run ui-coverage` 的断言 6 就是抓这个的）。

## 生成面与手写面的分界

判据只有一条：**能从 spec + SDK 零判断推出的进生成面，需要人做判断的留手写面。**

- **生成面**：`npm run gen:demo`，唯一产物 `demo/vocabulary.gen.ts` —— 55 条操作的
  operationId / HTTP 方法 / 上游路径 / 是否 SSE / 是否门禁 / 是否登录前可读。
  它是手写面里那些 operationId 清单的词表来源：`check-ui-coverage.ts` 的流操作集、
  以及 `tools/check-vocabulary.test.ts` 的完备性断言，都从这张表读，不再手抄。
- **手写面**：服务端路由、客户端面板、门禁流程、流状态机。

**路由不生成，这是试过并证伪过的**（曾把 `start.ts` 的路由源换成生成的 `.gen.ts`，
结果是整只客户端 404 而全部测试仍绿；随即回退，并补了两条钉在生产装配点上的门禁）。
原因不是实现没写完，而是尺子用错了：demo 的端点表达的是判断——

- `GET /overview` 并发聚合 7 路上游、按路把失败折进 `errors.<key>`、再从
  `ui.config.appearance.pollInterval` 折算出 spec 里根本不存在的 `systemPollMs`；
- `POST /process-action` **故意不套 `{data}`**，套了就把 200 里的 `success:false` 吞成成功；
- `GET /backup-export` 的上游 200 一个键都没有，响应里那四个键全由 demo 造。

生成的极限只能是 1:1 上游代理，而那正是已被删掉的 API 调用台形态
（`api-call` 至今在 `FORBIDDEN_ROUTES` 里）。要让声明文件表达上面那些判断，
它就不是映射而是编程语言。

所以"spec 变了 demo 自动补全"这件事仍然成立，只是落点不同：**上游加一条操作后，
重跑 `gen:demo` 更新词表，完备性门禁会点名"这条操作没有归属"**，人工要补的是一条判断
（`parity.ts` 的一条边，或 `declinations.ts` 的一条放弃记录），而不是任何清单文件。

### 这条链在 CI 上跑到哪一步

`.github/workflows/demo-regen.yml` 只跑四步：装 TS SDK → `gen:demo` → `typecheck:demo` →
`check-vocabulary.test.ts`。它**不跑** `npm test` / `ui-coverage` / `drift`：那三条要读
`vendor/upstream` 与 `generated/python|go`，而两者都不入库，冷克隆里必然红（本机把 `vendor/`
与 python/go 产物挪走后实测：`ui-coverage` 的断言 2 解不到 17 条 Tier A 出处，`npm test` 有
5 个文件 77 条用例栽在 `upstream-guards` 的 ENOENT）。**九条离线门禁的全量链由另一条
workflow `verify.yml` 每次 push/PR 强制**（同为冷克隆，先按锚点重拉 vendor）；
要连 L4 活体一起跑就在本机 `npm run verify:all -- --fixture`。

`gen:check` 也只比 `demo/**.gen.ts`，不比整个 `demo/`：它回答的是"产物与 spec 是否同步"，
不是"你有没有未提交的改动"。曾经就是 `git diff --exit-code demo/`，于是改一行 README 也会
把它判红，而它真正该抓的那件事反而没人看。

## 无构建步骤与 esbuild 剥类型的关系

浏览器不认 TypeScript，而这个 demo 没有打包阶段。做法是：服务端在响应 `/app.js` 时用
`esbuild.transformSync(text, { loader: 'ts' })` **只删类型标注**，不做类型检查、不做转译目标降级。
所以：

- 类型正确性**不在运行时保证**，由 `npm run typecheck:demo` 保证（那是链上的一条门禁）；
- 浏览器里跑的代码与仓库里的 `.ts` 逐字同源，改完刷新即可，没有"忘了重新构建"这种状态；
- 也正因为 esbuild 只删标注，`import type` 与泛型参数在产物里是干净消失的——
  任何想靠"运行时抹掉类型"来省掉 typecheck 的想法都不成立。

## 两份清单怎么读

`demo/parity.ts` 的每一行是一条**边**：某个面板替真 WebUI 的哪个组件，覆盖了哪些 operationId。

- `webui` 是 `文件:行号`，行号必须落在**实码符号行**（组件声明行 / JSX 起始行 / tab 容器行），
  不许用 `:1` 或注释行占位——这张表是后续面板任务的抄写模板，假出处会被复制放大。
- `effect`：`effective` 有控件且行为真的生效；`write-only` 写回成功但 demo 不据此渲染
  （成对登记在 declinations 里，不然就是缺陷）；`none` 没有控件（须另登记 `not-surfaced`）。
- `merge`：写路径的负载语义。`full` = 整份覆盖，客户端必须先读、深合并、再整份发回；
  `partial` = 服务端分节合并。**没有请求体的操作不许申报 merge**——那是一个任何断言都证伪不了的假声明。

`demo/declinations.ts` 是"决定不做"的账：六类 `kind`，每条带 `webuiSource` 出处、理由、裁定人、可逆性。
**未登记的缺口 = 缺陷**，门禁把"未登记"计数断言为 0。

出处分层（`tools/lib/reference-tier.ts`）：Tier A = 引用落在锚定面内、本仓 vendor 有 pinned 副本，
于是"该行 ±5 行内真的有那个符号"是可执行断言；Tier B = 只能读仓外工作树，
**只许作说明性出处，不得作豁免依据**。

## 测试分层与怎么跑

| 层 | 命令 | 打的是谁 |
| --- | --- | --- |
| L1 契约 | `npm test`（含 `tools/validate-spec.test.ts` 等） | spec 自身与三家生成物 |
| L2 路由 | `npm test`（`tools/demo-*.test.ts`） | demo 服务端路由，打在假上游上 |
| L3 客户端 | `npm test`（`tools/demo-*-mount.test.ts`、`demo-state`、`demo-streams`） | 浏览器状态机与挂载 |
| L4 活体 | `npm run test:fixture` | **全新一次性非 dev 实例**（设计口径配方） |
| E2E 烟雾 | `npm run e2e:smoke` | 真 Chrome（本机安装，playwright-core channel）× 生产装配点 × 形状按 spec 的假上游；**不进 GATES**，理由见 [verification.md](../docs/operations/verification.md) E2E 节 |

链本身是一条命令：`npm run verify:all`（加 `--fixture` 连 L4 一起跑，报告落
`docs/operations/verify-all-report.json`）。清单定义在 `tools/verify-all.ts` 的 `GATES`，
由 `tools/verify-all.test.ts` 钉住"设计口径点名的每条门禁都在、每条点名的脚本与文件都真的存在"。
收口只看一个数：**任一条红、或清单为空 ⇒ 退出码 1**（空清单也算红：一条都没跑却写"全部通过 ✓"，
和"扫到 0 个文件却报齐备"是同一形状）；报告落盘前过 `redactJson`，因为 L4 那条的原文里可能带着
上游回给夹具的 token。

L4 默认 skip，**skip 不是通过**：它需要一个真实例，而"拿一台已配置好的实例跑"正是设计口径
第 3 条禁止的事——两闸早就是 false，缺陷会被实例状态掩盖。夹具因此主动从环境里**删掉**
`SNOWLUMA_DEV_MODE`（它禁改密与 2FA）和 `SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD`（它把
`mustChangePassword` 直接写成 false），并在起进程后自证两闸都是 true。

```bash
npm run fixture:up      # 只打印地址，不打印口令；Ctrl-C 即销毁
npm run fixture:down    # 清扫临时目录里遗留的 snowluma-fixture-* 目录（有意不杀进程）
```

## 安全约束（实现里的形态，不是口号）

- **T3 永不自动重放**。整份覆盖、清理、上传、备份导入这些只在操作者显式点击时发一次；
  demo 不做"读后即还原"那类自动写回（上一版这么做，它把写副作用留给了真实例）。
- **同意绝不代做**：`recordConsent` 只在勾选框被真人点过之后发，`version` 原样回传 `getAgreements` 读到的那份。
- **口令只进服务端内存**：浏览器提交一次，之后改密那步的 `oldPassword` 由服务端注入，
  浏览器永不回传凭据，也不写 localStorage。
- **门禁两键各读各的**：403 的 `consentRequired` 与 `mustChangePassword` 是两个分支，
  只认一个就会把另一道闸静默打开；折叠点唯一（`unwrap` + `gateDispatch`）。
- **换目标地址 = 会话与门禁状态同进同退**（`POST /set-base-url` 会 `clearGateState`），
  否则就拿上一台的判断给这一台放行。

## 与旧版的关系

旧版有三代（`panel.mjs` 原始转发台 → `sdk-panel.ts` 毛坯调用台 → `dashboard.ts` 九 Tab 面板），
最后一版页底还挂着"API 全景调用台"。那一块在 v5 重做时整块删除：把 55 个操作当 API 端点摆出来
不是客户端功能。连带删掉的还有 `/run-all`、`/sse-sample`、`/upgrade-edges` 三个只服务旧编排器的
sweep 端点——所以 `tools/verify-all.ts` 里那三条 HTTP 腿在重做中必然跑不通，重做时已把它
改成离线门禁链 + 可选 L4。覆盖面现在的判据是"每个操作都能从 UI 走到"，由 `npm run ui-coverage`
的七条断言静态执法，而不是"有没有一个按钮能把 55 条全按一遍"。

## 相关

| 主题 | 去处 |
| --- | --- |
| 上游自动推进锚点 | [docs/concepts/upstream-sync.md](../docs/concepts/upstream-sync.md) |
| 门禁链机器行为 | [docs/reference/gates.md](../docs/reference/gates.md) |
| 加操作手续 | [docs/guides/add-an-operation.md](../docs/guides/add-an-operation.md) |
