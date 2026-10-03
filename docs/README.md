# 文档导航

按**你要做什么**选入口，三条路径各走各的：

| 我是来…… | 走这条 |
| --- | --- |
| **跑起来** | [安装](getting-started/installation.md) → [十分钟起步](getting-started/quickstart.md) |
| **改功能 / 加操作** | [架构与设计概要](concepts/architecture.md) → [开发循环](concepts/workflow.md) → [加一条操作](guides/add-an-operation.md) |
| **它红了** | [故障排查](guides/troubleshooting.md) → [验证体系](operations/verification.md) |

贡献约定与提交流程在根级 [`CONTRIBUTING.md`](../CONTRIBUTING.md)；给代理的治理不变量在根级 [`AGENTS.md`](../AGENTS.md)；开发方向在 [`RoadMap.md`](../RoadMap.md)。

## 全部页面

### getting-started — 第一次接触这个仓库

| 页面 | 回答什么 |
| --- | --- |
| [installation.md](getting-started/installation.md) | 工具链、venv、生成器、上游缓存的六步引导与安装坑 |
| [quickstart.md](getting-started/quickstart.md) | 从冷克隆到浏览器里登录成功 |

### concepts — 它是怎么设计的

| 页面 | 回答什么 |
| --- | --- |
| [architecture.md](concepts/architecture.md) | 分层、模块边界（实测 import 矩阵）、单一真源清单、生成面/手写面判据 |
| [codegen-spike.md](concepts/codegen-spike.md) | 生成链预研结论：三家工具各自的取舍，以及每个手写形状（Go 的 union 塌缩、Python 的 unwrap、TS 的规则表内嵌）为什么必须手写 |
| [upstream-sync.md](concepts/upstream-sync.md) | 上游衔接与产物自动迭代流水线（判据表、PR/工单语义、Release 链） |
| [release-consumer-readiness.md](concepts/release-consumer-readiness.md) | Release 工件的消费者就绪：合包形态、契约版本语义、出口闸三层与变异检验、支持面 |
| [workflow.md](concepts/workflow.md) | 这个仓库"自己保持绿"的机制：门禁链、账本模型、提交纪律 |

### guides — 按任务的操作步骤

| 页面 | 回答什么 |
| --- | --- |
| [add-an-operation.md](guides/add-an-operation.md) | 上游加了 API 之后要走的全部手续（含红类工单入口） |
| [troubleshooting.md](guides/troubleshooting.md) | 每一种已知红：症状 → 根因 → 处置 |

### reference — 逐项查询

| 页面 | 回答什么 |
| --- | --- |
| [api.md](reference/api.md) | SnowLuma WebUI API 调用规范（55 操作、门控、错误码、流） |
| [operations.gen.md](reference/operations.gen.md) | 逐条操作清单，由 `npm run gen:docs` 从契约现出（生成面，别手改） |
| [commands.md](reference/commands.md) | 全部 npm 脚本、环境变量、生成器钉版本 |
| [gates.md](reference/gates.md) | `verify:all` 的机器行为与报告格式 |

### operations — 运行与验证

| 页面 | 回答什么 |
| --- | --- |
| [verification.md](operations/verification.md) | 本地链、四条 CI workflow、L4 活体门禁、冷克隆保证、脱敏 |
| [security.md](operations/security.md) | SSRF 判据、凭据纪律、已裁定的设计豁免 |

## 历史过程文档

`docs/superpowers/`（evidence / plans / reports / specs）是重构前的过程产物分类，
已整体退役；本仓历史已压缩重建为单条初始提交，这些内容在 **git 历史中不存在**，
其结论已各自折进现行文档（安全取证见 [security.md](operations/security.md)，验证链见 [verification.md](operations/verification.md)）。
机器跑次工件现在只有 [verify-all-report.json](operations/verify-all-report.json) 一个，由 `verify:all` 落盘。
