# RoadMap

开发方向登记处：已登记、未认领的项在此列明；**已裁定的"不做"不占这里的行**
（那本账在 `demo/declinations.ts` 与 `docs/operations/security.md` 的豁免表）。
认领方式：开 issue 或直接提 PR（流程见 [CONTRIBUTING.md](CONTRIBUTING.md)）。

## 待认领

| 项 | 背景与出处 | 落点 |
| --- | --- | --- |
| 云扫终态人工消费 | 整仓通道已查实并跑通提交（`~/.qodersec/bin/qodersec.exe scan --platform qoder --all`；对照实验单文件提交也通）。**两次同步重跑的云端终态都是 `canceled`**，而 CLI 照样打印 "No security issues found."——canceled 的 0 发现按口径不算数（缺席非干净）；本地四条取数通道（CLI 结果子命令、同步轮询、浏览器、qodercli 直连）全部实测不可用 | 操作者登录 qoder.com 的 Qoder Security 控制台，读最近一次整仓扫描报告的终态与发现清单；红项按 `docs/operations/security.md` 末节口径逐条开判，然后销本行 |
| 变异台账的"新执法点必须有红证"自动化 | 二轮评审提出：AGENTS.md 要求每条新执法点做一次变异检验，但现在这条只靠人遵守，台账本身是往回看的记录。难点在于**朴素做法会自证**：让门禁比对"本页执法点表 ↔ 本页台账表"，两张表都在同一份文档里，一起删就一起绿，等于没闸。可行的起点是把发现面换成文件系统（如"每个 `tools/*.test.ts` 必须在某处被登记"），但代价是把普通单元测试也拖进登记义务 —— 未裁定做法 | 认领人先回答"发现面从哪来、不拖谁下水"，再写门禁；写出来必须自带一条咬得动的变异 |
| `upstream-sync` 深面首次真跑 | schedule 已经自跑过、判定 `no-change`（判据与"哪些代码路径仍未被触及"见该页"每日触发观察"节）：短路面上 `httpFetcher` / `buildAnchorFromDir` / `classify()` 三层比较一次都没跑到 | 上游真的动过一次之后，按五分类判据表复核那一轮并落证据；不许为了摸到深面而手改 `spec/anchor.json` |
| 私密漏洞报告的启用状态无人能复核 | `SECURITY.md` 原先写着"仓库已启用私密漏洞报告"，但这一项 REST 侧读不到（GET 只有开关类端点，私密报告只在仓库设置页可见）。现口径改成"不声称已启用 + 给一条当下可执行的兜底通道" | 所有者在仓库 Settings → Advanced Security 勾选 *Private vulnerability reporting*，然后把 `SECURITY.md` 那条兜底降级为备注；这是平台侧一次性动作，代码里做不了 |
| workflow 的 action 钉到提交号 | 全部 `uses:` 现在是浮动 tag（`actions/checkout@v4` 等），第三方 `peter-evans/create-pull-request` 还持有 `contents: write`。行业口径是钉全长度 SHA | 等 Dependabot 那批 action 升级 PR（`from 4 to 7` 一类）合完再动，否则两边在同一行上打架；钉完由 dependabot 的 github-actions 生态继续维护 |
| `verify-posix` 目前不是 required context | 分支保护实测只等 `verify`，于是那条 Linux 腿可以红着合入——而它存在的意义正是"POSIX 也有机器证据"（`tools/workflow-pins.test.ts` 钉的是步序相等，不是合入门槛） | 所有者把 `verify-posix` 加进 required contexts；先确认它连续绿，否则 main 会被一条偶发网络红的 job 卡死 |
| Release 工件的签名与出处证明 | 现在有 `SHA256SUMS.txt` + `provenance.json`，且发布链会回读已上传资产核对校验和（同源自证的那一半补上了）；缺的是**外部可验**的签名/attestation——校验和被担保的字节与它同源，签名才不是 | 用 `actions/attest-build-provenance` 对三语 tarball 出 GitHub attestation（需 `attestations: write` + `id-token: write`），消费者用 `gh attestation verify` 复核；做完把命令写进工件 README |
| 契约元数据深面（示例 / 格式收窄 / 枚举收窄） | 出口闸与文档面已就绪，但 `spec/openapi.yaml` 里 `example:` 一处都没有、时间字段既有 `string` 也有 epoch 数字、`setLogLevel.level` 是自由 `string` 而同文件的 `LogLevel` 就是枚举——agent 只能靠散文猜 | 每一条都要先在 `snowluma-live` 的上游源码里取到证据再写：类型收窄会改三语客户端签名，属契约变更（走 `info.version` 判级 + 全量 `npm run generate`）；没有证据就不写，编一个键等于测试全绿而真实例永远显示占位符 |
| 大文件与静默 catch 的分诊 | `tools/validate-spec.test.ts` 等几个文件已经长到不利于单点审阅；`tools/`、`demo/`、`adapters/` 里还有若干空 `catch`，形状上是"把没验当验过"的候选 | 逐条读：确属"吞掉设施故障"的改成点名红，属正当降级的写明理由；拆分只在职责真的混杂时做，不为行数而拆 |

## 已裁定不做（防止反复重提）

| 决定 | 理由 | 记录处 |
| --- | --- | --- |
| L4 活体门禁进 CI | 上游本体不入库 + 口令不进 CI，结构性豁免 | `docs/operations/verification.md` |
| 路由表机械生成 | 已试过并证伪（一次迁移导致整客户端 404，随即回退并补门禁）：面板路由是判断产物 | `docs/concepts/architecture.md` 生成面判据节 |
| 发布到包管理器（npm/PyPI/Go module registry） | 许可口径，见 `spec/NOTICE.md`。**注意口径边界**：不发 registry ≠ 不生成 package metadata —— 工件带 `package.json` / `pyproject.toml` / `go.mod` 只为让消费者**本地安装**，不构成发布 | 同左 + [release-consumer-readiness.md](docs/concepts/release-consumer-readiness.md) |
