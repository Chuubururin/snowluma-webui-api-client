派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器

# spike 结论

回答 spike 预研的六问。样本 spec 现在住在
[`codegen-spike.sample-spec.yaml`](codegen-spike.sample-spec.yaml)（本页原先与它一起放在根级
`spike/` 下；正文里的命令与路径是当时的原样记录，不改写 —— 改写一段跑过的命令就等于伪造证据）。
本页讲"生成链为什么长成现在这样"：每条工具选型与每个手写形状的理由，都在下面按问题分节。

四类难点各占一处：
布尔 discriminator / multipart / SSE / T3 破坏性上传），由校验器复核：

```
$ node_modules/.bin/tsx tools/validate-spec.ts spike/minimal-spec.yaml
spike/minimal-spec.yaml: 0 error / 0 warning        (exit 0)
```

> [!WARNING]
> **【终审 I3b 更正——上面的 0 error 是 pre-R22 的历史测量】**
> 裁定 R22 之后，校验器补上了执法点 `DISCRIMINATOR_FORBIDDEN`，
> 本文件现在跑同一条命令的结果是 **1 error / exit 1**，位置就在
> `spec.components.schemas.LoginResult.discriminator`。
> 这不是回归、也不需要修：本文件是**被测输入**而非模板，它存在的目的就是把 discriminator 递到
> 三家生成器面前取证。校验器**没有**为 `spike/` 开白名单、规则也**没有**降为 warning——
> 那样做等于把 R22 的执法改回建议。`tools/` 下没有任何测试读这个文件
> （`tools/validate-spec.test.ts` 的 fixture 清单只覆盖 `spec/fixtures/`），所以这条 error
> 不会让测试变红；重跑本 spike 时看到 1 error 才是正确预期。
> 下方正文里所有"校验器 0 error"的表述同样按此阅读：它们记录的是当时的输入与该输入当时的判定，
> 唯一受影响的就是这份带 discriminator 的样本（`spike/out/nodisc-spec.yaml` 等无 discriminator 的
> 派生样本仍为 0 error）。

> [!NOTE]
> 注：`npx tsx -e` 在本机 Git Bash 下静默 no-op（`tools.lock.json` → prerequisites.fetchCommandNotes），
> 故所有本地 tsx 调用走 `node_modules/.bin/tsx`。生成物全部落在 `spike/out/`（已被 `.gitignore` 排除），
> 本文引用的是它们的原文片段，可凭下方命令复现。

## 环境实际版本

| 项 | 值 | 来源 |
| --- | --- | --- |
| `@hey-api/openapi-ts` | 0.99.0 | `tools.lock.json`，npx 实跑 |
| `openapi-python-client` | 0.29.1 | 同上，venv 内 pip 装 |
| `oapi-codegen` | v2.8.0 | `go install ...@v2.8.0`，`--version` 复核 |
| node | v22.23.1 | `node -v` |
| python | 3.14.6 | venv 解释器 |
| go | go1.27.1 windows/amd64 | `go version`（命令一律带 `GOTOOLCHAIN=local`） |
| typescript（hey-api 的 peer） | **5.9.3（手动指定）** | 见下"偏差 1" |

- **Python 3.14.6 无解析冲突**：`pip install openapi-python-client==0.29.1` 一次装完，关键依赖
  解析为 httpx 0.28.1 / pydantic 2.13.5 / attrs 26.1.0 / ruff 0.16.9 / typer 0.27.2。venv 在
  `spike/out/.venv`（在 `spike/out/` 下 → 被 gitignore，不入库，也不污染全局解释器）。
- Go 侧只下载了模块到 `C:\Users\Administrator\go\pkg\mod`（`go mod tidy`），未改系统 PATH、未改注册表。

## 命令实际形态与偏差（三项偏差，均为必要）

1. **`npx -y @hey-api/openapi-ts@0.99.0` 直接崩溃**（exit 1），与参数无关：

   ```
   file:///.../@hey-api/openapi-ts/dist/init-D6Y8JFUS.mjs:4017
           any: ts.SyntaxKind.AnyKeyword,
   TypeError: Cannot read properties of undefined (reading 'AnyKeyword')
   ```

   原因实测：该包 `peerDependencies.typescript = ">=5.5.3 || >=6.0.0 || 6.0.1-rc"`，npx 自动补装
   peer 时取到**最新版 `typescript@7.0.2`（Go 原生移植版）**，其包出口的 `.` 只映射到
   `./lib/version.cjs`，`ts.SyntaxKind` 为 `undefined`（本机 `node -e` 复核：`version 7.0.2
   SyntaxKind undefined`）。本仓库 devDependencies 也正是 `typescript: 7.0.2`，**同类崩溃随时会在
   任何"就地装 peer"的路径上复现**。可用形态是显式压一个 TS5 peer：

   ```
   npx -y -p '@hey-api/openapi-ts@0.99.0' -p 'typescript@5.9.3' openapi-ts -i ./spike/minimal-spec.yaml -o ./spike/out/ts
   → ✓ ./spike\out\ts · 4 files · 96ms   (exit 0)
   ```

   **客户端批次必须把 `typescript@5.x` 记为 hey-api 的生成期依赖约束**（`tools.lock.json` 需新增字段；
   本任务未改该文件）。

2. **`-i spike/minimal-spec.yaml` 被拒绝**：`Invalid Hey API shorthand format. Expected
   "organization/project"…`（exit 1）。必须写成 `./spike/...` 或绝对路径 —— `--input <path...>` 是
   变参选项，无前导 `./` 时按 Hey API 注册表简写解析。

3. **`openapi-python-client` 无 `-c/-p/-o` 短参数**，且 0.29.1 **没有 `update` 子命令**（`No such
   command 'update'`）。实际形态：

   ```
   spike/out/.venv/Scripts/openapi-python-client.exe generate \
     --path spike/minimal-spec.yaml --output-path spike/out/python --meta none
   → exit 0（带 warning：见 Q6 的 ruff/PATH 事项）
   ```

   Go 侧命令与简报一致（仅额外前置 `GOTOOLCHAIN=local` 与绝对路径）：

   ```
   oapi-codegen.exe -package snowluma -generate types,client spike/minimal-spec.yaml > spike/out/go/types.gen.go   # exit 0，stderr 空
   cd spike/out/go && go mod init example.com/slspike && go mod tidy && go build ./...                              # 全部 exit 0
   ```

   `go build ./...` **exit 0**，`go vet` 亦 exit 0。生成物 `go.mod` 被 `go mod init` 写成 `go 1.27.1`，
   配合 `GOTOOLCHAIN=local` 不会触发工具链二次下载。

## Q1 布尔 discriminator（propertyName: success, 取值 true/false）

### TS —— **产物被捏坏，判定不可用**

`spike/out/ts/types.gen.ts` 原文：

```ts
export type LoginSuccess = {
    success: true;
    token: string;
    mustChangePassword: boolean;
};

export type LoginNeedsTotp = {
    success: false;
    needsTotp: true;
};

export type LoginResult = ({
    success: 'true';
} & LoginSuccess) | ({
    success: 'false';
} & LoginNeedsTotp);
```

分支类型本身是对的（`enum:[true]` → `success: true` 字面量）；坏在 `discriminator.mapping` 的
**字符串键被原样注入**为 `success: 'true'`，与分支里的 `success: true` 求交 → `'true' & true` = `never`。
用 `typescript@5.9.3` 的 `tsc --noEmit --strict` 探针（`spike/out/ts/probe.ts`）证实：

```
spike/out/ts/probe.ts(9,14): error TS2322: Type 'LoginSuccess' is not assignable to type 'never'.
```

且同文件里的 `[LoginResult['success']] extends [never] ? true : false` 判定成功取到 `true`
（那一行没报错，报错只在赋值行）——即**没有任何服务端响应能被赋值为 `LoginResult`**，该联合在类型层面是空集。

### Python —— **discriminator 被完全忽略，且单值 enum 一并丢失**

`spike/out/python/models/__init__.py` 只导出四个模型，**没有 `LoginResult`**：

```python
from .login_body import LoginBody
from .login_needs_totp import LoginNeedsTotp
from .login_success import LoginSuccess
from .upload_debug_file_body import UploadDebugFileBody
```

（0.29.1 默认模板是 **attrs 类**，不是 pydantic —— 见"其他实测矛盾"。）响应类型塌为无标签联合，
分派靠**试解析 + 必填键是否存在**（`api/default/login.py`）：

```python
def _parse_response(*, client, response) -> LoginNeedsTotp | LoginSuccess | None:
    if response.status_code == 200:
        def _parse_response_200(data: object) -> LoginNeedsTotp | LoginSuccess:
            try:
                ...
                componentsschemas_login_result_type_0 = LoginSuccess.from_dict(data)
                return componentsschemas_login_result_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            ...
            componentsschemas_login_result_type_1 = LoginNeedsTotp.from_dict(data)
```

`enum: [true]` / `enum: [false]` 渲染为**裸 `bool`，零校验**（`models/login_success.py`：`success: bool`，
`from_dict` 里 `success = d.pop("success")` 直接取值）。用 venv 解释器实跑生成物（`spike/out/pyimp/probe.py`）：

```
LoginNeedsTotp(success=True) accepted -> LoginNeedsTotp(success=True, needs_totp=True, additional_properties={})
LoginSuccess(success=False) accepted -> LoginSuccess(success=False, token='t', must_change_password=False, additional_properties={})
```

即 tag 与分支矛盾时**照单全收**。再测分派顺序敏感性（`probe2.py`，同一 200 负载里两套必填键都齐、tag 为
`false`）：

```
真实成功分支      -> LoginSuccess
真实 needsTotp 分支 -> LoginNeedsTotp
tag=false 但键齐全 -> LoginSuccess        # ← tag 被无视，按分支书写顺序选错支
```

`literal_enums: true` 这个 config 开关**救不了**：它在字符串 enum 上确实生效
（`SKind = Literal['onlyValue']` + `check_s_kind` 运行时校验），但布尔 enum 仍是 `flag: bool` 且
`flag = d.pop("flag")` 无校验（`spike/out/py-enum-literal/`）。删掉 `discriminator` 块后 Python 产物
逐字节同构（`spike/out/py-nodisc/`）——它从头到尾没读过这个扩展。

### Go —— **编译通过但运行期两边都坏（读报错、写破坏 wire）**

`spike/out/go/types.gen.go` 生成了 union 包装 + 判别辅助（**不是**简报预期的"单 struct 全字段并集"）：

```go
type LoginResult struct {
	union json.RawMessage
}
...
func (t *LoginResult) FromLoginSuccess(v LoginSuccess) error {
	b, err := json.Marshal(v)
	...
	b, err = runtime.JSONMerge(b, []byte(`{"success":"true"}`))   // ← 字符串 tag
```

```go
func (t LoginResult) Discriminator() (string, error) {
	var discriminator struct {
		Discriminator string `json:"success"`                        // ← 按 string 读布尔字段
	}
```

把生成物真正 import 进模块跑探针（`spike/out/go/probe/main.go`，`go run ./probe`，exit 0）：

```
unmarshal(real wire bool tag) OK
ValueByDiscriminator(bool tag) -> value=<nil> err=json: cannot unmarshal bool into Go struct field .success of type string
AsLoginSuccess(bool tag) -> {MustChangePassword:false Success:true Token:t} err=<nil>
FromLoginSuccess -> JSON: {"mustChangePassword":false,"success":"true","token":"t"}
ValueByDiscriminator(string tag) -> value={false false t} err=json: cannot unmarshal string into Go struct field LoginSuccess.success of type snowluma.LoginSuccessSuccess
```

四条结论：① 读真实负载时官方判别 API **直接报错**；② 写方向产出的 tag 是 `"true"` 字符串，**发到
5099 就是错形状**（上游按布尔判）；③ 只有"生成器自己写的字符串 tag"能进 switch，但那时分支反序列化
又失败，即自循环也不闭合；④ 唯一可用的是 `AsLoginSuccess()` 这类**盲转**，等于要求调用方自己判别。

### 对设计口径的影响

**三家全部否定布尔 discriminator → 设计口径的版本决策需重开**（不是"决策成立"）。这是设计口径预告的唯一
翻案点，已翻。实测给出的方向有两条，都已取证（见"补充测量 A/B"）：

- **退路可用**：去掉 `discriminator`、只留 `oneOf` + `enum:[单值]` + 适配层手工判别，三家产物均正常
  （TS 收窄可用、Go 写方向恢复布尔 tag、Python 不比原状更差）。这不需要改 OpenAPI 版本。
- **"转 3.1 换回 `const`"只能救 TS 一家**，且要连带动 `tools/validate-spec.ts` 的两道关 —— 不构成重开
  后的默认答案。

## Q2 multipart 在 oapi-codegen 的产物可用性

**类型齐备、序列化路径为零 —— 判定"需手写编码，但可用"**。生成物：

```go
// UploadDebugFileMultipartBody defines parameters for UploadDebugFile.
type UploadDebugFileMultipartBody struct {
	File *openapi_types.File `json:"file,omitempty"`
}

// UploadDebugFileMultipartRequestBody defines body for UploadDebugFile for multipart/form-data ContentType.
type UploadDebugFileMultipartRequestBody UploadDebugFileMultipartBody
```

但 `ClientInterface` 上只有 `UploadDebugFileWithBody(ctx, contentType string, body io.Reader)`，
**没有任何生成函数接收上面两个类型**（grep 全文件仅命中这两处定义）。`openapi_types.File`
（`runtime@v1.7.0/types/file.go`）的 API 是 `InitFromMultipart` / `InitFromBytes` / `Bytes()` /
`Reader()` —— 面向服务端入站，客户端上传用不上它的便利。

实测客户端可行写法（`spike/out/go/probe3/main.go`，`go run ./probe3` exit 0）：用 `mime/multipart`
自行编码 + 生成器给的 `NewUploadDebugFileRequestWithBody`：

```
method: POST path: /api/debug/upload
content-type: multipart/form-data; boundary=1994efdd03679e9691512b384db4e3e0f28e0c0598727f8e8e4c6311112c
body contains filename part: true payload: true
```

另两家作为对照：**TS 可用**（`sdk.gen.ts` 用 `formDataBodySerializer` + `Content-Type: null` 让
fetch 自填 boundary，body 类型为 `file?: Blob | File`）；**Python 可用**（`UploadDebugFileBody.to_multipart()`
→ `_kwargs["files"] = body.to_multipart()`，`File` 自带 `to_tuple()`，`headers["Content-Type"] =
"multipart/form-data; boundary+++"` 由 httpx 覆写）。Go 批次的 Go 侧因此需要约 10 行 hand encoder，
落在适配层。

## Q3 SSE（text/event-stream）三家是否产出可用消费代码

**预期"三家都产不出"被 TS 一家推翻。**

- **TS：产出了真正的 SSE 消费代码**（这是否定项，须上报）。`sdk.gen.ts`：

  ```ts
  export const streamState = <ThrowOnError extends boolean = false>(options?: Options<StreamStateData, ThrowOnError, StreamStateResponse>): Promise<ServerSentEventsResult<StreamStateResponses>> =>
      (options?.client ?? client).sse.get<StreamStateResponses, unknown, ThrowOnError>({
          security: [{ scheme: 'bearer', type: 'http' }],
          url: '/api/state/stream',
          ...options
      });
  ```

  `core/serverSentEvents.gen.ts`（242 行）是完整的帧解析器：`\n\n` 切帧、`data:`/`event:`/`id:`/`retry:`
  逐行解析、每帧 `JSON.parse`（失败回落原文）、`Last-Event-ID` 重连、AbortSignal 取消、
  `TextDecoderStream` + reader 循环。**这是可用的流消费实现**，设计口径"不指望生成器产出可用的流消费
  代码"对 hey-api 0.99.0 不成立。

  两个必须同时记录的限制：① `eventName` 解析出来了但**不参与分派**，`stream` 只 yield data，所以多
  event-name 的流仍要手工路由；② yield 的类型来自 spec —— 我们的 `text/event-stream` schema 写的是
  `{type: string}`，于是产物类型是 `200: string`（`StreamStateResponses`），而真实帧是 JSON 对象，
  **spec 不写对 schema，产物类型就在说谎**（设计口径反例）。
- **Python：无。** `api/default/stream_state.py` 把响应整体读完后 `response_200 = response.text`，
  返回类型 `str | None`；全目录 grep `event-stream|Streaming` 零命中。httpx 请求走
  `client.get_httpx_client().request(**kwargs)`（非 stream），对不结束的流会一直阻塞。
- **Go：客户端无。** `Client.StreamState` 返回裸 `*http.Response`（Body 是流，够手写 scanner 用），
  但 `ClientWithResponses` 那条便捷路径 `ParseStreamStateResponse` 做的是
  `bodyBytes, err := io.ReadAll(rsp.Body)` + `defer rsp.Body.Close()` —— 对长连接是"把整条流缓冲成
  []byte 并关闭"，属于**主动错误**，客户端批次得规定 SSE 端点禁用 `*WithResponse`。
  （源码注记：oapi-codegen 的 `text/event-stream` 流式识别只存在于 strict-server 模板
  （`configuration.go` 的 `defaultStreamingContentTypes`），与客户端无关，本 spike 未生成服务端。）

## Q4 按状态码分 schema 的产物可读性

样本：`spike/out/status-spec.yaml`（200 → `LoginSuccess|LoginNeedsTotp` 无 discriminator，400/401 →
`LoginBadJson`，429 → `LoginRateLimited`；校验器 0 error）。三家都判**可读**：

- **TS 最佳** —— 成功/错误天然分表，注释带 description：

  ```ts
  export type LoginErrors = {
      /** 请求体不是合法 JSON */
      400: LoginBadJson;
      /** 密码错或第二因子错 */
      401: LoginBadJson;
      /** 触发限速 */
      429: LoginRateLimited;
  };
  export type LoginError = LoginErrors[keyof LoginErrors];
  export type LoginResponses = {
      /** 成功或需第二因子（同一状态码内二选一，无 discriminator） */
      200: LoginSuccess | LoginNeedsTotp;
  };
  ```

- **Go 良好** —— 每码一个字段 + 类型化 getter：

  ```go
  type LoginResponse struct {
      Body         []byte
      HTTPResponse *http.Response
      // JSON200 the response for an HTTP 200 `application/json` response
      JSON200 *Login200JSONResponseBody
      // JSON400 the response for an HTTP 400 `application/json` response
      JSON400 *LoginBadJson
      ...
  ```

- **Python 可用但扁平** —— 顺序 `if response.status_code == 400: ... LoginBadJson.from_dict(...)`，
  返回类型是所有码的并集 `LoginBadJson | LoginNeedsTotp | LoginSuccess | LoginRateLimited | None`，
  调用方需按 `isinstance` 分类；且 400 与 401 复用同一模型时**丢掉了"哪个码"这一信息**（要区分只能
  用 `Response.status_code`）。→ 支持设计口径"拆成三个 schema 不合并"的决定；另注：429 的等待秒数仍不可
  机读（设计口径已声明不提供文案正则 helper），产物里只有 `message: str`。

## Q5 Go union 塌缩形状与手写 UnmarshalJSON 的落点

- **塌缩形状**：`struct{ union json.RawMessage }` + `AsX()/FromX()/MergeX()` + `MarshalJSON/UnmarshalJSON`，
  有 discriminator 时再叠 `Discriminator() (string, error)` / `ValueByDiscriminator()`。**不是**简报预期的
  "单 struct 全字段并集"，也不丢类型（分支 struct 各自完整、字段级 `LoginSuccessSuccess bool` + `Valid()`
  都生成了）。真正的损失是**静态可判别性**：union 只是原始 JSON 容器，选支完全在运行期。
- **discriminator 在 Go 侧不可用**（Q1），所以 Go 批次的既定形态是：**spec 不写 `discriminator`，
  union 靠手写分派**。已实测该落点成立（`spike/out/go/probe2/main.go`，`go run ./probe2` exit 0）：
  适配层**新增一个包装类型**自带分派，不改生成物、不给生成类型加方法：

  ```go
  type LoginResultWire struct{ nod.LoginResult }

  func (t *LoginResultWire) UnmarshalJSON(b []byte) error {
      if err := t.LoginResult.UnmarshalJSON(b); err != nil { return err }
      var tag struct{ Success *bool `json:"success"` }
      if err := json.Unmarshal(b, &tag); err != nil { return err }
      if tag.Success == nil { return fmt.Errorf("缺少布尔判别字段 success") }
      ...
  }
  ```

  ```
  nodisc FromLoginSuccess -> JSON: {"mustChangePassword":false,"success":true,"token":"t"}
  hand wrapper dispatch OK -> LoginSuccess{MustChangePassword:false Success:true Token:t} err=<nil>
  non-boolean tag -> json: cannot unmarshal string into Go struct field .success of type bool
  ```

  要点：① **无 discriminator 的生成物写方向自己就对了**（布尔 tag 原样出网），所以手写量的只是读侧
  分派；② 落点必须在**生成目录之外**的适配层包里（`generated/` 永不手改，设计口径的物理隔离），因为
  生成物整体重写；③ 生成类型已有 `UnmarshalJSON`，**不能**用"给生成类型补方法"的常见 Go 手法，否则
  重复声明直接编译不过 —— 只能包装或代码生成前置模板。
- 附带实测（客户端批次需要）：布尔 enum 常量的命名会产出**包级裸标识符** `False`
  （`const False LoginNeedsTotpSuccess = false`），三个复刻样本里又都变成前缀式
  （`AFailSuccessFalse`），触发规则未能从形状推出。风险是 55 操作铺开时同名常量撞车 → 编译失败。
  缓解开关已验证：`compatibility: {always-prefix-enum-values: true}` 下同一份 spec 产出
  `LoginNeedsTotpSuccessFalse LoginNeedsTotpSuccess = false`，全包再无裸 `False`。建议客户端批次把它设为
  本项目 Go 生成的默认配置。

## Q6 许可头部注入机制 + 重新生成是否覆盖文件头

**先回答"会不会覆盖"：三家都会。** 手工把 banner 插到生成物首行再重跑原命令：

- hey-api：`types.gen.ts` 首行回到 `// This file is auto-generated by @hey-api/openapi-ts`。
- oapi-codegen：重跑后 `diff` 与"未插桩的干净产物"**完全一致**（`IDENTICAL_TO_PRISTINE`）。
- openapi-python-client：`generate` 对已存在目录**直接拒绝**（`Directory already exists. Delete it or
  use the --overwrite option.`）；加 `--overwrite` 后手写的那行 `# 手工追加的一行注释` 消失。

→ **结论：二次插入只在"每次都跑同一条命令"的前提下安全**，任何绕过命令的改动都会静默丢掉标注。故三家
都走生成器自身机制（三家都有，见下），客户端批次可据此把头部做成生成配置的一部分。

| 语言 | 注入机制（实测有效） | 关键细节 |
| --- | --- | --- |
| TS | config 文件 `output.header`（CLI 无对应参数，须 `-f cfg.ts`） | `header: ['// 派生自 …']` 实测生效；但它**替换**默认头而不是追加 —— 想保留 `// This file is auto-generated by @hey-api/openapi-ts` 要显式写在数组里，或传函数用 `ctx.defaultValue` |
| Python | config `post_hooks: [python ../add_header.py]` | 实测 14/14 文件带上 `# 派生自 …`。三个坑：hook 以 `shell=True` + **cwd=输出目录**执行、**不传文件名参数**（所以脚本得自己遍历 cwd）、hook 命令首 token 必须**不带引号且在 PATH 上**（`shutil.which`；绝对路径带引号 → `"…" is not in PATH`）。另：把 venv 的 `Scripts` 放进 PATH 后 ruff 格式化才会跑（否则每个文件都 "Skipping Integration"） |
| Go | `-templates <dir>` 覆盖 `imports.tmpl` | v2.8.0 **没有任何头部选项**：CLI 无 `--include/--header`（`--help` 全集已核对），config 无 `header` 字段（实测报 `field header not found in type main.configuration`）。"Code generated by … DO NOT EDIT." 来自 `pkg/codegen/templates/imports.tmpl`，在该模板首行加 banner 实测生效。代价：从此维护一份上游模板副本，与 v2.8.0 pin 绑定，升级须重 diff |

一处与设计口径的实测不符（不改文档，只登记）：设计口径说 "`oapi-codegen` 有 `--include`/header 选项"，
v2.8.0 无此二者；可行的只有 `-templates` 或生成后插入。

### Q6 追加：客户端批次把三家接进真管线时的 CLI/config 契约校正

上面那张表记的是**能力**（有 `output.header`、有 `post_hooks`、有 `-templates`），不是完整 CLI 契约。
真接进 `tools/gen/` 时逐条撞出下面这些，以 `--help` 与已装包的源码为准（只追加，不改上方结论）：

- **hey-api 的配置文件开关是 `-f/--file`，不是 `-c`**。`openapi-ts --help` 里 `-c, --client <name>`
  是"用哪个 HTTP client"，把 config 路径递给 `-c` 会被当 client 名。
  实跑形态：`npx -y -p @hey-api/openapi-ts@0.99.0 -p typescript@5.9.3 openapi-ts -f tools/gen/hey-api.config.ts`
  → `✓ ./generated\typescript · 4 files`，exit 0。config 里的 `input` 仍受偏差 2 的 `./` 规则约束。
- **openapi-python-client 0.29.1 的 `generate` 一个短参数都没有**：`-c/-o/-p` 全不存在，
  实跑形态是 `… generate --path spec/openapi.yaml --output-path generated/python
  --config tools/gen/python-config.yml --meta none --overwrite`。
  `--overwrite` 不是可选项而是**重跑的必需品**（Q6 上面已记"目录存在即拒绝"）。
- **config 文件里写 `post_hooks` 会整体替换默认钩子**（`config.py`：`if config_file.post_hooks is not None`），
  所以只列 add-header 这一条就等于悄悄关掉 ruff。正确写法是把默认的
  `ruff check . --fix-only --extend-select=I` 与 `ruff format .` 一并列出，并把头部钩子排在最后
  （否则 ruff 会把刚插入的注释行当游离注释重排）。
- **config 的包名键是 `project_name_override` / `package_name_override`**，不是 `project_name`/`package_name`。
  `ConfigFile` 是 pydantic 模型且默认忽略多余键，所以写错**不报错**，只会静默退回
  `"<openapi.info.title kebab>-client"` 这套名字，下游 import 路径全断。
- **oapi-codegen v2.8.0 没有 `-templates.addPayload` 这个 flag**（实测报
  `flag provided but not defined: -templates.addPayload`）。CLI 侧只有已废弃的 `-templates <dir>`，
  而且它把该目录下**每个**文件都当成一个模板覆盖项；不废弃的入口是 config 里的
  `output-options.user-templates`（映射模板名 → 值），值为**单行**时按文件路径读取
  （`codegen.GetUserTemplateText`：先试 `os.ReadFile`，多行才当模板正文）。
- **config 的新旧形态是自动推断的**：`generate:` 写成字符串列表会被判为 old-config-style
  （`main.oldConfiguration`，上游注释标注将来移除），新版要写 `generate: {models: true, client: true}`
  —— 注意新版里键叫 `models` 而不是 CLI 用的 `types`。
- **Windows 起子进程**：`npx` 是 `npx.cmd`，`spawnSync('npx', …)` 直接 ENOENT，必须 `shell: true`
  （因此 argv 里不能有空格与引号，`-p 'pkg@ver'` 要写成 `-p pkg@ver`）；
  `oapi-codegen` 反而是 `shell: false` 就能起（libuv 会自己补 `.exe`）。
- 三家的头部机制都会**静默失败**（Python 的 post_hook 不在 PATH 上时只报一句 warning、exit 仍 0），
  所以 `tools/gen/run.ts` 在每条命令跑完后会遍历产物文件、要求前 5 行内出现许可声明，否则 exit 1。

## 补充测量 A：设计口径的退路（`oneOf` + `enum:[单值]`，不写 discriminator）

`spike/out/nodisc-spec.yaml`（`spike/minimal-spec.yaml` 删去 discriminator 块；校验器 0 error）：

- TS：`export type LoginResult = LoginSuccess | LoginNeedsTotp;`，且 `tsc --strict` 探针里
  `r.success ? r.token : r.needsTotp` **收窄成立**（报错只在探针自身的字面量类型上：
  `Type 'string | true' is not assignable to type 'string'` —— 恰好证明 `r.token: string` 与
  `r.needsTotp: true` 都按分支被解析出来了）。
- Go：union 仍在（`As/From/Merge` 三件套），但**没有** `Discriminator()` 与错误的字符串 tag，
  `FromLoginSuccess` 产出布尔 tag（见 Q5 探针第一行）。
- Python：产物与带 discriminator 时同构（它本来就没读），tag 仍不校验 → 手工判别必须在适配层
  显式加一步"tag 与分支一致性断言"，不能只靠 `isinstance`。

## 补充测量 B：转 3.1 + `const` 能救回什么

`spike/out/v31-spec.yaml`（`openapi: 3.1.0` + `const: true/false` + 原 discriminator）：

- 本仓库校验器直接判非法：`ERROR [VERSION_NOT_3_0_3] openapi 必须为 3.0.3，实际 3.1.0` +
  三条 `ERROR [CONST_IN_OPENAPI_3_0]`，exit 1 —— **换 3.1 是工具链改动，不只是文档改动**。
- TS：**修好了** —— `LoginResult = ({success: true} & LoginSuccess) | ({success: false} & LoginNeedsTotp)`，
  `tsc --strict` 三断言（非 never / 可赋值 / 可收窄）**全绿，exit 0**。
- Python：接受 3.1 文档并生成，但 `success: bool` 依旧、discriminator 依旧被忽略 → 无改善。
- Go：`{"success":"true"}` 字符串 tag 与 `Discriminator() (string, error)` 依旧 → 无改善。

即：**3.1 只把三家里的一家从坏变好，另两家仍指向"去掉 discriminator、适配层手工判别"这一公共分母。**

## 其他实测矛盾（留给复核，本任务未改文档）

1. 设计口径表格写 Python 产物形态为 "httpx + **pydantic v2**，含 async"。实测 0.29.1 默认模板是
   **attrs**（`from attrs import define as _attrs_define`，模型是 `@_attrs_define class`，
   `from_dict` 手写、无 pydantic 校验器）。这条影响设计口径的"跑 jsonschema 校验 spec"能否借道 pydantic，
   也影响设计口径的归一化落点判断。
2. 设计口径 "不指望生成器产出可用的流消费代码" —— 对 `@hey-api/openapi-ts@0.99.0` 不成立（Q3）。
3. 设计口径的头部机制清单 —— `oapi-codegen` 无 `--include`/header（Q6）。

## 结论摘要

- **是否允许进入客户端批次：否（先重开设计口径）。** 阻塞项恰是设计口径预告的那一条：布尔 discriminator 三家全否。
  按设计口径自身文字，"若 spike 证明不可用 → 第一类退化 + 版本决策需重开"，条件已满足，须回 brainstorming
  收口后客户端批次才动笔。
- 重开时可直接采用的实测结论（均已取证，不必重跑）：
  1. **建模**：`oneOf` + `enum:[单值]`、**不写 `discriminator`**，三家均可用（补充测量 A）。
  2. **不必转 3.1**：3.1 只救 TS，且要改 `tools/validate-spec.ts` 两道关（补充测量 B）。
  3. Go 适配层需要：手写 union 分派（包装类型，勿加方法到生成类型）+ 约 10 行 multipart encoder +
     SSE 禁用 `*WithResponse`。
  4. Python 适配层需要：显式校验布尔 tag 与所选分支一致（生成物的试解析会静默选错支）。
  5. 头部三件套走生成器配置：TS `output.header` / Python `post_hooks` / Go `-templates`；
     三者都不接受"生成后手工插入"作为唯一路径（三家重新生成都会覆盖）。
  6. Go 生成加 `compatibility.always-prefix-enum-values: true`。
- **客户端批次之前要先补的 lock 事项**：hey-api 的 `typescript@5.x` 生成期约束（偏差 1）；Python 侧
  venv + `PATH=<venv>/Scripts`（否则 ruff/post_hook 不生效）。本任务未修改 `tools.lock.json`。
- 复现清单：`spike/out/` 下 `ts/`, `python/`, `go/`（三家主样本）、`ts-nodisc/` `py-nodisc/` `go/nodisc/`
  （测量 A）、`ts-status/` `py-status/` `go/status/`（Q4）、`ts-v31/` `py-v31/` `go/v31/`（测量 B）、
  `go/probe*/`（Go 运行期探针）、`pyimp/`（Python 运行期探针）。均不入库。
