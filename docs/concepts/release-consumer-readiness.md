# Release 消费者就绪

内部链（extraction → generation → adapter → verification）的严谨度是刻意堆上去的，本页不管它。
本页管一件事：**离开仓库以后，这套东西成不成为一个可消费的产品**。

定性口径：

> **源码树全绿 ≠ 交付物可消费。**

这条不是修辞。下面每一条都是实测出来的，且都躲在"全绿"后面。

## 1. 被抓到的九处出口缺陷

| 缺陷 | 位置 | 为什么既有门禁看不见 |
| --- | --- | --- |
| Release 只打包生成物，适配器一字节都不进 | `release-clients.yml` 的打包步 | 门禁验的是仓内装配，仓内装配一直成立 |
| TS 适配层的 spec 路径是 CWD 相对字面量 | `adapters/typescript/operations.ts` | 所有测试与门禁都跑在仓根，CWD 永远是仓根 |
| Python 规则表默认按目录深度解析 | `adapters/python/snowluma_adapter.py` | 同上：装包后布局深度变了，仓内不会 |
| Go 适配器靠 `replace … => ../../generated/go` 解析 | `adapters/go/go.mod` | 该 replace 在本仓布局里永远正确 |
| 干净克隆里 `npm run generate` 的 Go 腿 ENOENT，而它印的"恢复动作"写死作者机器路径 | `tools/gen/run.ts`、`tools/lib/go-toolchain.ts` | 开发终端早年 export 过 PATH；`test:go-adapter` 只借 GOROOT，`oapi-codegen` 其实落在 `<GOPATH>/bin` |
| 新克隆的 `generated/go` 没有 `go.sum`（`go mod init` 不写它） | `tools/gen/run.ts` 的模块初始化 | `adapters/go/go.mod` 把 indirect 依赖全列了 ⇒ 仓内构建替生成模块兜底；工件以生成模块为真源，一装就 missing go.sum entry |
| TS 适配层按"运行时文件的上一级"读规则表，装包后无处可读 | `adapters/typescript/rules.ts` 的默认解析 | 仓内那份表永远在 `adapters/` 上一级 ⇒ 每次测试都命中，走出仓就 ENOENT |
| 三份 README 都写"见同目录 `provenance.json`"，工件里根本没有这件；而唯一的相关断言拿 README 散文自己当尺子 | `tools/lib/client-templates.ts` 的出处段 + `package.json` 的 `files` 白名单 | 计划成员断言与散文断言同时成立 —— 只有"装好之后的字节"这一面没人看过（评审复查抓到，不是冷克隆） |
| 出口闸的 TS 腿把示例打包交给 `node node_modules/esbuild/bin/esbuild` | `tools/smoke-clients.ts` 的"用得动"层 | Linux 上那个文件被 esbuild 的 install.js（`os.platform() !== 'win32'` 分支）换成**原生二进制**并 chmod +x，node 加载必崩；Windows 上那里留的是 JS shim ⇒ 本机永远绿（`verify-posix` 首航实测） |

前四条已修（改成按模块自身位置解析、包内 sibling 优先；第四条不是"修 replace"，而是
**合并成同一个 module 让它消失**）。第 5、6 条是**冷克隆实测**抓到的——把它们单列出来是因为
它们不在"交付物内容"里，而在"交付物怎么被生产出来"里：只有在一次干净克隆按
[installation.md](../getting-started/installation.md) 逐步重跑时才现形。
现在的处置：Go 腿自己按 `tools.lock.json` + `go env GOPATH` 推导工具链并前置进子进程 PATH，
提示只印推导结果或安装动作；生成后 `go mod tidy` 补 require 与 `go.sum`，
打包器缺任一件都点名拒收，不再留裸 ENOENT。
第 8 条的处置：血统收据进三份工件（`copyFrom generated/.provenance.json`，缺就点名拒收）、
进 `files` 白名单，并把断言改成两件事——README 指向的件必须是计划成员，
且必须在**装好的包目录**里存在（`npm pack` 出来的 tgz 才算交付物本体）。
第 9 条的处置：两条腿统一走 esbuild 的 JS API（`import { build } from 'esbuild'`，与打包器同形），
并由 `tools/smoke-clients.test.ts` 钉住"不许取 esbuild 的 bin 路径交给 node"——
这类断言只扫代码面，不扫注释：解释失效原因的注释必然带着那个字面量，量散文就会误红。

第七条不在原计划里，是出口闸第一次真跑抓到的。处置是打包期内嵌规则表
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
| 装得上 | TS：`npm pack` 出 tgz 再 `npm install <tgz>`（目录安装实测是**符号链接**，`files` 白名单永远走不到）；Python：`python -m venv` + `pip install ./dir`；Go：`go work init`（复制工件而非原地引用） | 布局与路径耦合；"计划里有、装完没有" |
| 入口对 | `package.json` 声明的 `main`/`types`/`exports` 文件必须真实存在 + README 里每条"见同目录 X"承诺的件都在**装好的包目录**里 + 已装版本 == 契约版本 + 承诺符号从包名可达 + 以 bundler 形态 tsc 过示例；`pyproject` 的包名与 `importlib.metadata` 版本；`go list -m` 与"go.mod 不得含 replace" | 文件都在、能编译，但消费者实际 import 的路径不对；或安装说明指向包里根本没有的文件 |
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
- **断言不许拿被检对象自己当尺子**：`README 必须含 requiredReadmeSections() 里的每一段` 这种写法，
  把模板里的「版本与出处」删掉后两边一起缩小 —— 变异实测 31 条用例全绿。合同（四段名单）
  现在写死在测试里，模板只许满足它。
- **计划成员 ≠ 装好的字节**：`provenance.json` 一度在计划里、在 `dist/clients/*` 目录里，
  却不在 `package.json` 的 `files` 白名单里，而三份 README 都写着"见同目录 provenance.json"。
  npm 只按白名单装包，所以目录安装全绿、装 tgz 就缺件。判据必须落在 shipped bytes 上。

变异检验台账（每条先红后绿，红退出码非 0、恢复后为 0、恢复后源文件字节一致；
由一次性脚本逐条执行，`spec/`、`adapters/` 只在做违例注入时临时改动并当场还原）：

| 变异 | 点名的执法点 | 结果 |
| --- | --- | --- |
| `info.version` 改成两段 | `contract-version.test.ts` | 红 exit 1 → 绿 0 |
| 一处 `copyFrom` 指向不存在的目录 | `client-staging.test.ts` 的搬运项存在性 | 红 exit 1 → 绿 0 |
| 模板删掉一个必需 README 段 | `client-templates.test.ts` | 首轮**全绿**（自证式清单）→ 合同写死后红 exit 1 → 绿 0 |
| `loadSpec` 退回 CWD 相对字面量 | `adapter-path-resolution.test.ts` 的异 CWD 子进程 | 红 exit 1 → 绿 0 |
| Python 规则表删掉上一层兜底 | `adapters/python/test_rules_resolution.py` | 红 exit 1（1 failure + 1 error）→ 绿 0 |
| 版本号抄回 release job | `workflow-pins.test.ts` | 红 exit 1 → 绿 0 |
| posix job 少跑一步出口闸 | `workflow-pins.test.ts` 的步序相等 | 红 exit 1（"两条 job 步数不同：8 vs 9"）→ 绿 0 |
| `envWithGo` 退回硬塞大写 `PATH` | `go-toolchain.test.ts` 的单键断言 | 红 exit 1 → 绿 0 |
| 删掉 `exitCodeFor` 的 facility 分支 | `smoke-clients.test.ts` | 红 exit 1 → 绿 0 |
| 从导航表摘掉一页 | `docs-index.test.ts` | 红 exit 1 → 绿 0 |
| 把 `provenance.json` 从 npm `files` 白名单删掉 | `smoke:clients` 的"入口对"层（装好的包字节） | 红 exit 1，detail 点名白名单漏写 → 绿 0 |
| 把 esbuild 的 bin 路径重新交回 node（塞一个 `esbuildBin` 句柄进代码面） | `smoke-clients.test.ts` 的调用形态断言 | 红 exit 1 → 绿 0 |
| 让源码形状断言去扫全文（含注释） | 同上 | **误红**：注释里的"当年写死过的那条路径"被当成执行面 —— 已改成只扫代码面，并加一条"剥注释不许把代码剥光"的自证用例 |

反向用例（证明判据不是恒红）：删掉工件里的 `rules.json` 应**仍然绿**——行为已不依赖运行时文件位置。

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
| `tools/client-staging.test.ts` | vitest | 工件缺件、metadata 版本与契约不符、嵌套 `go.mod`、缺 `go.mod`/`go.sum` 时不点名拒收、`copyFrom` 源不存在、README 指向的件不在计划里、必发件清单被删薄、内嵌表与真源不等、声明的入口拼错 |
| `tools/client-templates.test.ts` | vitest | README 散文与示例不同源、验收标记只存在于内嵌代码块、必需段被从模板删掉（合同写死在测试里）、Python 两层抽象被混写 |
| `tools/go-toolchain.test.ts` | vitest | 推导出的目录不存在、Go 腿没前置同一份推导结果（出现第二条认知）、PATH 键名被写成第二份、报错文本里出现具体机器路径、需要 go 的入口绕过 envWithGo 自己拼 PATH |
| `tools/workflow-pins.test.ts` | vitest | workflow 的执行行抄工具链版本号、留下 `go install …@vX`/`pip install …==` 抄本、调不存在的 npm 脚本、引导步排在 `npm ci` 之前、两条 OS job 的步序分叉 |
| `tools/docs-index.test.ts` | vitest | 文档无人导航、相对链接死、`npm run` 指向不存在的脚本 |
| `npm run smoke:clients` | 独立脚本（Release 前置闸 + CI） | 上面第 5 节的三层，含"README 承诺的同目录件必须在**装好的包**里" |

这些都在源码树的门禁里，而源码树永远在作者机器上。**收尾判据因此多一条不属于任何门禁的**：
把分支克隆进干净目录，按 `docs/getting-started/installation.md` 逐步重跑
（`npm ci` → `venv:bootstrap` → `fetch:upstream` → `generate` → `verify:all` →
`package:clients` → `smoke:clients`）。本轮就是这么跑出上面第 5、6 两条缺陷的——
它们在开发目录里都是绿的。它不能自动化，因为"冷"的前提是没有既有缓存与既有终端设置。

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
