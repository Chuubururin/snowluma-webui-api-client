# 更新日志

本仓遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 口径，
版本号语义化（SemVer）。发版工件由 release-clients workflow 在契约变更时产出；
本文件记录仓库自身的 notable 变更，人工维护。

## [Unreleased]

## [0.1.0] — 首个公开基线

### Added
- 契约层：`spec/openapi.yaml`（55 操作 / 47 路径 / 101 schema），从上游源码提取，
  与锚定面（`spec/anchor.json`，47 份文件哈希）双向零漂移。
- 三语客户端：TypeScript（hey-api 0.99.0）/ Python（openapi-python-client 0.29.1）/
  Go（oapi-codegen v2.8.0）生成，逐文件许可横幅与血统收据。
- 统一适配器：TS / Python / Go 三份行为逐字一致（bootstrap 门控链、401 分治、
  destructive 闸门、规则引擎单源三实现），golden 夹具三语同题。
- demo：七屏套壳控制台，55 条操作三分对账（生效 / 写而不生效 / 登记放弃），
  未登记缺口恒为 0。
- 验证体系：L1–L4 四层测试（745+ 用例）、9 条离线门禁一键编排（`verify:all`）、
  L4 活夹具五条硬要求（本机）、变异检验台账。
- CI：verify 主链（windows-latest 全工具链引导）、词表重生成开 PR、
  每日上游探测（零判断自动推进 + 红类开工单）、契约变更发三语 Release 工件。

### Security
- SSRF 面硬化：`SNOWLUMA_STRICT_SSRF` 严格模式 + IPv4-mapped IPv6 归一化；
  `classifyHost` 的已知残余（废弃 IPv4-compatible 形）登记于 evidence §21.2。
- 证据脱敏防线：20 种凭据形状 + 逐形状幂等证明；`--check` 以「扫 0 份即红」防假绿。
- 凭据纪律：口令/token 不进命令行、文件、提交与 CI 日志。

### Changed
- demo 生成面收口：唯机械事实源为操作词表（`gen:check` 幂等门禁），
  四类被证伪的自动生成产物已删除并登记禁止重提。

[Unreleased]: https://github.com/Chuubururin/snowluma-webui-api-client/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Chuubururin/snowluma-webui-api-client/releases/tag/v0.1.0
