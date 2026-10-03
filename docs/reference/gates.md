# verify:all 的机器行为

## 清单在哪里

门禁清单的唯一真源是 `tools/verify-all.ts` 的 `GATES` 数组（离线若干条 + `--fixture`
追加 L4）。本文**故意不复制那张表**——注释与表各存一份就是两份认知分叉，
而这条分叉本身由 `tools/verify-all.test.ts` 钉着：

- `GATES` ↔ 文件头注的执行清单 **逐条同序**（只改一边即红）
- 每条 `npmScript` 在 `package.json` 里真实存在
- 每条 `runs` 列的文件在磁盘上真实存在
- `REQUIRED_GATE_IDS`（规格点名的五条）不许缺席
- 门禁清单 ↔ 入库报告的门禁集合**相等**（改清单却不重跑链、或删掉一条而不改报告，都会在这里分叉点名）
- `test:fixture` **不在**默认清单里——L4 只能显式加

想知道当前有哪些条：读 `tools/verify-all.ts`，或跑一次看它自己打印的 ✓/✗ 行。

## 退出码语义

**任一条红、或清单为空 ⇒ 退出码 1。** 空清单也算红：一条都没跑却写"全部通过 ✓"，
与"扫到 0 个文件却报齐备"是同一形状失效。CI 与 `verify:all && …` 只看这一个数，
所以它是整条链唯一的机器可读信号。

## 报告文件

`npm run verify:all` 落盘 `docs/operations/verify-all-report.json`：

```jsonc
{
  "generatedAt": "…",              // 运行时刻
  "gitHead": "…",                  // 运行当时的 HEAD——承载报告的提交必然晚一个，
                                    // 对不上时先看这层，别当数字错
  "fixture": false,                // 本次是否含 L4
  "results": [ { "id": "test", "ok": true, "exit": 0, "tail": "…" }, … ]
}
```

- `tail` 是各门禁原始输出的尾部，L4 那条可能带着上游回给夹具的 token——
  所以落盘口挂着 `redactJson`（唯一写盘出口；接线由测试目检，行为由
  `evidence-redaction.test.ts` 的执行用例钉）。
- 复查一次门禁先看每条的 `exit` 字段，再看 `gitHead` 定位代码版本。

## "绿"的读法（本仓库的验收口径)

单次绿不构成"这条链稳定"的证据；报绿带**跑了几次、红了几次**。
已知会随环境抖动的两类：坏端口抽签（已修，见 troubleshooting）与按构造慢的
超时预算。红的那次运行必须保留整份日志。

## 与 CI 的对应

CI（`verify.yml`）跑的就是这条链：冷克隆 → 引导工具链 → `fetch:upstream` 重拉 vendor →
全量 `generate` → `npm run verify:all`。L4 不在 CI（要真实上游源码实例，结构性豁免，
本机 `-- --fixture` 才跑）。差异只剩一处：CI 用 `PYTHONIOENCODING=utf-8` 覆盖中文输出，
本机 Git Bash 默认 UTF-8 无需设。

## 相关

| 主题 | 去处 |
| --- | --- |
| CI 上这条链怎么跑 | [验证体系](../operations/verification.md) |
| 每一种红的处置 | [故障排查](../guides/troubleshooting.md) |
| 上游自动推进锚点 | [upstream-sync](../concepts/upstream-sync.md) |
