# 安全姿态

这个 demo 持有操作者口令并代理真实实例——安全面按"纵深防御 + 每条判据有机器执法"组织。

## 网络面

| 措施 | 实现 | 执法 |
| --- | --- | --- |
| 只绑环回 | demo server `listen(port, '127.0.0.1')`——绑 0.0.0.0 等于把口令交给整张局域网 | 代码审查点（start.ts 注释钉着理由） |
| 请求体上限 | 10 MB 双闸：Content-Length 预检 + 无 CL 时累计字节中途截断 ⇒ 400 | `readCtx`；两条路径各有用例 |
| STRICT_SSRF | `SNOWLUMA_STRICT_SSRF=1` 时目标只许公网类 | `classifyHost` 边界用例钉类别两侧 |

### classifyHost 判据（历史绕过全部收口的地方）

输入先过 `new URL()` 归一化，再按类判定，顺序敏感：

1. 剥 IPv6 方括号（不剥时 `[::1]` 落 public——最初的洞）；
2. **内嵌 IPv4 提取** `embeddedIPv4()`：`::ffff:g1:g2`（IPv4-mapped）、
   `::g1:g2`（IPv4-compatible，RFC 4291 已废弃形）、`64:ff9b::g1:g2`（NAT64 well-known）
   三种压缩前缀统一按尾两组十六进制还原 dotted-quad 再分类；
3. 然后才是 `127./::1/localhost → loopback`、`fc00::/7、10/192.168/172.16-31 → private`、
   `fe80::/10、169.254 → link-local`。

三个已知绕过（裸 IPv6、`::ffff:`、废弃形/NAT64）都是白盒审计实测出来的，各带回归用例；
内嵌**公网**地址（`64:ff9b::808:808`）按还原后的 8.8.8.8 归类放行——收拢不过宽也有用例。

## 会话与凭据

- 口令只在服务端内存（`Upstream.password`），浏览器永不回传凭据；改密步由服务端代持旧口令完成。
- `setBaseUrl` 与 token/口令**同进同退**：换目标 = 旧会话作废，且门禁状态缓存一并清理
  （不清会拿上一台的判断替这一台放行）。
- 401 分治、会话过期、2FA 分支按判别联合处理——`UpstreamError` 保留状态码与原错误体，
  全仓非 2xx 只在 `unwrap()` 一处折叠（第二个折叠点 = ui-coverage 断言 7 红）。
- 上游错误正文带传输层 `cause`（`fetch failed ← bad port`），500 不再是光秃秃一句话。

## 输入处理

- **deepMerge** 拒绝 `__proto__`/`constructor`/`prototype`（配置 patch 来自 HTTP 请求体）；
  自有键消失断言钉住"静默丢弃"语义。
- **uin 格式闸**从 spec 的 path 参数 pattern 现读现构造（`UIN_RE`），读不到就拒绝启动——
  手写正则的两份旧副本已删，结构守卫禁止字面量回来。
- 未知 uin 的配置读写被存在性核拒掉（上游对不存在的 uin 会回 200 + 全局默认配置
  **带真实访问令牌**——实测过，不是推断）。
- XSS：所有插值走 `esc()`；`uploadBackgroundImage` 等只走 multipart 真调用。
- 上传/备份按 spec 的 replay 分级：T3（如群发）**永不自动重放**，L4 只打 T1/T2。

## 已裁定的设计豁免（有理由，不是遗漏）

| 决定 | 理由 | 兜底 |
| --- | --- | --- |
| `POST /set-base-url` 免认证 | 登录前必须能配目标（鸡生蛋）；真实边界是 STRICT_SSRF + classifyHost | SSRF 判据全套用例 |
| `GET /appearance` 的 401 不带 step | 登录前公开读，"会话死了"在设计流程里不可达 | 可达形状（上游回门控码）有测试 |
| demo 不发 `credentials=1` 备份 | 含凭据的备份会落进浏览器下载 | declination `export-credentials` |
| 外观写回不渲染（write-only） | 屏幕与面板对齐，不含视觉系统（用户裁定） | declination `appearance-visual` |

全部"决定不做"的条目在 `demo/declinations.ts`，带出处与裁定人，
`ui-coverage` 断言"未登记缺口 = 0"。

## 秘密的入库口与不可回收性

落盘唯一出口 `redactJson`（机制见 [verification.md](verification.md)）。
但记住边界：本工具洗的是**工作树**——已经进过 git 历史的值在历史、备份、
别人的克隆里，只能轮换不能收回。生产实例的 accessToken 生命周期与 session token
差一个数量级，所以脱敏形状表按"三种寿命都要盖"设计。

债账已结一笔，防止被当未决项重提：uin10000 的两枚 accessToken 已轮换作废——泄漏源实测
定位在 `GET /api/config/10000` 的 `httpServers[0]`/`wsServers[0]`，轮换经操作者授权执行，
新值只存在于仓外。曾提交进历史的残留值随轮换成死值，且本仓历史已压缩重建为单条初始
提交，旧提交对象在本地与 GitHub 均已不存在。

## 外部静态扫描器：报告怎么读、主张怎么立

会话侧挂着一个停止钩子型静态扫描器（产物在 `.mimosa/`，本仓不控制其规则集）。
它的报告极易被误读，所以对"扫描通过/发现清零"类主张做过一轮取证。结论（原始产物在
`.mimosa/`，不入库，逐份编号不再引用）：

- 32 份不可变报告中 **31 份 `run_status=inconclusive`**，作用域一律
  `coverage.scope=hook_observed_diff`（只扫本会话 diff，且变更文件数上限 20），
  `rules_version` 全部 `unavailable`。唯一一份 `completed` 的
  `tokens.model_calls=0`（`measurement=known-zero`）——只有确定性阶段跑过，
  不得引作"AI 复核通过"。
- 记录过发现的只有一份报告：fc=5
  （命令注入 blocked×3 + candidate×1、路径穿越 candidate×1），
  `evidence_boundary=semgrep candidate`，`runtime_verification=not_performed`。
  靶点全在已并回主干、随后删除的 `.worktrees/rest-generation/` 上；其中 4 处是
  `RegExp.exec(…)` 被当成命令执行 sink、1 处是变量路径 `readFile(…)`。
- 台账有 3 个批次 `observedFindingIds` 非空而 `events=[]`、对应报告 `finding_count=0`——
  发现被观测到但没进正式清单，是覆盖不全，不是清零。
- 豁免通道查证结果：没有。无 semgrep/snyk/bandit 配置文件；全仓唯一的
  `noqa` 在 `tools/gen/probe-import.py:58`，是 flake8 的 BLE001 指令，
  不是对这个扫描器的抑制。

口径由此定死：**"门禁扫描发现清零"这类话不许说**——扫描器连自己扫没扫全都不知道。
钉住代码形状的是本仓自己的 `verify:all` 门禁链与变异检验（见
[verification.md](verification.md)），外部扫描器的任何红/绿只作线索、不作证据。

> [!NOTE]
> 补充：仓级扫描通道确实存在——本节的取证只覆盖**会话钩子**那套产物
> （`.mimosa/`），而 `~/.qodersec/bin/qodersec.exe scan --platform qoder --all` 是
> 整仓云扫描（CodeSec 云引擎，走当前登录态，异步出报告）。已对 main 提交过整仓扫描。
> 云报告的发现计数同样受本节口径约束：
> 它说的是"这一次扫描看到了什么"，永远不是"本仓干净"。
>
> 追加反例：`--async=false` 的同步扫描即使云端终态是 `canceled`，CLI 仍打印
> "No security issues found."并以 0 计数落盘 JSON——**canceled 任务的 0 是缺席，不是
> 干净**，引用前必须先在 `~/.qodersec/logs/qodersec.log` 核对 `poll result` 的终态
> （只认 `status=completed`）。两次同步重跑均 `canceled`（`timed_out=false`），
> 终态明细只能在登录态的 Qoder Security 控制台查看。

## 相关

| 主题 | 去处 |
| --- | --- |
| 脱敏机制与扫描面 | [verification.md](verification.md) |
| 许可口径与 Release 边界 | [`spec/NOTICE.md`](../../spec/NOTICE.md) |
| API 的重放分级 | [api.md](../reference/api.md) |
