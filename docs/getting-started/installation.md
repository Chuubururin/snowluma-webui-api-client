# 安装

把一台新机器的工具链引导到「九条门禁都能跑」的状态。

> [!WARNING]
> 工具链版本以 [`tools.lock.json`](../../tools.lock.json) 为准，**不要凭记忆补版本号**——
> 锁里缺哪项，哪项就报错拒跑。

## 前置

| 依赖 | 版本（锁记录） | 说明 |
| --- | --- | --- |
| Node.js | v22.x（CI 用 24） | `npm ci` 与全部 tsx/vitest |
| Python | 3.12+ | 生成腿走 `.venv-gen`，探针/适配器测试走系统 python（仅标准库） |
| Go | 1.27.1 | 适配器与 oapi-codegen |
| Git | 任意新版 | 多条门禁直接 `git ls-files`/`git status` 取事实 |

Windows 说明：仓库按「开发机 = Windows + Git Bash」写成，`generate` 的脚本路径带
`\`（`.venv-gen\Scripts\python.exe`），POSIX 上需按 `.venv-gen/bin/python` 对应替换。
CI 因此固定跑 `windows-latest`。

## 步骤

### 1. Node 依赖

```bash
npm ci
```

### 2. Python 生成环境（venv）

```bash
python -m venv .venv-gen
.venv-gen/Scripts/python -m pip install "openapi-python-client==0.29.1"
```

> [!NOTE]
> `.venv-gen` 不入库。为什么必须走 venv 而不是系统 python：openapi-python-client 的
> post_hook（给产物补许可头）经 shell 执行，venv 的 Scripts 不在 PATH 上时 ruff 与 hook
> 会**静默跳过**、exit 仍是 0——头部消失而生成"成功"。`tools/gen/run.ts` 会把 venv 前置进
> 子进程 PATH 再跑，这是唯一正确姿势。

### 3. Go 工具链

本机（Windows）按 `tools.lock.json → goInstall`：官方 zip 解压到 `C:\go`，
**不写系统 PATH、不动注册表**。因此每个新终端要么自行

```bash
export PATH="/c/go/bin:$PATH"
```

要么什么都不做——`npm run test:go-adapter` 的启动器会读锁里的 GOROOT 兜底。
找不到 go 时它带指引退 1，**绝不静默 skip**。

### 4. oapi-codegen

```bash
go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.0
# 确认 <GOPATH>/bin 在 PATH 上
```

### 5. 上游源码缓存（vendor/upstream/）

```bash
npm run fetch:upstream
```

按 `spec/anchor.json` 记录的 40 位 commit 从 raw.githubusercontent.com 重拉 47 份文件。
这个目录被 gitignore，但 **drift、ui-coverage、build-anchor 基线绊线都读它**，
冷克隆不拉缓存这三条必红。脚本自带 12 次批级重试与锚点形状检查，细节见
[verification.md](../operations/verification.md)。

### 6. 三语 SDK 生成

```bash
npm run generate
```

TypeScript（hey-api 0.99.0 + peer typescript 5.9.3，硬约束）、Python（openapi-python-client
0.29.1）、Go（oapi-codegen v2.8.0）三段依次执行，每段成功后校验产物每个文件前 5 行
含许可横幅（三家都会静默丢横幅，这一步是全管线唯一的横幅执法点）。
产物落 `generated/`（不入库），并写血统收据 `generated/.provenance.json`。

## 验证装好了

```bash
npm run verify:all        # 9 条离线门禁
npx vitest run            # 只要测试面
```

退出码 0 即就绪。下一步去 [quickstart](quickstart.md) 把 demo 跑起来。

## 常见安装坑

- **probe 门禁红、说收据不是三家** — 只跑过 `npm run generate typescript`（单语言收据）。
  恢复动作就是它的原话：跑全量 `npm run generate`。别手改收据。
- **`npx tsx -e` 在 Git Bash 静默空跑**（exit 0 零输出）— 需要内联执行时用 `node_modules/.bin/tsx`。
- **Windows Python 控制台 UnicodeEncodeError** — 中文 runner 编码是 cp1252；
  CI 已在 job 级设 `PYTHONIOENCODING=utf-8`，本机手工跑 python 腿时同样先设这个。

## 相关

| 主题 | 去处 |
| --- | --- |
| 装好之后 | [十分钟起步](quickstart.md) |
| 命令逐项查询 | [命令参考](../reference/commands.md) |
| 安装类红的排查 | [故障排查](../guides/troubleshooting.md) |
