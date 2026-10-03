# 代理须知（治理不变量）

本文件只列"踩过才知道"的约束与不许自行裁定的边界。安装、用法、API 细节在
[README](README.md) 与 [docs](docs/README.md)，这里不复述它们——复述就会有两份真相。

## 真源在哪（改派生面 = 造第二真相）

| 事实 | 真源 | 派生面（不许手改） |
| --- | --- | --- |
| API 契约 | `spec/openapi.yaml` | `generated/**`、`docs/reference/api.md` 的形状描述 |
| 契约版本 | `spec/openapi.yaml` 的 `info.version` | 三份工件 metadata、Release tag |
| 操作清单与计数 | `spec/openapi.yaml`，经 `npm run inventory` 现出 | 任何写进文档的绝对数字 |
| 归一化规则表 | `adapters/rules.json`（三语共用一张） | 工件内的内嵌副本（打包期生成） |
| 工具链版本与安装位置 | `tools.lock.json` | workflow 里的 `pip install`、`go install` |
| venv 解释器目录 | `tools/gen/run.ts` 的 `VENV_BIN_DIR` | 任何 `.venv-gen\Scripts` 字面量 |
| Go 工具链定位 | `tools/lib/go-toolchain.ts` | 各脚本自己探测 PATH |
| demo 词汇表 | `demo/vocabulary.gen.ts`（`npm run gen:demo` 出） | 手抄的端点/操作列表 |

## 门禁与"红了怎么办"

- 日常验收只有一条命令：`npm run verify:all`（清单与每条证明什么见 [gates.md](docs/reference/gates.md)）。
- 红了先执行它打印的原话恢复动作，处置表见 [troubleshooting.md](docs/guides/troubleshooting.md)。
- **不许**：放宽或删改任何门禁、跳过某条或某门语言、把断言红解释成环境问题后继续推进、
  用"测试全绿"代替"验证过"。
- 新增或修改任何执法点，必须做一次变异检验：把执法点删掉或把失败分支改成静默通过，
  确认点名用例真的变红，再把红/绿原文写进报告。全绿本身不是证据。
- 退出码不要经过管道读取（`cmd | tail` 取到的是 `tail` 的码）。

## 不许你（代理）自行裁定

- **红类上游漂移**（`count-drift` / `operation-set-drift` / `path-broken`）属人工判断：
  不得擅自往 `spec/openapi.yaml` 加 operation、不得改 `spec/anchor.json`、不得自行抬契约版本。
  自动推进只允许发生在 `green-advance`（算术不变，只换锚点）。
- demo 的路由表**禁止机械生成**：判据见 [architecture.md](docs/concepts/architecture.md)。
  这条路试过并证伪过一次（一次迁移让整只客户端 404）。
- 非幂等写（POST / DELETE）遇 401 **永不自动重放**；T3 档操作不得自发执行；
  凭据不进命令行、不进文件、不进提交。活体验证只允许全新一次性环回夹具，
  永远不要把目标指向生产实例。口径要分清：`verify:all` 的离线门禁**不发 HTTP**；活体那一腿只有
  加 `--fixture` 才起一次性环回实例，而把目标指向一个真实实例要显式声明它可牺牲
  （判据与命令见 [verification.md](docs/operations/verification.md)）。
- 交付判据是"调用方能 import 并真的调用"，不是"类型一致"或"构建通过"。
  客户端代码改动后必须在真浏览器里走一遍（见 [verification.md](docs/operations/verification.md)）。
- 合入口径：不得直推 `main`，不得开 auto-merge；required check 绿也不等于可合，需人工审核。

## 文档与注释口径

- 不写日期、历史提交号、PR / 扫描 / run 流水号，也不写 `§N` 式的过程文档指针。
  豁免面（属功能数据）：上游锚点 SHA、cron 时刻、测试夹具时间戳、Release tag 的 UTC 时刻、锁里的 sha256。
- `tools/` 与 `spec/fixtures/` 下每个入库文件前 12 行必须带许可横幅（`tools/workspace.test.ts` 执法）；
  JSON 无注释位，由 `spec/NOTICE.md` 覆盖声明。
- 页内链接与 `npm run` 脚本名必须真实存在（`tools/docs-index.test.ts` 执法）；
  新加文档页必须同时挂进 [docs/README.md](docs/README.md) 的导航表，否则该门禁变红。
- 计数不手抄：需要数字就写"由 `npm run inventory` / `npm run verify:all` 现出"。

## 出口工件（Release）

- 工件是**合包**：生成码 + 行为适配层 + 规则表 + README + 可执行示例 + package metadata。
  只发生成码等于把本项目最关键的一层留在仓里。
- 不发布到 npm / PyPI / Go module registry。这不等于不许生成 package metadata：
  metadata 是给消费者**本地安装**用的，不是发布动作（口径见 `docs/concepts/release-consumer-readiness.md`）。
- Go 工件是本地 module（`go work use`），module id 留在保留域，**不许**改成可远程获取的路径。
- 出口闸 `npm run smoke:clients` 三层判据：装得上 / 入口对 / 用得动。只到第一层就是假绿。
  它不在离线 GATES 里（要装包取依赖，会破"离线"这条性质），但在 Release 前置闸与 CI 里。

## 相关

| 主题 | 去处 |
| --- | --- |
| 怎么加一条操作 | [add-an-operation.md](docs/guides/add-an-operation.md) |
| 上游自动迭代与人工边界 | [upstream-sync.md](docs/concepts/upstream-sync.md) |
| 安全姿态与已裁定豁免 | [security.md](docs/operations/security.md) |
| 贡献流程与提交纪律 | [CONTRIBUTING.md](CONTRIBUTING.md) |
