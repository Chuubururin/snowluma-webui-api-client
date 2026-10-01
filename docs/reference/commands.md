# 命令参考

## npm scripts（`package.json` 为唯一清单）

### 生成管线

| 命令 | 做什么 | 注意 |
| --- | --- | --- |
| `npm run generate` | 三语 SDK 全量生成 + 逐语言横幅取证 + 写血统收据 | 半途失败会**删旧收据**（`languages` 记实际成功集，单跑一语言会被 probe 第四道点名） |
| `npm run generate typescript\|python\|go` | 单语言腿 | 会把 `.provenance.json` 改成单语言收据，`probe` 随即红——恢复就是跑全量 `generate` |
| `npm run gen:demo` | 重出 `demo/vocabulary.gen.ts` | 唯一生成面产物 |
| `npm run venv:bootstrap` | 建 `.venv-gen` 并装 `openapi-python-client` | 版本读 `tools.lock.json`；venv 目录按平台解析；系统解释器名试 `python`/`python3` |
| `npm run oapi:install` | 装 oapi-codegen（`go install`，版本读 `tools.lock.json`） | 同上一条同源：CI 与本仓都调这条，workflow 里不许留版本号抄本（`tools/workflow-pins.test.ts` 执法）；go 不在 PATH 时按锁记 GOROOT 借 |
| `npm run probe:py-import` | 用 venv 解释器跑 `tools/gen/probe-import.py` | 走 `tools/py-venv-run.ts`；venv 缺席带指引退 1，**绝不静默跳过** |
| `npm run package:clients` | 把生成码 + 三语适配器合成三个自包含工件目录（`dist/clients/`） | 缺输入面退 2 并点名 `npm run generate`；TS 腿出 `dist/`（无扩展名导入不能直发源码） |
| `npm run smoke:clients` | 出口闸：仓外真装 / 声明的入口解析 / 示例真跑 | **Release 前置闸 + CI 两个 job 都跑**；不在离线 GATES（要装包取依赖，会破"离线"性质）；设施缺件退 2 与判定红退 1 分开 |
| `npm run gen:check` | gen:demo + `git diff --exit-code` 只比 `demo/**.gen.ts` | 幂等 + "跟踪词表不可手改"检查；**verify.yml 每次 push/PR 强制执行**。注意牙齿在已提交面：工作树手改会被重发覆盖，只有把不一致的词表提交进去才红。词表完备性另由 check-vocabulary 在 `test` 门禁内钉 |
| `npm run fetch:upstream` | 按 anchor 的 40 位 SHA 重拉 `vendor/upstream/`（12 次批级重试、坏锚点拒用、内建 ipv4first） | `tools.lock.json → prerequisites.fetchCommand` 就指这条 |
| `npm run upstream:sync` | 判据引擎：探测/判定上游候选 SHA 能否零判断推进锚点（五分类，exit 0=有判定 / 2=设施故障） | 与 CI `upstream-sync.yml` 同一条入口；`--candidate <40hex>` 指定候选、`--json <path>` 落判定、`--commit-anchor` 仅绿类落盘。设计见 [concepts/upstream-sync.md](../concepts/upstream-sync.md) |

### 门禁（单条跑；编排见 gates.md）

| 命令 | 证明什么 |
| --- | --- |
| `npm test` | vitest 全量（L1 契约/L2 路由/L3 挂载 + 门禁自身的测试） |
| `npm run validate` | spec 结构、replay 分级、流端点判语 |
| `npm run drift` | 上游锚定面 × spec 双向零缺口；锚点形状与哈希读侧执法 |
| `npm run extract <40位SHA>` | 重建 anchor——**从不联网**，只哈希已有缓存；先 fetch 再 extract |
| `npm run inventory` | 分面清单与 spec 同源 |
| `npm run ui-coverage` | 七条断言 + 三分区对账，未登记必须为 0 |
| `npm run typecheck:demo` | demo 与测试面类型干净 ⇒ 55 条调用真走生成 SDK |
| `npm run probe` | generated 缺席时全仓仍干净 + 三家产物各自类型面 + `probe.py` 契约探针 |
| `npm run test:py-adapter` / `test:go-adapter` | 三语同形的两条独立腿（Go 启动器读 `tools.lock.json` 借 GOROOT，找不到就带指引退 1，绝不 skip） |

### 运行

| 命令 | 做什么 |
| --- | --- |
| `npm run demo` | 起控制台（默认 6097，只绑 127.0.0.1） |
| `npm run verify:all` | 离线门禁编排（条数以该命令输出为准），报告落 `docs/operations/verify-all-report.json` |
| `… verify:all -- --fixture` | 追加 L4 活体一条（全新一次性上游实例） |
| `npm run fixture:up` / `fixture:down` | 手工起/停夹具实例 |
| `npm run e2e:smoke` | 浏览器 E2E 烟雾：真 Chrome × 真 demo 装配点 × 形状按 spec 的假上游，走查七屏与 CSS 落地（**本机专用，不进 GATES**，理由见 [verification.md](../operations/verification.md) E2E 节） |
| `npm run integrity <报告> [HEAD] [段名…]` | 工作树干净 + 产物不入库 + 报告结构三合一复核（git 命令故障时拒报"干净"） |

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `SNOWLUMA_DEMO_PORT` | `6097` | demo 监听端口 |
| `SNOWLUMA_DEMO_BASE_URL` | `http://127.0.0.1:5099` | 目标上游实例 |
| `SNOWLUMA_STRICT_SSRF` | 未设 | `=1` 时目标地址只许公网类（环回/私网/链路局部/NAT64 内嵌等全拒，判据见 security.md） |
| `SNOWLUMA_FIXTURE_PORT` | `5299` | L4 夹具端口（必须 1024–65535 整数，import 期校验） |
| `SNOWLUMA_LIVE_ROOT` | `../snowluma-live` | 夹具取上游运行源码的检出位置 |
| `PYTHONIOENCODING` | — | Windows 手工跑中文输出的 python 腿时设 `utf-8`（CI 已 job 级设好） |
| `GOTOOLCHAIN` | 脚本内钉 `local` | 禁止 go 自行换工具链，版本只认 `tools.lock.json` |

## 生成器版本（`tools.lock.json` 记录，跑前对表）

- hey-api `@0.99.0`（peer `typescript@5.9.3` 硬约束——裸取 peer 会拿到 TS7 并在 import 期崩）
- openapi-python-client `0.29.1`（venv `.venv-gen`）
- oapi-codegen `v2.8.0`（config 里的 user-templates 覆盖头部模板）

## 相关

| 主题 | 去处 |
| --- | --- |
| 门禁编排的机器行为 | [gates.md](gates.md) |
| CI 全链 | [验证体系](../operations/verification.md) |
| API 契约 | [api.md](api.md) |
