# 开发循环：这个仓库怎么"自己保持绿"

## 一次改动的完整生命周期

```
改代码/改 spec
  → 本地：npm run verify:all          （全部离线门禁，一条命令，退出码是唯一信号）
  → 需要活体证据时：加 -- --fixture    （L4 一次性实例）
  → push 分支 / PR
  → CI 自动重跑整条链（verify.yml，windows-latest，冷克隆先重拉 vendor）
  → 检查绿 → **人工审核合入** main（branch protection：required check 是 verify，禁用 auto-merge）
  → spec 或生成器变更时 demo-regen.yml 重出词表、必要时自动开 PR
  → 契约（anchor/spec）进 main 时 release-clients.yml 先过闸再发三语 SDK Release 工件
  → 每日 upstream-sync.yml 探测上游：零判断自动推进锚点，漂移开工单
```

**你不需要"记得跑哪条测试"**：链上任何一条被改坏，`verify:all` 与 CI 都会点名它。
单条门禁怎么单独跑、红了先看什么，见 [gates.md](../reference/gates.md) 与
[troubleshooting.md](../guides/troubleshooting.md)。

## 账本模型：缺口必须登记，不许消失

这个项目的完成定义不是"测试全绿"，而是**每一条操作都有下落**：

- `demo/parity.ts` — 面板 × 控件 × 操作 × effect × 出处（`webui 文件:行号`）。
  出处会被机器核对到锚定源码的真实行。
- `demo/declinations.ts` — 决定**不做**的 API/字段/面板，每条带理由、裁定人、可恢复性。
- `npm run ui-coverage` 把两本账与词表对账：每条操作要么 effective、要么 write-only、
  要么有放弃登记，**"未登记"计数为 0 是硬断言**。

覆盖数永远拆三层看：没有控件 / 写了不生效（write-only）/ 真生效（effective）。

## 提交与证据纪律

1. **每次提交点名它治好了哪个红、跑过哪个绿**。"测试通过"四个字不是证据，
   `N 次跑 M 次红` 才是。
2. **绿的单次跑不构成稳定证据**：可疑的测试单独重跑 5–10 次再下结论；
   红的运行必须保留整份日志（别接 `tail`，退出码走管道也是同一条坑——直接取 `$?`）。
3. **断言打在装配点上**：对"整个应用行为"的断言要接在生产装配点（`collectRoutes()`、
   `buildHandler`）返回的对象上，不是某个模块的导出上。
4. **变异检验**：新写一条"用来拦问题"的守卫时，临时把它摘掉，确认点名用例真的红，
   再恢复。全绿本身从来不是守卫存在的证明——它最坏的失效是存在但咬不动。
5. 已经提交过的秘密**收不回来**，只能轮换。落盘口已过 `redactJson`，
   但 git 历史、备份、别人的克隆都算泄露面。

## 放宽门禁的唯一合法路径：没有

> [!CAUTION]
> 任何"为了让离线环境变绿"的 skip、放宽断言、豁免名单，都会废掉那条绊线本身。
> 冷克隆缺依赖的正解是**恢复它**（`npm run fetch:upstream`、`npm run generate`），
> 不是让检查看不见缺失。判"红是因为环境"还是"红是真缺陷"，按
> [troubleshooting.md](../guides/troubleshooting.md) 的分流走。

## 相关

| 主题 | 去处 |
| --- | --- |
| 门禁的机器行为 | [gates.md](../reference/gates.md) |
| CI 四条 workflow 的分工 | [验证体系](../operations/verification.md) |
| 贡献流程与提交纪律 | [`CONTRIBUTING.md`](../../CONTRIBUTING.md) |
