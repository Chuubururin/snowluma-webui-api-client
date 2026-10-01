<p align="center">
  <a href="https://github.com/Chuubururin/snowluma-webui-api-client/actions/workflows/verify.yml"><img alt="verify 主链" src="https://img.shields.io/github/actions/workflow/status/Chuubururin/snowluma-webui-api-client/verify.yml?branch=main&label=verify&style=flat-square"></a>
  <a href="https://github.com/Chuubururin/snowluma-webui-api-client/actions/workflows/upstream-sync.yml"><img alt="上游探测" src="https://img.shields.io/github/actions/workflow/status/Chuubururin/snowluma-webui-api-client/upstream-sync.yml?branch=main&label=upstream-sync&style=flat-square"></a>
  <a href="https://github.com/Chuubururin/snowluma-webui-api-client/actions/workflows/release-clients.yml"><img alt="客户端发布链" src="https://img.shields.io/github/actions/workflow/status/Chuubururin/snowluma-webui-api-client/release-clients.yml?branch=main&label=release-clients&style=flat-square"></a>
  <a href="./spec/NOTICE.md"><img alt="许可" src="https://img.shields.io/badge/license-非商业自用-287fb8?style=flat-square"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="./docs/README.md">文档</a> ·
  <a href="./CONTRIBUTING.md">贡献</a> ·
  <a href="https://github.com/Chuubururin/snowluma-webui-api-client/issues">问题反馈</a>
</p>

SnowLuma WebUI 管理面的契约提取与客户端仓：一份经上游源码核对的 OpenAPI 规格、
TypeScript / Python / Go 三个类型化 SDK、行为三语同形的统一适配器，
以及一个 55 条操作全部可以从界面走到的套壳控制台 demo。
上游本体**不在本仓库**——`vendor/`、`generated/` 都不入库，按锚点记录的 commit SHA 现场重建。

> [!CAUTION]
> 本仓库是第三方源码的派生产物，与 SnowLuma / Tencent / QQ 无隶属或授权关系。
> 仅供非商业自用，**不发布到包管理器**（npm / PyPI / Go module）；本仓 GitHub Release 工件属自用分发。
> 许可声明见 [`spec/NOTICE.md`](spec/NOTICE.md)，口径裁定见 [`docs/concepts/upstream-sync.md`](docs/concepts/upstream-sync.md)。
>
> **Disclaimer:** Derived from SnowLuma sources; non-commercial personal use only; provided "as is", not published to package registries.

## 核心能力

| 场景 | 能力 |
| --- | --- |
| 契约提取 | `spec/openapi.yaml`（55 操作 / 47 路径 / 101 schema）；与锚定源码的双向缺口由 drift 门禁机器核对 |
| 三语 SDK | hey-api 0.99.0 / openapi-python-client 0.29.1 / oapi-codegen v2.8.0 各自生成，逐文件许可横幅 + 血统收据（`generated/.provenance.json`） |
| 统一适配器 | TS / Python / Go 三份对同一条 bootstrap 门控链与同一套规则引擎行为逐字一致，golden 夹具三语同题 |
| 套壳控制台 | 7 屏面板，55 条操作每条"有控件且生效 / 写了不生效 / 登记了放弃"三分对账，未登记必须为 0 |
| 自动迭代 | 四条 workflow：PR 全链门禁、spec 变更重出词表、每日探测上游（零判断自动推进锚点、漂移开工单）、契约变更发三语 SDK Release 工件 |
| 活体验证 | L4 在**全新一次性**上游实例上跑五条硬要求（非 dev 模式、随机口令、跑完即毁）；结构性不进 CI，本机一条命令 |

## 主链

```
上游源码（锚点 SHA，47 份文件）──提取──▶ spec/openapi.yaml ──codegen──▶ generated/{typescript,python,go}
       │                                  │                              │
       ▼                                  ▼                              ▼
  spec/anchor.json               9 条离线门禁 verify:all          adapters/{三语适配器}   demo/server（SDK 唯一装配处）
  （每日探测 · 零判断自动推进）      退出码是唯一机器信号                                        │ HTTP
                                                            demo/client（浏览器端，纯 HTTP）────┘
```

## 快速开始

1. 引导工具链（六步的完整版见 [安装](docs/getting-started/installation.md)）：

   ```bash
   npm ci
   npm run venv:bootstrap
   go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.0
   ```

   （venv 的版本取 `tools.lock.json`，路径按平台解析；不要在别处再写一遍 `pip install`。）

2. 按锚点重拉上游源码缓存，生成三语 SDK：

   ```bash
   npm run fetch:upstream
   npm run generate
   ```

3. 一条命令验收整条链（9 条离线门禁）：

   ```bash
   npm run verify:all
   ```

4. 起控制台，浏览器打开 [`http://127.0.0.1:6097`](http://127.0.0.1:6097)：

   ```bash
   npm run demo
   ```

目标上游实例默认 `http://127.0.0.1:5099`，登录页可改址。下一步见
[十分钟起步](docs/getting-started/quickstart.md)。

## 接入与文档

| 入口 | 文档 |
| --- | --- |
| API 调用规范（客户端开发者） | [`docs/reference/api.md`](docs/reference/api.md) |
| 全部命令与环境变量 | [`docs/reference/commands.md`](docs/reference/commands.md) |
| 门禁链的机器行为 | [`docs/reference/gates.md`](docs/reference/gates.md) |
| 架构与设计概要 | [`docs/concepts/architecture.md`](docs/concepts/architecture.md) |
| 上游自动迭代流水线 | [`docs/concepts/upstream-sync.md`](docs/concepts/upstream-sync.md) |
| 加一条操作（上游变更处置） | [`docs/guides/add-an-operation.md`](docs/guides/add-an-operation.md) |
| 每一种已知红 | [`docs/guides/troubleshooting.md`](docs/guides/troubleshooting.md) |
| 贡献约定 | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| 开发方向 | [`RoadMap.md`](RoadMap.md) |

## 开发

需要 Node.js 22+（CI 用 24）、Python 3.12+、Go 1.27.1；完整引导与常见安装坑见
[docs/getting-started/installation.md](docs/getting-started/installation.md)。
日常验收只有一条命令：`npm run verify:all` 退出码 0。

> [!IMPORTANT]
> `main` 受 branch protection：required check 是 `verify`，进 main 一律走 **PR**，
> 且 **CI 绿之后还必须经人工审核合入**（本仓禁用 auto-merge）。直接 `git push origin main` 会被拒。

贡献流程、五条不可谈的规矩与提交纪律见 [`CONTRIBUTING.md`](CONTRIBUTING.md)；
仓库怎么"自己保持绿"见 [`docs/concepts/workflow.md`](docs/concepts/workflow.md)。

## 状态

> [!WARNING]
> **历史重建**：本仓已删除远端与全部 git 历史，压缩为单条初始提交重新发布——
> 动因是把曾提交进历史的两枚活体令牌残值彻底清出（令牌本体在删除前已轮换作废，
> 见 [安全姿态](docs/operations/security.md)）。初始提交之前不存在任何提交，
> 文内也不再引用任何历史提交编号、日期或流水号——本仓没有可检索的历史坐标。

- 55 条操作：52 effective + 3 write-only，未登记缺口 0（`npm run ui-coverage` 机器核）
- 测试：805 用例（vitest；另有 32 条 L4 活体用例默认 skip，`--fixture` 才跑）+ Python / Go 适配器套件
- 最新跑次：[`docs/operations/verify-all-report.json`](docs/operations/verify-all-report.json)
