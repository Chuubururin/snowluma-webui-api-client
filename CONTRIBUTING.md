# 贡献指南

欢迎！这份文档定义改动进入本仓库的方式。本仓没有单独成文的行为准则——
约束协作者的规范全部落在下面五条规矩里，每条都有测试或门禁盯着。

参与本仓改动即视为接受：所有产物是 SnowLuma 源码的派生物、仅供非商业自用、
不发布到包管理器（见 [`spec/NOTICE.md`](spec/NOTICE.md)）。

---

## 在动手之前

> [!CAUTION]
> **门禁不许为变绿而放宽。** 禁止 `skip`、豁免名单、注释掉断言、把某类文件从检查里剔出去。
> 冷克隆缺依赖的正解是**恢复它**（`npm run fetch:upstream`、`npm run generate`），
> 不是让检查看不见缺失。这条规矩本身就是被保护对象。

改动进入 `main` 的唯一通道是 **PR**：`main` 受 branch protection，required check 是
`verify`（windows-latest 冷克隆跑整条 9 门禁链），且**必须经过人工审核合入**——
本仓不允许 auto-merge，检查绿只是必要条件，不是充分条件。

- 本地绿 ≠ 免检：CI 是冷克隆，本机残留（`vendor/`、`generated/`、`.venv-gen`）它没有。
- 提 PR 前先按 `.github/pull_request_template.md` 填齐关联与自检项。
- **合入确认（state=MERGED）之前不要删 head 分支**——
  GitHub 会直接 close 掉 PR，修复悄悄丢失（实测踩过）。
- `spec/openapi.yaml` 或 `tools/gen/**` 的变更还会触发 `demo-regen.yml` 自动重出词表开 PR；
  人工要补的是 `demo/parity.ts` 的一条边或 `demo/declinations.ts` 的一条放弃记录，不是任何清单文件。

不知道从哪里入手？[RoadMap.md](./RoadMap.md) 列着已登记、未认领的项。

---

## 项目结构速览

| 路径 | 作用 |
| --- | --- |
| `spec/` | OpenAPI 契约、锚点（全仓唯一事实源）、`NOTICE.md` 许可声明 |
| `generated/` | 三语言 SDK（构建副产物，不入库；`npm run generate` 现算） |
| `vendor/upstream/` | 按锚点 SHA 拉取的上游源码副本（不入库，drift 类门禁的证据面） |
| `adapters/` | 三语统一适配器（bootstrap 门控、规则引擎，三语同形） |
| `demo/` | 套壳控制台：手写语义路由 + 浏览器客户端（见 `demo/README.md`） |
| `tools/` | 生成管线、9 条门禁、夹具、脱敏、判据引擎——全部工程侧 |
| `docs/` | 开发者手册（入门 / 概念 / 指南 / 参考 / 运维） |
| `.github/workflows/` | 四条 CI：verify / demo-regen / upstream-sync / release-clients |

模块边界是**实测 import 矩阵**而不是愿望清单，逐条见
[`docs/concepts/architecture.md`](docs/concepts/architecture.md)。

---

## 本地开发环境

### 系统要求

- Node.js 22+（CI 用 24）· Python 3.12+ · Go 1.27.1 · Git（多条门禁直接 `git ls-files` 取事实）
- 工具链版本以 [`tools.lock.json`](tools.lock.json) 为准，**不要凭记忆补版本号**。

### 六步引导

完整版与每步的理由见 [安装](docs/getting-started/installation.md)：

```bash
npm ci
python -m venv .venv-gen && .venv-gen/Scripts/python -m pip install "openapi-python-client==0.29.1"
go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.0
npm run fetch:upstream
npm run generate
npm run verify:all          # 退出码 0 即环境就绪
```

---

## 五条不可谈的规矩

1. **门禁不许为变绿而放宽。**（见上；环境缺依赖就恢复依赖。）
2. **报绿带跑次。** "测试通过"不是证据；`N 次跑 M 次红` 才是。可疑用例单独重跑 5–10 次再下结论，
   红的运行保留整份日志（退出码别经管道取——`cmd | tail` 拿到的是 `tail` 的码）。
3. **一条守卫要证明它咬得动。** 新写/改动任何"用来拦问题"的校验时做一次变异检验：
   临时摘掉执法点，确认点名用例真的红，恢复后回绿，红/绿输出写进提交说明。
   全绿从来不是守卫存在的证明——它最坏的失效是存在但咬不动。
4. **断言打在装配点。** 对"整个应用"的行为断言，接 `collectRoutes()` / `buildHandler`
   生产装配返回的对象，不接模块导出。
5. **事实只存一份。** 新清单先问真源在哪：能派生就读真源（词表、`UIN_RE`、`OPERATIONS` 全是派生）；
   要手抄就同时给"清单 ↔ 生产者"加同序测试（`tools/verify-all.test.ts` 是模板）。
   注释与表各存一份 = 两份认知，改一处漏一处。

---

## 代码形状约定

- `tools/` 与 `spec/fixtures/` 每个入库文件前 12 行内带许可横幅（`workspace.test` 钉）；
  `docs/` 是契约来源，不在横幅纪律内。
- demo 路由只在 `demo/server/routes/` 各表内注册；`routes/` 下每个文件必须是带 `gateGuard`
  的路由表（`demo-lists` 钉着）；客户端调用一律走生成 SDK。
- 测试夹具形状纪律：假上游响应的每个键都是契约断言——编一个键 = 测试全绿 + 真实例永远显示占位符。
  "回显服务端值"的用例里输入值必须与期望值有一个真差。
- 按构造就慢的用例给显式 timeout 并把实测数字写进注释，不许为快拆断言。

---

## 提交与 PR

- 提交信息点名：治好了哪个红、跑过哪个绿（带跑次）、动了哪本账
  （parity / declinations / spec 任一分面变化都要在信息里可追）。
- 涉及"决定不做"任何 API / 字段 / 面板：当场登记 `demo/declinations.ts`（含理由与裁定人），
  不要只写在 PR 描述里——那是会蒸发的一层。
- 已经提交过的秘密**收不回来**，只能轮换。落盘口已过 `redactJson`，但 git 历史、备份、
  别人的克隆都算泄露面。

---

## 文档维护

- 文档按读者任务放在 `docs/{getting-started,concepts,guides,reference,operations}`，
  新页面先问"开发者带着什么任务来找它"。
- **不再新增过程产物分类**（evidence / plans / reports / specs 是已退役的旧制，说明见
  [`docs/README.md`](docs/README.md)）。机器跑次工件只有
  `docs/operations/verify-all-report.json`，由 `verify:all` 落盘、脱敏扫描覆盖 `docs/operations`。
- 文档里的路径、命令、数字都要当场核实过再写；注释与文档同为 durable record——
  它们随代码腐烂的方式和被改掉同样有害。

## 相关文档

| 主题 | 去处 |
| --- | --- |
| 加一条操作的完整手续 | [`docs/guides/add-an-operation.md`](docs/guides/add-an-operation.md) |
| 开发循环与证据纪律 | [`docs/concepts/workflow.md`](docs/concepts/workflow.md) |
| 每一种已知红 | [`docs/guides/troubleshooting.md`](docs/guides/troubleshooting.md) |
| 安全姿态与凭据纪律 | [`docs/operations/security.md`](docs/operations/security.md) |
