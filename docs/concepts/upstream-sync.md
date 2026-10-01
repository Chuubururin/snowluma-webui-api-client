# 上游衔接与产物自动迭代

> [!NOTE]
> 本页是**在役流水线**的设计概要（已装配并完成首轮验收）。
> 现行 CI 共四条 workflow：`verify` / `demo-regen` / `upstream-sync` / `release-clients`，
> 分工与跑法见 [验证体系](../operations/verification.md)。

## 要解决的问题

上游 `SnowLuma/SnowLuma` 在动，而本仓的锚点 `spec/anchor.json` 长期钉在
`1ef9a2c`（一次性人工拉取）。装配前整条链有三个断点，本页的每个组件各自接住其中一个：

| 断点（装配前） | 现在的接法 |
| --- | --- |
| 探测：没有任何 CI 步骤看上游 main 的 HEAD | `upstream-sync.yml` 每日探测 + 本机 `npm run upstream:sync` 同入口 |
| 推进：全人工（`git ls-remote` 拿 SHA → `npm run extract <SHA>`） | 绿类（算术不变）由判据引擎自动开 PR、等人工审核合入；红类开工单归人 |
| 产物落成：三语 SDK 现算现丢（`generated/` 不入库），下游要自带工具链 | `release-clients.yml` 先过闸再发 GitHub Release 工件 |

## 三条已裁定的边界

| 裁定 | 内容 |
| --- | --- |
| **自动化截止线** | 算术不变则自动推进：零判断的锚点推进全自动；任何计数/集合/路径漂移停下来开人工工单。spec 里该加哪条操作永远是人的判断（生成面/手写面判据的 CI 版）。 |
| **产物落成** | 三语 SDK 发布成 GitHub Release 工件（tarball），不发包管理器。 |
| **发布通道与口径** | Release 挂本公开仓；头注口径由「不公开发版」收缩为「不发包管理器」。头注改写先行，第一批 Release 不得违反旧声明。 |

## 组件与数据流

```
上游 main ──每日探测──► tools/upstream-sync.ts（判据引擎）
   ├─ no-change ─────────────► 静默退出
   ├─ green-advance ─────────► PR：仅换 spec/anchor.json
   │      └─ verify.yml 冷克隆复验 ─► branch protection + 人工审核 ─► main
   └─ count/set/path 漂移 ───► issue 工单（逐项 diff，锚点不动）

main 上 spec/anchor.json 或 spec/openapi.yaml 变更
   └─► release-clients.yml：重建工具链 → generate → verify:all 先行
        → 三语 SDK tarball + spec + anchor + SHA256SUMS → GitHub Release
```

与现有 `demo-regen.yml` 的接缝是 spec：那条管"spec 变了 → 词表重出"，
本链管"上游变了 → spec 该不该变"。

## 判据（tools/upstream-sync.ts）

输入候选 SHA（缺省经 GitHub API 取上游 main HEAD；**网络故障不算分类**，
workflow 直接失败，不许以 issue 掩盖设施故障）。引擎把候选字节拉进临时目录、
`buildAnchorFromDir` 重算，再对现锚做三层比较，全部复用现成函数：

| 分类 | 判据 | 动作 |
| --- | --- | --- |
| `no-change` | 候选 == `anchor.commit` | 无 |
| `path-broken` | 任一 fetch 非 200（上游挪文件/改仓名） | 红类工单 |
| `count-drift` | `countExpectations()` 非空（路由总数 / API 数 / 模型键集合与计数） | 红类工单 |
| `operation-set-drift` | `computeDrift(新上游 ops, spec)` 三列表非空——专杀"总数不变但端点换名"（删一加一计数恰好相抵，只有键集合比对咬得动） | 红类工单 |
| `green-advance` | 以上全空，仅 `files[].sha256` 有差异 | 绿类 PR |

输出机器可读 JSON verdict + 人类可读报告；默认只判不写，`--write-anchor` 落盘。
本机 `npm run upstream:sync` 可干跑预演，CI 与本机走同一条入口。

## 绿类 PR

- diff 只含 `spec/anchor.json`（commit、fetchedAt、47 条哈希）。spec 与词表不动——
  绿类的定义就是它们无需改。
- 固定分支 `auto/upstream-sync`（`peter-evans/create-pull-request`，同分支重跑覆盖）。
- **独立复验不自证**：写锚点的进程（sync workflow）与验锚点的进程（verify.yml 的
  PR job，冷克隆按新 SHA 重拉 vendor）不共享工作树。
- **合入闸（实测装配）**：main 的 branch protection 要求 check context `verify`
  （非 matrix job 的 context 就是 job id，**不带 OS 后缀**）、`strict=true`、
  审批数 ≥1、`enforce_admins=false`（操作者本人的逃生门）、仓 `allow_auto_merge=false`
  ——**本仓禁用 auto-merge，CI 绿后必须人工审核合入**。
  副作用是全仓进 main 一律走 PR——绿类锚点 PR 与普通改动同走此闸，自动化只负责开 PR 与判读。
- 探测周期间的多提交一次性跳到 HEAD：钉的是**字节**不是历史，判据对新字节整体重算。

## 红类工单（issue，不开 PR）

红类要的是人的判断，给 PR 形态会诱使"直接合"。issue 正文逐项列：哈希变更摘要、
计数增减、upstreamOnly/specOnly 端点键、404 清单，末尾指向
[加一条操作](../guides/add-an-operation.md)。
幂等：正文埋 `<!-- upstream-sync:<sha> -->` 标记，同 SHA 重探只更新；锚点越过该 SHA 后关闭。

## release-clients.yml

- 触发：push main 且 `spec/anchor.json` / `spec/openapi.yaml` 变更，加 workflow_dispatch。
- 引导与 `verify.yml` 同一套（node/python/go、两个钉版本生成器、`PYTHONIOENCODING=utf-8`），
  `fetch:upstream` → `npm run generate` → **先 `npm run verify:all` 再发布**。
- 工件：`snowluma-clients-{typescript,python,go}-<tag>.tar.gz` + `spec/openapi.yaml`
  + `spec/anchor.json` + `SHA256SUMS.txt` + NOTICE + 血统收据（**上传名不带点**：
  `generated/.provenance.json` 直传会被 gh 改名成 `default.provenance.json`，落 dist 时
  就重命名为 `provenance.json`——验收实测的坑，已在 workflow 里躲开）。
- tag：`clients-<上游短7位>-<UTC时间戳>`（同锚点多 spec 迭代不撞名）。pwsh 里必须写 `$((Get-Date).ToUniversalTime().ToString(...))`
  ——`$(Get-Date).ToUniversalTime()` 的方法调用部分会留成字面文本（首跑红就红在这）。
- 权限仅 `contents: write`，无外部 secret。

## 头注口径改写（先行批次）

`不公开发版` → `不发包管理器`。波及面：全部跟踪文件行 1 横幅、
`tools/gen/demo/emit.ts` 与 `tools/gen/add-header.py` 的 BANNER 常量（否则新生成文件
与存量打架）、`spec/NOTICE.md` 声明正文、docs 口径句、断言横幅的测试。
作为独立提交先行于 sync/release 两条链。

## 测试与变异检验

- `upstream-sync.test.ts`：fixture vendor 目录钉五个分类各一条（判据纯函数化、不碰网）。
- 每条判据跑变异（[开发循环](workflow.md) 的证据纪律）：键集合比对退回计数比对必须红；
  404 被吞成"无变化"必须红。
- workflow 不可单测 ⇒ 本机同入口复跑 + `workflow_dispatch` 干跑：先当前 SHA（期望
  no-change），再真实新候选看实测分类。
- Release 验收：dispatch 实发一次，下载核对 tarball 与 SHA256SUMS 后删除测试 Release。

**首轮验收记录**：判据引擎 7 用例 fixture 全绿、四条变异逐一点名红
（其中一条首轮是**假变异**——`as any` 取不到字段恒 null，换真改行为的变体才红）；
`upstream-sync` dispatch 干跑判定 `no-change`、零副作用；
`release-clients` 首跑红（pwsh tag 展开实错，闸内前序全绿、**无半成品出厂**），修复后
按上述 tag 形状实发一次：7 项资产 SHA256SUMS 全对、tar 结构齐、
血统收据三语同批，验收后测试 Release 连 tag 删除。
合入闸经真实 PR 走通（绿 check → 人工审核 squash 落地）。

## 明确不做

- L4 活夹具不进 CI（真实例与口令的边界不动）。
- 不发包管理器（新口径的字面含义）。
- sync 引擎不写 spec、不判"该加哪条操作"——红类工单存在的全部理由。

## 相关

| 主题 | 去处 |
| --- | --- |
| 判据引擎的判据表 | 本页 §判据 |
| CI 怎么编排四条 workflow | [验证体系](../operations/verification.md) |
| 红类工单之后的手续 | [加一条操作](../guides/add-an-operation.md) |
| 命令与参数 | [命令参考](../reference/commands.md) |
