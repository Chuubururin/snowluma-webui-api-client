# 安全政策

## 支持的版本

本仓不做包管理器发布，安全修复只落在 `main` 分支；GitHub Release 工件
（三语 SDK tarball）随发链产出，**只有最新一个 Release 受支持**——发现安全问题的
第一动作是拉最新 main，而不是为旧工件等补丁。

## 报告漏洞

1. **不要开公开 issue**：漏洞细节先进私密通道。
   - 首选 GitHub 私密漏洞报告（仓库 Security 标签页 → *Report a vulnerability*）。
     **本文件不声称它已启用**：该开关只能在仓库 Settings → Advanced Security 里看，
     REST 侧读不到，因此属于仓库所有者的一次性动作（已登记在 [`RoadMap.md`](RoadMap.md)）。
   - 兜底通道（当下唯一可执行的一条）：开一个**标题与正文都不含任何漏洞细节**的 issue，
     标题写"安全问题：请提供私密通道"，正文只写受影响范围（如"生成面/适配层/CI 凭据链"）
     与你的 GitHub 句柄。细节在私密通道建立之后再给——这条不依赖任何联系方式，
     因为本仓不公开维护者的邮箱或 IM。
2. 报告请带：复现步骤 / 受影响的门禁或文件 / 你判断的影响面。
3. 修复窗口：确认后 7 天内出修复或给出临时缓解；修复提交按本仓惯例附
   「变异检验红/绿原文」。

## 本仓的安全口径（报告前先读）

多数「你觉得是问题」的项，可能已经按显式裁定处理过——先查这两张账再写报告：

| 口径 | 位置 |
| --- | --- |
| 安全姿态与已裁定豁免（SSRF 严格模式、口令留存取舍、L4 不进 CI 等） | [docs/operations/security.md](docs/operations/security.md) |
| demo 明确放弃的 UX 项（含安全相关放弃项） | [demo/declinations.ts](demo/declinations.ts) |
| 证据文件脱敏与已知残留（如 `::7f00:1` 废弃地址族） | [tools/redact-evidence.ts](tools/redact-evidence.ts) 头注 + [docs/operations/security.md](docs/operations/security.md) 的"内嵌 IPv4 提取"一节 |

## 自动化防线

- PR/push：`.github/workflows/verify.yml` 跑离线门禁全链（含契约校验、漂移对账、证据脱敏扫描；
  清单与条数以 `tools/verify-all.ts` 的 `GATES` 为准，本页不抄数字）。
- 供应链：`.github/workflows/security-posture.yml` 在每次 PR 与每日定时核依赖漏洞
  （`npm audit` + PR 新增依赖审查）。它刻意**不并进** `verify:all`：
  那条链的性质是离线可跑，而这几条要出网。
  开放告警**没有** CI 汇总腿：`dependabot/alerts` 在 workflow 自带 token 下结构性读不到（403），
  详见 [安全姿态页](docs/operations/security.md) 那一节 —— 把它写进 workflow 只会得到一条天天红、
  人人都学会忽略的腿。
- 每日：`upstream-sync.yml` 探测上游，锚点变更走人工审核，不自动合入。
- 依赖更新：dependabot 三条生态（npm / GitHub Actions / gomod，清单见 `.github/dependabot.yml`）
  周更，且 Dependabot 安全更新已开启。原先这里写的是 pip —— 那是条**声明了但不生效**的面：
  仓内没有任何 pip 清单文件可解析，它只会持续产出失败的 update job（现由
  `tools/dead-control.test.ts` 执法）。
- 平台侧开关（本页每条都可复核，复核命令一并写出，免得日后又变成一句无源断言）：

  | 主张 | 复核命令 |
  | --- | --- |
  | 密钥扫描与 push 保护已开 | `gh api repos/<owner>/<repo> -q .security_and_analysis` |
  | 依赖漏洞告警已开 | `gh api repos/<owner>/<repo>/vulnerability-alerts --include`（期望 204） |
  | Dependabot 安全更新已开 | `gh api repos/<owner>/<repo> -q .security_and_analysis.dependabot_security_updates.status` |
  | 当前开放告警有几条（**要真实凭据**：workflow 自带 token 跑这条必 403） | `gh api "repos/<owner>/<repo>/dependabot/alerts?state=open" --jq length` |
  | required check 只有 `verify` | `gh api repos/<owner>/<repo>/branches/main/protection -q .required_status_checks.contexts` |

## 凭据纪律（对贡献者）

口令与 token **永不**进命令行、文件、提交与 CI 日志；证据落盘前必过
`tools/redact-evidence.ts`；活体验证只用一次性环回夹具，永不指向生产实例。
