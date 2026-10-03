# 安全政策

## 支持的版本

本仓不做包管理器发布，安全修复只落在 `main` 分支；GitHub Release 工件
（三语 SDK tarball）随发链产出，**只有最新一个 Release 受支持**——发现安全问题的
第一动作是拉最新 main，而不是为旧工件等补丁。

## 报告漏洞

1. **不要开公开 issue**：漏洞细节先私聊。仓库启用 GitHub 私密漏洞报告
   （Security 标签页 → Report a vulnerability），或按 CONTRIBUTING.md 里的联系方式
   联系维护者。
2. 报告请带：复现步骤 / 受影响的门禁或文件 / 你判断的影响面。
3. 修复窗口：确认后 7 天内出修复或给出临时缓解；修复提交按本仓惯例附
   「变异检验红/绿原文」。

## 本仓的安全口径（报告前先读）

多数「你觉得是问题」的项，可能已经按显式裁定处理过——先查这两张账再写报告：

| 口径 | 位置 |
| --- | --- |
| 安全姿态与已裁定豁免（SSRF 严格模式、口令留存取舍、L4 不进 CI 等） | [docs/operations/security.md](docs/operations/security.md) |
| demo 明确放弃的 UX 项（含安全相关放弃项） | [demo/declinations.ts](demo/declinations.ts) |
| 证据文件脱敏与已知残留（如 `::7f00:1` 废弃地址族） | [tools/redact-evidence.ts](tools/redact-evidence.ts) 头注 + evidence 文档各 § |

## 自动化防线

- PR/push：`.github/workflows/verify.yml` 跑 9 条离线门禁（含契约校验、漂移对账、
  证据脱敏扫描）。
- 每日：`upstream-sync.yml` 探测上游，锚点变更走人工审核，不自动合入。
- 依赖更新：dependabot（npm / GitHub Actions / pip）周更，安全补丁不延迟。

## 凭据纪律（对贡献者）

口令与 token **永不**进命令行、文件、提交与 CI 日志；证据落盘前必过
`tools/redact-evidence.ts`；活体验证只用一次性环回夹具，永不指向生产实例。
