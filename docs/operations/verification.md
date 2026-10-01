# 验证体系（本地链 / CI / L4 / 冷克隆）

## 三层执行

| 层 | 触发 | 内容 |
| --- | --- | --- |
| 本地一条命令 | 手动 `npm run verify:all` | 全部离线门禁（见 [gates.md](../reference/gates.md)） |
| CI | 每次 push / PR | `.github/workflows/verify.yml`：Windows 与 POSIX 两条 job，各自完整引导 + vendor 重拉 + 三语生成 + gen:check + **同一份离线门禁清单** + 出口闸 |
| 活体 L4 | 本机 `-- --fixture` | 全新一次性上游实例上的 5 条硬要求 |

## CI 的四条 workflow

### verify.yml（主链，windows-latest + ubuntu-latest）

步骤：checkout → setup-node/python/go → `go install oapi-codegen@v2.8.0` →
`npm run venv:bootstrap`（版本从 `tools.lock.json` 读，不在 workflow 里抄）→ `npm ci` →
**`npm run fetch:upstream`（按锚点 SHA 重拉 vendor）** → `npm run generate`（三语全量）→
`npm run gen:check`（跟踪词表逐字节对 HEAD）→ `npm run verify:all` →
`npm run package:clients` → `npm run smoke:clients`（出口闸三层）。
job 级 `PYTHONIOENCODING=utf-8`。
main 受 branch protection：`verify` 检查（context 实测名，不带 OS 后缀）是合入必要条件，
**进 main 的改动一律走 PR，且 CI 绿后必须人工审核合入**（本仓禁用 auto-merge）。

**两条 job 而不是复制清单**：门禁清单只住在 `tools/verify-all.ts` 的 `GATES` 里，
两个 job 都只调 `npm run verify:all`，所以新增一条门禁不会出现"只进了一个 OS"的分叉。
Windows 是主链（长期在跑）；`verify-posix` 是 Linux 的闸，**已跑绿一次**：全部离线门禁 + `gen:check`
+ 两条出口闸都在 ubuntu 上过。要记的是它**第一次首航是红的**——红在出口闸 TS 腿把
`node_modules/esbuild/bin/esbuild` 交给 node 执行（Linux 上那是原生二进制，Windows 上是 JS shim，
所以本机永远看不出来），修完才绿。这一格的历史就是这条 job 的价值：没有它，"POSIX 也能跑"
会一直是一句没闸的断言。两条 job 的 `run:` 序列现在由 `tools/workflow-pins.test.ts` 钉成逐条相等。

`verify-posix` 加出来之前先在 WSL Ubuntu 实测过，抓到两条把 Windows 路径语义焊死在断言里的既有测试
（venv 目录名字面量、`C:\repo\...` 当绝对路径）——这类失效在 Windows-only 的链上是永久不可见的。
本机可验的面：`fetch:upstream` 可用；补上 `generated/typescript` 后全量 vitest 789 passed / 0 断言失败，
唯一红是缺 `generated/go`（本机无 go 工具链，CI 里 generate 先跑）。

**为什么必须有 vendor 重拉步**：`generated/` 与 `vendor/upstream/` 都不入库，
而 drift/ui-coverage/build-anchor 绊线读 vendor——冷克隆不恢复缓存这三条必红。
锁文件明令禁止用 skip/放宽把红变绿，唯一诚实路径是既定恢复命令
（见 [commands.md](../reference/commands.md)）。

### demo-regen.yml（生成面自动回补，ubuntu）

路径过滤：`spec/openapi.yaml`、`tools/gen/**` 变更时触发。
只做冷克隆无 vendor 也能跑的四步（generate typescript → gen:demo → typecheck:demo →
check-vocabulary），产物有差异时自动开 PR（`auto/regen-demo`）。
它**不跑**全量门禁——那是 verify.yml 的事（旧注释里"全量门禁只能本机跑"是重构前的
旧事实，已随文档标准化一并修正为指向 verify.yml）。

### upstream-sync.yml（上游探测，ubuntu；每日 03:17 UTC + dispatch）

跑 `tools/upstream-sync.ts` 判据引擎（本机等价 `npm run upstream:sync`），按判定三分流：
绿类（算术不变）→ 只含 `spec/anchor.json` 的 PR，**等人工审核合入**（本仓禁用 auto-merge）；
红类（计数/端点集合/路径漂移）→ label `upstream-sync` 的工单（同 SHA 幂等更新，锚点不动）；
设施故障（exit 2）→ job 红且**什么都不开**。
dispatch 带 `dry_run=true` 可无副作用预演。设计裁定与判据表见
[upstream-sync](../concepts/upstream-sync.md)。

### release-clients.yml（产物出口，windows；spec/anchor.json|openapi.yaml 变更 + dispatch）

逐字镜像 verify.yml 的引导，区别是 `verify:all` 在这里是**发布前置条件**：
先过闸再打包出厂（三语 SDK tarball + spec/anchor/NOTICE + SHA256SUMS + 血统收据），
tag `clients-<锚点短7位>-<UTC 时间戳>`。任何步骤红则无 Release。

## L4 活体门禁

```bash
SNOWLUMA_FIXTURE_PORT=<空闲端口> npm run verify:all -- --fixture
```

配方（设计口径）：在 `snowluma-live` 检出上拷一份临时实例 → **非 dev 模式 + 随机初始口令**
→ 过同意闸/改密闸 → 跑五条硬要求：门禁矩阵、净零写回、流首帧、SSE 锚点、2FA → 整目录删除。

口令纪律：不进命令行、不进文件——编排器压根没有 `--password` 参数；
轮换口令是脚本常量，秘密只有那个随机初始口令。
`assertPortFree` 先 bind 再验 fetch 可达（顺序反了会让最常见的"端口已占用"多付 1.5s 探测）；
**绝不把探测失败当端口空闲**——那会向别人的实例写 t3。

依赖：本机存在上游运行源码（默认 `../snowluma-live`，`SNOWLUMA_LIVE_ROOT` 可改）。
这就是 L4 不进 CI 的原因：上游本体不入库，结构性豁免。

## 浏览器 E2E 烟雾（`npm run e2e:smoke`，本机专用）

L1–L3 没有一条起真浏览器（L3 挂载用的是 happy-dom），「绿测之后还要真浏览器走一遍」
这条规矩一直靠人工。
`tools/e2e-smoke.ts` 把它自动化：装配点与生产同一处（`collectRoutes()` + `buildHandler()`），
playwright-core 只带 CDP 协议、用本机已装的 Chrome（channel 通道，不下浏览器二进制）。
断言面：登录屏渲染 → CSS 真的被解析（规则数、`--bg` 自定义属性求值、body 落色——
P1「所有 class 悬空」的回归位）→ 登录 → 六个面板各按一个**来自假上游数据的标记串**
判渲染、并判不是「后续任务接入」占位 → 登出回门禁屏 → 全程零 console error /
零 pageerror / 零 ≥400（登录前 `/gate/state`、`/appearance` 的设计性 401 除外）。

假上游的每个响应体逐键抄自 L2 各域健康夹具（口令是脚本里明写的假常量，全程环回）。

**为什么不进 GATES**：九条门禁链必须在任何冷克隆里可跑，这一条腿把成败押在
「本机装着 Chrome」上——装不了浏览器的机器上它是设施故障，而设施故障不得伪装成判定
（与 `upstream-sync` 的 exit 2 同一条纪律）。跑次纪律照常：本机 4 次连跑全绿；
变异「登录喂错口令」⇒ 等 `#tabs` 超时、exit 1。

## 凭据脱敏（入库口的最后防线）

`tools/redact-evidence.ts` 是落盘唯一出口：

- **只替值、保留键与形状**——`{"token":"[REDACTED]"}` 仍然证明"这条操作返回过 token 字段"，
  这正是证据要说的话。
- **幂等**：`[REDACTED]` 不再被任何形状命中。
- **报告只出形状名，永不含秘密值**。

扫描面 = git 跟踪的 `docs/operations/`（跑次报告的落盘目录）。手册页不进扫描面：
契约文档必须原样展示 `password` 一类的带引号值形状（api.md 的登录体就是），
把它们扫进形状表只会逼人给文档加豁免——而豁免名单正是这条防线最想要防的东西。
形状表覆盖的不止双引号 JSON：数组值（`recoveryCodes`）、转义串、query-string、
YAML 无引号行、单引号 JS、大小写不敏感 Bearer、snake_case——每一形都有执行用例。
`npm test` 内三条入库面断言：跟踪面零活凭据、扫到文件数 >0（空面不许静默放行）、
未跟踪债目逐条登记且不许留已清偿条目。

已经提交过的值收不回来（git 历史/备份/克隆），只能轮换——见文件头注。

## 跑次报告

最新一次链跑次：[verify-all-report.json](verify-all-report.json)
（读法与 `gitHead` 的晚一提交约定见 [gates.md](../reference/gates.md)）。

## 相关

| 主题 | 去处 |
| --- | --- |
| 门禁清单的机器行为 | [gates.md](../reference/gates.md) |
| 自动迭代流水线的设计 | [upstream-sync](../concepts/upstream-sync.md) |
| 安全姿态与凭据纪律 | [security.md](security.md) |
