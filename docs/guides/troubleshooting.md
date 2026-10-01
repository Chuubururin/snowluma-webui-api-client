# 故障排查：每一种已知红

先分流：**红的是断言，还是环境？** 环境红按"恢复"处理（下面的处置列全是恢复动作，
没有一条是"放宽检查"）；断言红是真缺陷，改代码不改门禁。

## 端口族（Windows 上最高频）

| 症状 | 根因 | 处置 |
| --- | --- | --- |
| `EADDRINUSE` | 那上面已有真实例 | 换端口；**绝不向不是自己起的实例写数据** |
| `EACCES` bind 失败 | 端口落在系统保留段：`netsh int ipv4 show excludedportrange protocol=tcp` | `SNOWLUMA_FIXTURE_PORT=<空闲端口>` 换掉（夹具）/ `SNOWLUMA_DEMO_PORT`（demo） |
| 偶发 `fetch failed / bad port`，单跑全绿、整套偶尔红 | undici 的 WHATWG 坏端口表拦掉 ≥1024 的 19 个端口（1719、2049、5060、6000、6665-6669、6697、10080…），而 `listen(0)` 在 Windows 动态端口段是**连续走位**，游标扫过那一带会连着几次全废 | 已修：`listen()` bind 后用真 fetch 验可达、`listen(0)` 换口重试（判据在 `tools/lib/port-probe.ts`，不抄表）；再遇到同类先看 `cause.message` 是不是 `bad port` |
| 实例起在 6667 之类端口上"只有 demo 连不上" | 同一张表的**三语分叉**：fetch 拦、urllib 与 net/http 放行 | 上游实例别放在那张表上（`demo/README.md` 有注） |

夹具端口默认 5299 也可能撞保留段——空串/未设回落 5299，其余必须 1024–65535 整数，
校验在 import 期就地报错（`Number('')===0` 会变成"随机端口"语义，不可接受）。

## 门禁链族

| 症状 | 根因 | 处置 |
| --- | --- | --- |
| `probe` 红，说收据不是三家 | 只跑过 `npm run generate typescript`，写了单语言 `.provenance.json` | 跑全量 `npm run generate`。别手改收据、别放宽这道 |
| `generate` 某语言失败后 `probe` 仍拿旧收据背书 | （已修）半途失败会删旧收据 | 直接重跑 `npm run generate` 全量 |
| `drift` 红：缓存哈希与 anchor 不符 / 计数不符 / commit 不是 40 位 SHA | vendor 缓存过期，或锚点被写坏 | 按报错打印的 `FETCH_RECOVERY` / `ANCHOR_COMMIT_REMEDIATION` 走：`fetch:upstream` 重拉（必要时人工确认新 SHA）→ `extract <SHA>` 重建 |
| `npm test` 里 build-anchor 基线用例红（ENOENT 或数不对） | 冷克隆没拉 vendor 缓存，或上游真的变了 | 先 `npm run fetch:upstream`；重拉后仍红才是基线漂移，走漂移流程 |
| ui-coverage 断言 2 报 Tier X | parity/declination 声称锚定的文件不在缓存面 | 补锚定面（`tools/lib/upstream.ts` 的清单 + anchor + expectedModels 三处同改） |
| `gen:demo` ENOENT 读不到 SDK | generated/ 不存在 | `npm run generate`（或只 typescript 一条腿） |

## 网络族

| 症状 | 根因 | 处置 |
| --- | --- | --- |
| 重拉反复 `ECONNRESET`（errno -4077） | 本机 DNS/IPv6 路径 + fetchUpstream 无逐文件重试（一批里一条断、整批重来） | `fetch:upstream` 已内建 `ipv4first` 与 12 次批级重试；手动跑旧命令才需要 `NODE_OPTIONS=--dns-result-order=ipv4first` |
| CI 上 Python 腿 `UnicodeEncodeError` | 英文 Windows runner 控制台 cp1252 打不了中文 | CI 已 job 级 `PYTHONIOENCODING=utf-8`；本机手工跑同样先设 |

## 测试自身

- **用例顶到 5000ms 默认预算**：按构造就慢的用例（`resetModules()` + 重新 import 生成 SDK 全图）
  要给真实钟（`{ timeout: 20000 }`）并把实测数字写进注释，不要拆断言凑快。
- **`Test Files 2 failed` 但只看到一条的名字**：那次运行的整份日志没落盘。红 run 必须留全日志再分析，
  "后来没复现"不等于"不存在"。
- **退出码经过管道会撒谎**：`cmd | tail` 取到的是 `tail` 的码。取码直接 `$?`，日志先落文件再 grep。

## 起不来 / 卡住

- demo 端口占用现在会点名并提示换端口（不再裸栈崩）。
- `tsx -e` 内联脚本在 Git Bash 下静默空跑（exit 0 零输出）——用 `node_modules/.bin/tsx`。
- 子进程"挂起不返回"优先怀疑读 stdin 的命令：门禁工具链里所有 spawn 显式
  `stdio[0]='ignore'`（`tools/integrity-check.ts` 头注记着这条来历）。

## 相关

| 主题 | 去处 |
| --- | --- |
| 门禁清单与报告读法 | [gates.md](../reference/gates.md) |
| 环境引导 | [安装](../getting-started/installation.md) |
| 网络与凭据的边界 | [安全姿态](../operations/security.md) |
