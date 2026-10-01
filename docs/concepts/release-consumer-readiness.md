# Release 消费者就绪

内部链（extraction → generation → adapter → verification）的严谨度是刻意堆上去的，本页不管它。
本页管一件事：**离开仓库以后，这套东西成不成为一个可消费的产品**。

定性口径：

> **源码树全绿 ≠ 交付物可消费。**

这条不是修辞。下面每一条都是实测出来的，且都躲在"全绿"后面。

## 1. 被抓到的四处出口缺陷

| 缺陷 | 位置 | 为什么既有门禁看不见 |
| --- | --- | --- |
| Release 只打包生成物，适配器一字节都不进 | `release-clients.yml` 的打包步 | 门禁验的是仓内装配，仓内装配一直成立 |
| TS 适配层的 spec 路径是 CWD 相对字面量 | `adapters/typescript/operations.ts` | 所有测试与门禁都跑在仓根，CWD 永远是仓根 |
| Python 规则表默认按目录深度解析 | `adapters/python/snowluma_adapter.py` | 同上：装包后布局深度变了，仓内不会 |
| Go 适配器靠 `replace … => ../../generated/go` 解析 | `adapters/go/go.mod` | 该 replace 在本仓布局里永远正确 |

前三条已修（改成按模块自身位置解析、包内 sibling 优先）。第四条不是"修 replace"，
而是**合并成同一个 module 让它消失**。

另有一条不在原计划里、由出口闸第一次真跑抓到：TS 适配层按"运行时文件的上一级"读规则表，
装包后消费者把自己那份示例打到哪里无法预知 ⇒ ENOENT。处置是打包期内嵌规则表
（真源仍是 `adapters/rules.json`，内嵌副本按 `RulesTable` 受 tsc 检，相等性有断言钉住），
按盘读表那一条另名 `createDiskClient` 保留。

## 2. 工件形态

一次 Release 产出三个各自自包含的目录：

```text
typescript/   dist(.js/.d.ts) + index.ts + generated/ + adapter/ + rules.json + README + NOTICE + examples/
python/       snowluma_client/(生成包 + adapter.py + rules.json) + pyproject.toml + README + NOTICE + examples/
go/           snowluma/ + adapters/(含 version.go) + go.mod + rules.json + README + NOTICE + examples/
```

| 决定 | 理由 |
| --- | --- |
| TS 发构建产物（esbuild 打包 + tsc 出声明），不发裸 TS 源码 | 生成码用**无扩展名相对导入**，`tsc` 直出的 ESM 在 Node 下必然 ENOENT；而 `npm install ./dir` 装进一堆 `.ts` 等于没交付 |
| TS 运行时零第三方依赖 | 实测生成码 + 行为适配层（`client.ts` / `rules.ts`）没有任何外部 import。仓内工装 `operations.ts` 要 `yaml` 且读 spec，**不带出仓** |
| Python 依赖只声明 `httpx` + `attrs`，且不写下限 | 实测生成腿用这两个；适配层纯标准库。没验过下限就不编造版本号 |
| `rules.json` 声明为包内数据文件 | 否则 wheel 装完读不到表，归一化静默不生效——这是"装上了但行为不对"的最坏形状 |
| Go 的 `go.mod`/`go.sum` 沿用生成物自己那份 | 依赖清单的真源在生成器；同时刻意**不采纳** `adapters/go/go.mod` 里那条 replace |

## 3. Go：本地 module 工件，不是已发布的 module

| 项 | 裁定 |
| --- | --- |
| module id | 沿用生成物既有的 `example.com/sl/generated`（RFC 2606 保留域）。它永不可被 `go get` 拉取——**这是优点**：把"不发 Go module"写进标识符本身 |
| 消费方式 | `go work init && go work use ./go`；README 明写 *intentionally not a published Go module* |
| 布局 | 生成码与适配器同一 module ⇒ 适配器 import 零改写，`replace` 消失 |
| 已知陷阱 | 适配器目录里**不能**留自己的 `go.mod`：那会构成嵌套 module，Go 认为适配层属另一个模块，报错是 `no required module provides package …/adapters`（这条由打包器的排除规则 + 一条断言钉住） |
| 版本 | module 元数据不携带版本 ⇒ 打包器发射 `go/adapters/version.go` 的 `ContractVersion` 常量；出口闸断言示例打印的就是它 |

## 4. 契约版本（Contract Version）

真源只有 `spec/openapi.yaml` 的 `info.version`。它描述**契约**，不描述 SDK，也不描述上游实现。

```text
MAJOR = 不兼容的契约变化（删 operation、改响应形状、改必填集、改分档语义）
MINOR = 向后兼容的新增（新 operation、新增可选字段/枚举支）
PATCH = 不改变契约语义的修正（描述订正、归一化规则修正、生成产物修复）
```

与上游探测的对接（不接受"上游一动就抬号"）：

| `upstream-sync` 分类 | 契约版本动作 |
| --- | --- |
| `no-change` | 不动 |
| `green-advance`（锚点哈希变，算术不变） | **不动** —— 上游实现改动属 provenance，抬进版本号就等于让契约版本变成上游版本 |
| 新增 operation / 可选字段 | 建议 MINOR，人工确认后抬 |
| 删 operation / 改必填集 / 改形状 / 改分档 | MAJOR，属红类工单，**只能人工裁定**；代理与 CI 都不得自行抬号或改 spec |
| spec 文本订正 / 生成产物修复 | PATCH |

Release tag 形状 `clients-<contractVersion>-<anchor短7>-<UTC 时刻>`。
UTC 时刻只承担防重复发布的职责，不表达版本语义；上游锚点 SHA 只做 provenance，绝不进版本号。

同一批还删掉了 `info.description` 里的阶段自述与绝对计数（那处曾长期落后于实现）。
**描述里不写会漂移的数**：计数一律由 `npm run inventory` 现出。

## 5. 出口闸 `smoke:clients`

三层各成一键，不合并也不短路——`installed && ok` 会把"入口不对"和"没装上"糊成同一条红：

| 层 | 断言 | 抓住的失效 |
| --- | --- | --- |
| 装得上 | `npm install ./dir`、`python -m venv` + `pip install ./dir`、`go work init`（复制工件而非原地引用） | 布局与路径耦合 |
| 入口对 | `package.json` 声明的 `main`/`types`/`exports` 文件必须真实存在 + 已装版本 == 契约版本 + 承诺符号从包名可达 + 以 bundler 形态 tsc 过示例；`pyproject` 的包名与 `importlib.metadata` 版本；`go list -m` 与"go.mod 不得含 replace" | 文件都在、能编译，但消费者实际 import 的路径不对 |
| 用得动 | 三语示例真跑，断言各自的 OK 标记 | 交付物里的行为层接不上 |

放置：

| 位置 | 进不进 | 理由 |
| --- | --- | --- |
| 离线 `GATES` | 不进 | 它要装包、要取 `httpx`，会破 GATES 的"离线"性质；冷克隆不该被网络安装卡住 |
| Release 前置闸 | 必进，次序 `verify:all` → `package:clients` → `smoke:clients` → 打包 | 任何一步红都不产出 Release |
| CI（Windows 与 POSIX 两条 job） | 必进 | 让"工件可消费"每次契约变更都有机器证据 |

两条实测教训，写下来防止被"测试全绿"重新骗一次：

- **tsc 会静默回落**：把 `types` 指向不存在的 `.d.ts`，tsc 仍编译通过（回落到 `main` 旁的同名声明）。
  所以"能编译"不是入口判据，必须显式核对声明的文件真实存在。
- **go build 会忽略自替换**：把 `replace … => ../../generated/go` 塞回工件的 `go.mod`，编译照样绿。
  所以"带不出仓的路径配置"要靠明文断言，不能靠编译结果。

变异检验记录（每条都必须红）：`exports.types` 指空文件、Python 包内漏 `rules.json`、
Go 放回 replace、Go 出现嵌套 `go.mod`、工件版本与契约版本不一致、TS 缺 `dist/index.js`。
反向用例：删掉工件里的 `rules.json` 应**仍然绿**——证明行为不再依赖运行时文件位置。

## 6. 支持面与跨平台

| 平台 | 状态 | 由什么证明 |
| --- | --- | --- |
| Windows x64 | 已验证 | `verify` job 长期在跑 |
| Linux x64 | 有闸，尚无通过记录 | `verify-posix` job；首航跑绿前本页不许写"Linux 已支持" |
| macOS | 未验证 | 无 job。未验证 ≠ 不支持，但不要按支持面排期 |

本机 WSL Ubuntu 实测到的事实（不是推断）：`fetch:upstream` 可用；补上 `generated/typescript` 后
全量 vitest **789 条用例通过、0 条断言失败**；剩余唯一红是缺 `generated/go`（本机无 go 工具链，
CI 里 generate 先跑）。同时抓到两条把 Windows 路径语义焊死在断言里的既有测试（已修）。
venv 引导在本机撞出 `python3-venv` 缺失，报错点名了原因——这类"环境红"与"断言红"的区分口径见
[troubleshooting.md](../guides/troubleshooting.md)。

去硬编码的落点：`package.json` 的 python 腿改走启动器（复用 `VENV_BIN_DIR`），
workflow 的 venv 引导收进 `npm run venv:bootstrap`（版本从 `tools.lock.json` 读，不再有两份 `0.29.1` 抄本）。

## 7. 边界：明确不做

| 不做 | 理由 |
| --- | --- |
| 发布到 npm / PyPI / Go module registry | 许可口径，见 `spec/NOTICE.md` 与 `RoadMap.md` |
| 重做内部 extraction / adapter 架构 | 内部链是刻意设计，不是本轮债 |
| 机械生成路由表 | 已试过并证伪，判据见 [architecture.md](architecture.md) |
| L4 活体门禁进 CI | 上游本体不入库 + 口令不进 CI，结构性豁免 |
| 复活 `docs/superpowers/` | 该分类已整体退役，现行规范只进现行 `docs/` 树 |
| 给代理铺多份入口文件（`CLAUDE.md` / `.cursor/rules` / `llms.txt`） | 多份就是多个真源；只留一份 [AGENTS.md](../../AGENTS.md) |

## 8. 执法点清单（本轮新增）

| 执法点 | 形态 | 咬什么 |
| --- | --- | --- |
| `tools/contract-version.test.ts` | vitest（在 `test` 门禁内） | `info.version` 非三段 semver；描述里重新长出计数或阶段自述 |
| `tools/adapter-path-resolution.test.ts` | vitest | 适配层换 CWD 就读不到 spec；显式入参被废 |
| `tools/client-staging.test.ts` | vitest | 工件缺件、metadata 版本与契约不符、嵌套 `go.mod`、内嵌表与真源不等、声明的入口拼错 |
| `tools/client-templates.test.ts` | vitest | README 散文与示例不同源、验收标记只存在于内嵌代码块、Python 两层抽象被混写 |
| `tools/docs-index.test.ts` | vitest | 文档无人导航、相对链接死、`npm run` 指向不存在的脚本 |
| `npm run smoke:clients` | 独立脚本（Release 前置闸 + CI） | 上面第 5 节的三层 |

为什么不把前三类再包成独立 GATES 条目：每条 GATES 都是一个独立 `npm run` 子进程，
而跨面钉类断言在本仓的先例是 vitest（`workspace.test.ts`、`verify-all.test.ts`）。
放 vitest 既留在 `npm run verify:all` 这条唯一日常入口里，也不多花一次冷启。

## 相关

| 主题 | 去处 |
| --- | --- |
| 生成管线与横幅执法 | [architecture.md](architecture.md) |
| 上游探测与 Release 链 | [upstream-sync.md](upstream-sync.md) |
| 契约行为细节 | [api.md](../reference/api.md) |
| 门禁清单与报告读法 | [gates.md](../reference/gates.md) · [verification.md](../operations/verification.md) |
