# 更新日志

本仓遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 口径，
版本号语义化（SemVer）。发版工件由 release-clients workflow 在契约变更时产出；
本文件记录仓库自身的 notable 变更，人工维护。

## [Unreleased]

### Added
- 门禁 `tools/dead-control.test.ts`：workflow 的写动作必须有够得着的 `permissions`、
  dependabot 声明的每个生态都要在该 directory 有跟踪在 git 里的清单、`${{ }}` 不许插进 `run:`。
  三条都来自实测的"声明了但不生效"，不是预防性设计。
- 门禁 `tools/governance-docs.test.ts`：把 AGENTS.md 的四条禁令首次落到治理面
  （README / CHANGELOG / SECURITY / CONTRIBUTING / RoadMap / docs）。判据全部来自活源：
  分面计数与 `spec/openapi.yaml` 现出的值比对、门禁条数与 `GATES` 比对、锚点短码与
  `spec/anchor.json` 比对、CHANGELOG 的 tag 链接与 `git tag` 比对。
- 生成面 `docs/reference/operations.gen.md`（`npm run gen:docs`，由 `gen:check` 钉新鲜度）：
  逐条操作清单不再手写。
- `npm run test:py-adapter` 改由 `tools/run-py-tests.ts` 用 `unittest discover` 现出测试文件；
  发现面为空按设施故障退 1。
- `.github/workflows/security-posture.yml`：PR 与每日跑 `npm audit`（high 及以上即红）与
  PR 新增依赖审查。刻意独立于 `verify:all`（那条链的性质是离线可跑）。
  它起初还带一条"Dependabot 告警汇总"腿，那条腿结构性不可能工作，见 Fixed。
- 发布链新增回读校验：从 Release 下载已上传资产，逐条核对 `SHA256SUMS.txt`。
- 契约补全分面声明：原先五个 tag 在 operation 上使用却未在顶层 `tags` 声明，现在十个都声明并各带一句
  职责描述；`validate-spec` 加 `UNDECLARED_TAG` / `UNUSED_TAG` / `TAG_DUPLICATE` / `TAG_ENTRY_INVALID`。
- dependabot 增加 gomod 生态（`/adapters/go`）；删掉无可解析清单的 pip 项。
- 仓库设置：依赖漏洞告警与 Dependabot 安全更新已开启（复核命令写在 `SECURITY.md`）。

### Fixed
- `demo-regen.yml` 全文没有 `permissions`，而仓库默认权限是 read —— 它最后一步开 PR
  在结构上不可能成功，只因触发条件从未命中而一直没红过。同时补 `timeout-minutes`，
  并把触发面收到 `main`。
- `upstream-sync.yml` 与 `release-clients.yml` 把 `${{ }}` 直接插进 `run:` 的脚本注入面。
- 两条自动开 PR 的 workflow 此前承诺"由 `verify` 冷克隆复验把关"，但默认 `GITHUB_TOKEN`
  开的 PR 不触发 `pull_request` 运行（GitHub 防自激规则）——现在正文与文件头都写明
  审核前先推一个空提交把检查踢起来。
- `docs/reference/api.md` 的分面操作表已与契约分叉且少列若干操作：整块改为生成面，
  手写那张删掉。
- `CHANGELOG.md` 的两个链接指向 `v0.1.0`——那个 tag 在远端从来不存在（`releases/tag/v0.1.0`
  即使在本地补一个同名 tag 也是死链：该形状不在发布链产出的 tag 形状里，且没有对应 Release）。
  现改为指向发布链实际产出的 0.1.0 基线 Release。
- `SECURITY.md` 原先给的两条漏洞上报通道都是死的（私密报告状态无从复核、兜底指向
  `CONTRIBUTING.md` 里并不存在的联系方式）；现改为不声称未验证的开关 + 一条当下可执行的兜底。
- `docs/operations/verification.md` 抄写的 CI 步骤清单（含一条本仓门禁禁止出现的
  `go install …@版本` 形状）改为指向 workflow 真源；Release tag 形状在两页文档里补齐契约版本段。
- `AGENTS.md` 关于活体目标的口径收紧：离线门禁不发 HTTP，活体只在 `--fixture` 下起环回夹具。
- 根级 `spike/` 的预研记录挪进 `docs/concepts/` 并挂上导航（原先是无人导航的跟踪文档）。
- `security-posture.yml` 的 Dependabot 告警汇总步在 CI 里回 403，且**授权位不是缺的那一环**：
  补上 `security-events: read` 后 runner 打印 `SecurityEvents: read`，端点仍回
  `Resource not accessible by integration`。该步已删（留着它就是一条人人该忽略的红），
  并由 `tools/dead-control.test.ts` 的禁令表钉住不许凭"加了权限"把它请回来；
  禁令表每条自带命中正例，防的是禁令正则写坏成空转。
- `verify` 两条 job 的默认浅克隆不拉 tag，于是"CHANGELOG 的 tag 链接必须可解析"那条断言
  的量具在 CI 里是空集——每条链接都判死，报出来像"文档全烂"、实际是"没有可比对象"，
  而这两者的恢复动作完全相反。现补 `fetch-depth: 0`，并让门禁自己区分这两种红。

## [0.1.0] — 首个公开基线

### Added
- 契约层：`spec/openapi.yaml`（55 操作 / 47 路径 / 101 schema），从上游源码提取，
  与锚定面（`spec/anchor.json`，47 份文件哈希）双向零漂移。
- 三语客户端：TypeScript（hey-api 0.99.0）/ Python（openapi-python-client 0.29.1）/
  Go（oapi-codegen v2.8.0）生成，逐文件许可横幅与血统收据。
- 统一适配器：TS / Python / Go 三份行为逐字一致（bootstrap 门控链、401 分治、
  destructive 闸门、规则引擎单源三实现），golden 夹具三语同题。
- demo：七屏套壳控制台，55 条操作三分对账（生效 / 写而不生效 / 登记放弃），
  未登记缺口恒为 0。
- 验证体系：L1–L4 四层测试（用例数以 `npm run test` 现出，本页不抄）、离线门禁一键编排（`verify:all`，
  清单与条数以 `tools/verify-all.ts` 的 `GATES` 为准）、
  L4 活夹具五条硬要求（本机）、变异检验台账。
- CI：verify 主链（windows-latest 全工具链引导）、词表重生成开 PR、
  每日上游探测（零判断自动推进 + 红类开工单）、契约变更发三语 Release 工件。

### Security
- SSRF 面硬化：`SNOWLUMA_STRICT_SSRF` 严格模式 + IPv4-mapped IPv6 归一化；
  `classifyHost` 的已知残余（废弃 IPv4-compatible 形）登记在[安全姿态页](docs/operations/security.md)
  的"内嵌 IPv4 提取"一节。
- 证据脱敏防线：20 种凭据形状 + 逐形状幂等证明；`--check` 以「扫 0 份即红」防假绿。
- 凭据纪律：口令/token 不进命令行、文件、提交与 CI 日志。

### Changed
- demo 生成面收口：唯机械事实源为操作词表（`gen:check` 幂等门禁），
  四类被证伪的自动生成产物已删除并登记禁止重提。

[Unreleased]: https://github.com/Chuubururin/snowluma-webui-api-client/compare/clients-0.1.0-1ef9a2c-20261001160848...HEAD
[0.1.0]: https://github.com/Chuubururin/snowluma-webui-api-client/releases/tag/clients-0.1.0-1ef9a2c-20261001160848
