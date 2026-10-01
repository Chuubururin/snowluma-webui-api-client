# 如何加一条操作（上游新增/变更 API）

场景：上游 WebUI 面加了一条端点（或改了形状）。这条 how-to 走完全程——
每一步都有门禁兜底，做漏哪步会红在哪条。
**这条路的常见入口是 CI 的红类工单**（label `upstream-sync`，判据见
[concepts/upstream-sync.md](../concepts/upstream-sync.md)）：机器已经替你列好
哪些计数动了、哪些端点键进出、哪些锚定文件 404——工单说的是"这里需要人的判断"，
本页是判断之后要走的手续。

## 0. 先取上游事实

上游源码副本必须属于你要采信的那个 commit：

```bash
npm run fetch:upstream                # 按 spec/anchor.json 的 SHA 重拉
# 若上游 main 前进了且你要跟进：先人工确认新 SHA，再
npm run upstream:sync -- --candidate <新SHA>   # 预演判据（绿类 CI 会自动推进，无需人工；
                                               # 走到这里的多半是红类，判定就是你的差事单）
npm run extract <新的40位SHA>          # 重建 anchor（extract 从不联网，只哈希缓存）
```

`check-drift` 会拒绝形状坏的锚点；`npm run drift` 报出的 upstreamOnly 列表就是
"上游有而 spec 没有"的操作清单——加操作通常从这条红开始。

## 1. 写进契约

在 `spec/openapi.yaml` 增该操作：路径、方法、`operationId`、请求/响应 schema、
错误码分支、`x-replay-class`（T1 只读 / T2 可回滚写 / T3 永不重放）、流端点加 WithResponse 判语。

```bash
npm run validate    # spec 自身约束
npm run drift       # 双向零缺口
npm run inventory   # 分面清单随 spec 重出
```

## 2. 重生成

```bash
npm run generate     # 三语 SDK（全部成功才写血统收据）
npm run gen:demo     # 词表 vocabulary.gen.ts
```

此时 `npm test` 里 `check-vocabulary.test.ts` 会点名："这条操作没有归属"。

## 3. 登记下落（二选一，不许空着）

- **要做** → `demo/parity.ts` 加一条边：面板、控件名（不许发明——`webui` 出处的
  `file:line` 必须真实承载该控件，出处按 `^(.+):(\d+)$` 机器核）、ops、effect、merge 语义。
- **不做** → `demo/declinations.ts` 加一条放弃登记：kind、subject（若是 operationId，
  必须真实存在于词表——死条目会被 `classifyOps` 直接拒掉）、真 WebUI 出处、理由、裁定人。

## 4. 实现（要做的那条路）

- 服务端路由写在 `demo/server/routes/<面板>.ts` 那张表里，调用一律走
  `generated/typescript/sdk.gen.js` 的类型化操作 + `unwrap()` 折叠非 2xx——
  **不许手写路径字符串、不许开第二个折叠点、更不许绕过 generated 用 adapters 的 generic request**。
- 新路由会自动进 `collectRoutes()`；`demo-route-contract.test.ts` 立刻核
  "客户端请求面 ⊆ 路由表"与"门禁可见 == 生产注册"。
- 客户端在 `demo/client/` 加控件与 `data-ctl` 挂点（ui-coverage 断言 1 数得出来）。

## 5. 补测试

- L2：`tools/demo-*.test.ts` 假上游上打路由（形状错误分支也要打——
  200 非对象体、缺必填键，各断言一条 protocol/400 错）。
- L3：挂载用例（若带新控件）。
- 三语适配器若承载 bootstrap 门控链的新分支：golden `cases.json` 加一条，三语同跑。
- T3/有副作用的操作：不进任何自动重放路径，按 replay 分级约束处理。

## 6. 收口

```bash
npm run verify:all                    # 9 条全绿，报告落 docs/operations/verify-all-report.json
SNOWLUMA_FIXTURE_PORT=<空闲> npm run verify:all -- --fixture   # 要活体证据时
```

提交信息点名：加了哪条操作、parity/declination 登了哪本账、跑了几次红了几次。

## 禁区清单（都有一条门禁盯着）

| 别做 | 谁会红 |
| --- | --- |
| 手抄 operationId/正则进代码 | drift / upstream-guards / 结构守卫 |
| demo/server 引 adapters 或手写 fetch 绕 SDK | typecheck:demo + review 判据 |
| 为离线绿而 skip/放宽断言 | 该断言本身就是被保护对象 |
| 发明控件名或占位行号 | ui-coverage 断言 2/3（出处机器核） |
| 把口令/凭据写进任何入库文件 | evidence-redaction（跟踪面扫描） |

## 相关

| 主题 | 去处 |
| --- | --- |
| 红类工单从哪来 | [upstream-sync](../concepts/upstream-sync.md) |
| 判据与禁区背后的架构 | [架构与设计概要](../concepts/architecture.md) |
| 命令逐项查询 | [命令参考](../reference/commands.md) |
