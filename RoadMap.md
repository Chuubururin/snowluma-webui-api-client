# RoadMap

开发方向登记处：已登记、未认领的项在此列明；**已裁定的"不做"不占这里的行**
（那本账在 `demo/declinations.ts` 与 `docs/operations/security.md` 的豁免表）。
认领方式：开 issue 或直接提 PR（流程见 [CONTRIBUTING.md](CONTRIBUTING.md)）。

## 待认领

| 项 | 背景与出处 | 落点 |
| --- | --- | --- |
| 云扫终态人工消费 | 整仓通道已查实并跑通提交（`~/.qodersec/bin/qodersec.exe scan --platform qoder --all`；对照实验单文件提交也通）。**两次同步重跑的云端终态都是 `canceled`**，而 CLI 照样打印 "No security issues found."——canceled 的 0 发现按口径不算数（缺席非干净）；本地四条取数通道（CLI 结果子命令、同步轮询、浏览器、qodercli 直连）全部实测不可用 | 操作者登录 qoder.com 的 Qoder Security 控制台，读最近一次整仓扫描报告的终态与发现清单；红项按 `docs/operations/security.md` 末节口径逐条开判，然后销本行 |
| `verify-posix` 首航取证 | CI 新增 ubuntu-latest job（跑同一份 GATES 清单 + 出口闸）。本机 WSL 只能验到不需要 go 的那几腿（789 passed / 0 断言失败，唯一红是缺 `generated/go`），因此 Linux 目前状态是**有闸尚无通过记录** | 首航后看 `gh run list --workflow verify.yml` 的 `verify-posix`；红则按 [troubleshooting.md](docs/guides/troubleshooting.md) 分流（断言红改代码、环境红修环境），跑绿后把 `docs/concepts/release-consumer-readiness.md` 与 `docs/getting-started/installation.md` 的支持面表一起转成"已验证" | 
| `upstream-sync` 首个每日自跑观察 | schedule `17 3 * * *`；workflow 已在 main 上，首个定时 tick 起算首航。预期 `no-change`，若开出 PR/工单按判据复核一轮 | `gh run list --workflow upstream-sync.yml`；证据抄回 `docs/concepts/upstream-sync.md`（已排观察任务） |

## 已裁定不做（防止反复重提）

| 决定 | 理由 | 记录处 |
| --- | --- | --- |
| L4 活体门禁进 CI | 上游本体不入库 + 口令不进 CI，结构性豁免 | `docs/operations/verification.md` |
| 路由表机械生成 | 已试过并证伪（一次迁移导致整客户端 404，随即回退并补门禁）：面板路由是判断产物 | `docs/concepts/architecture.md` 生成面判据节 |
| 发布到包管理器（npm/PyPI/Go module registry） | 许可口径，见 `spec/NOTICE.md`。**注意口径边界**：不发 registry ≠ 不生成 package metadata —— 工件带 `package.json` / `pyproject.toml` / `go.mod` 只为让消费者**本地安装**，不构成发布 | 同左 + [release-consumer-readiness.md](docs/concepts/release-consumer-readiness.md) |
