# 十分钟起步

前提：已完成 [安装](installation.md)（六步引导 + `npm run verify:all` 退出码 0）。

## 1. 起 demo 控制台

```bash
npm run demo
```

默认 `http://127.0.0.1:6097`，目标上游实例默认 `http://127.0.0.1:5099`。
两个都可换：

```bash
SNOWLUMA_DEMO_PORT=7100 SNOWLUMA_DEMO_BASE_URL=http://192.168.1.20:5099 npm run demo
```

端口占用/系统保留段不再裸栈崩：会点名原因并提示换端口（`SNOWLUMA_DEMO_PORT=<空闲端口>`）。

## 2. 浏览器走一遍门禁

打开 `http://127.0.0.1:6097`：

1. **登录屏** — 输入上游实例的 WebUI 口令。上游口令只在服务端内存里存活，浏览器永不回传凭据。
2. **同意闸**（如果上游开了协议同意）— 读出 `getAgreements` 的那份 version，勾选后 `recordConsent`。
3. **改密闸**（如果 `mustChangePassword`）— demo 用内存里的旧口令代你完成改密并重登。
4. 进门后是 **7 个面板**：总览 / 进程 / 配置 / 日志 / 设置 / 调试，外加门禁屏自身。

成功判据：六个业务面板都有内容、浏览器网络面板里没有 4xx。

## 3. 看一遍契约与覆盖

```bash
npm run inventory        # 55 条操作的分面清单（与 spec 同源生成）
npm run ui-coverage      # 覆盖报告：effective / write-only / 未登记三段账
```

`ui-coverage` 的输出就是这个项目的完成定义：**55 条操作，每一条要么有控件且生效
（effective）、要么写了但不渲染（write-only）、要么登记了放弃原因——三者之外必须为 0**。

## 4. 跑一次带活体的验证（可选，需要一台可牺牲实例）

```bash
SNOWLUMA_FIXTURE_PORT=<空闲端口> npm run verify:all -- --fixture
```

第 10 条 L4 会拉起一台**全新一次性**上游实例（非 dev 模式、随机初始口令），
跑门禁矩阵、净零写回、流首帧、SSE 锚点、2FA 五条硬要求，然后整目录删掉。
口令不进命令行也不进文件。夹具依赖的上游源码在 `snowluma-live` 检出里（`SNOWLUMA_LIVE_ROOT` 可改）。

## 相关

| 我想…… | 去处 |
| --- | --- |
| 改行为 | [架构与设计概要](../concepts/architecture.md) · [开发循环](../concepts/workflow.md) |
| 上游加了 API | [加一条操作](../guides/add-an-operation.md) |
| 门禁红了 | [故障排查](../guides/troubleshooting.md) |
| 看 API 契约细节 | [API 调用规范](../reference/api.md) |
