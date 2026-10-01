# 安装

把一台新机器的工具链引导到「`npm run verify:all` 的离线门禁全链都能跑」的状态
（清单与条数以 `docs/reference/gates.md` 和该命令的输出为准，本文不抄数字）。

> [!WARNING]
> 工具链版本以 [`tools.lock.json`](../../tools.lock.json) 为准，**不要凭记忆补版本号**——
> 锁里缺哪项，哪项就报错拒跑。

## 支持面（三个状态，各由什么证明）

| 平台 | 状态 | 由什么证明 |
| --- | --- | --- |
| Windows x64 | 已验证 | `verify.yml` 的 `verify` job（长期在跑） |
| Linux x64 | 有闸，尚无通过记录 | `verify.yml` 的 `verify-posix` job；它首航跑绿之前，本页不许写"Linux 已支持" |
| macOS | 未验证 | 无 CI job。未验证 ≠ 不支持，但**不要按支持面排期**；撞到实际问题再进 `RoadMap.md` 待认领表并附实测证据 |

依赖里唯一按平台分叉的是 venv 解释器目录（`Scripts` / `bin`）与 `go` / `go.exe`，
两处都由单源给出（`tools/gen/run.ts` 的 `VENV_BIN_DIR`、`tools/lib/go-toolchain.ts`）。
CI 因此不需要为某个 OS 另写一份命令，也不该在 workflow 里手写 venv 路径。

## 前置

| 依赖 | 版本（锁记录） | 说明 |
| --- | --- | --- |
| Node.js | v22.x（CI 用 24） | `npm ci` 与全部 tsx/vitest |
| Python | 3.12+ | 生成腿走 `.venv-gen`，探针/适配器测试走系统 python（仅标准库） |
| Go | 1.27.1 | 适配器与 oapi-codegen |
| Git | 任意新版 | 多条门禁直接 `git ls-files`/`git status` 取事实 |

> [!NOTE]
> Linux 上常见只有 `python3` 而没有 `python`：`npm run venv:bootstrap` 两个名字都会试，
> 但 `npm run test:py-adapter` 这类脚本调的是字面量 `python`（CI 的 setup-python 会提供它）。
> 本机 Linux 跑适配器腿前先确认 `python` 在 PATH 上（ Debian/Ubuntu 可装 `python-is-python3`）。

## 步骤

### 1. Node 依赖

```bash
npm ci
```

### 2. Python 生成环境（venv）

```bash
npm run venv:bootstrap
```

一条命令建 `.venv-gen` 并装 `openapi-python-client`：版本从 `tools.lock.json` 读，
解释器目录按平台解析（Windows `Scripts` / POSIX `bin`），系统解释器名 `python` 与 `python3`
都会试。别在 package.json 或 workflow 里另写 `pip install openapi-python-client==<某版本>`——
那会把锁变成一份需要人肉同步的第二真相。

> [!NOTE]
> `.venv-gen` 不入库。为什么必须走 venv 而不是系统 python：openapi-python-client 的
> post_hook（给产物补许可头）经 shell 执行，venv 的 Scripts/bin 不在 PATH 上时 ruff 与 hook
> 会**静默跳过**、exit 仍是 0——头部消失而生成"成功"。`tools/gen/run.ts` 会把 venv 前置进
> 子进程 PATH 再跑，这是唯一正确姿势。

### 3. Go 工具链

本机（Windows）按 `tools.lock.json → goInstall`：官方 zip 解压到锁记的 GOROOT，
**不写系统 PATH、不动注册表**。因此每个新终端要么自行

```bash
export PATH="<GOROOT>/bin:<GOPATH>/bin:$PATH"   # 两个目录都从 tools.lock.json / go env 推导
```

要么什么都不做——`npm run generate` 的 Go 腿与 `npm run test:go-adapter` 的启动器都会读锁里的
GOROOT、再补 `<GOPATH>/bin`（`go install` 的落点，oapi-codegen 在那里）前置进子进程 PATH。
找不到时它们带推导出来的目录退 1，**绝不静默 skip、也不写死某台机器的路径**。

### 4. oapi-codegen

```bash
go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.0
# 版本号取 tools.lock.json → generators["oapi-codegen"]
```

装完不需要动 PATH：上一条的落点由 `go env GOPATH` 推导，第 3 步的兜底会把它前置进去。

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
Go 段之后还会 `go mod init` + `go mod tidy`：init 只写 module 声明，require 清单与 `go.sum`
要 tidy 才长出来 —— 冷克隆实测过少了这一步时 `generated/go` 是个"没有依赖清单的模块"，
仓内测试照样绿（adapters/go 的 go.mod 替它兜着），一装到消费者机器就只剩 missing go.sum entry。
tidy 需要 module 缓存里有 `github.com/oapi-codegen/runtime`，离线机器第一次要联网。
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
