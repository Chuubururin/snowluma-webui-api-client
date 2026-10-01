# 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
"""验证 findings Q1 的 Python 结论在真切片 spec 上仍成立。

断言全是**源码级**（读生成物的文本）。真正 import 生成包的那半边归
`npm run probe:py-import`（tools/gen/probe-import.py，跑在 .venv-gen 上 —— 它本来就带着
openapi-python-client 的依赖 attrs/httpx/pydantic，本探针旧 docstring 里"import 要新装包而
不授权装包"的说法实测为假，终审 W8 更正）。本文件的定位不变：纯 stdlib、系统 `python`
即可跑（R31），findings 的这几条本来就写在"生成器产出什么形状"这一层，文本就够定罪。

终审 W9 的重构：模块按**名字**定位（由 spec 里的 schema/operation 名映射 snake_case），
不再读作者记忆里的文件名 —— 一并关掉 backlog 的 B2/B3/B4/B5/B6：
  * B5 旧代码用子串挑文件（`"login_success" in name`），一旦出现 login_success_response.py
    就读错文件 ⇒ 一律改精确文件名。
  * B2 旧 docstring 声称 `LoginResult` 在整个 generated/python 不出现，代码却只查了
    api/auth/login.py 一个文件 ⇒ 现在真的扫全树。
  * B3 `login_needs_totp`（false 支）模块旧代码从不读 ⇒ attrs/裸 bool 现在两支都钉。
  * B4 `-> LoginNeedsTotp | LoginSuccess` 字面（顺序/空格/函数存在性全敏感）假红风险高 ⇒
    改钉带 schema 名的稳定变量 `componentsschemas_login_result_type_N`。
  * B6 相对 CWD 的路径 + 错目录时把失败归因成"先跑 npm run generate" ⇒ 锚在
    Path(__file__) 的仓库根，归因错位整类消除。

覆盖**两条** union（旧版只钉了作者记得的那条）：`LoginResult`（api/auth/login.py）与
`StateStreamFrame`（api/streams/stream_state.py —— models/ 下同样没有 state_stream_frame.py，
其匿名 union 是 7 元的且含 `str`，即 503 text/plain 那一支，findings Q3 的 Python 小节）。

第 3 组断言的方向与 task-10 brief 初稿**相反**（初稿断言 `Literal[True]` 存在）。初稿那条既不成立于
真产物（models/ 全目录 grep `Literal` 零命中），也不成立于 findings —— 生成器行为或 spec 形状一旦
真的变了，下面每条 exit 非 0 的消息都指明该回写 spike/findings.md 的哪一节。
"""

import hashlib
import json
import pathlib
import re
import sys

# B6：仓库根 = 本文件的 parents[2]（tools/gen/probe.py → tools → 根）。CWD 无关。
ROOT = pathlib.Path(__file__).resolve().parents[2]
GENERATED_PY = ROOT / "generated" / "python"
SPEC = ROOT / "spec" / "openapi.yaml"
# 终审 A4：先验血统再信形状。头部注入**替换**了生成器默认头，产物里没有任何版本戳，
# 所以"probe 绿"此前与"generated/ 被手改过 / spec 改完没重跑 generate"完全相容。
# 收据由 tools/gen/run.ts 写在 generated/.provenance.json（随产物一起被 .gitignore 排除）。
PROV = ROOT / "generated" / ".provenance.json"
if not PROV.is_file():
    sys.exit(
        f"{PROV} 不存在 —— 产物没有血统收据（A4 之后必须每跑一次 `npm run generate` 产一枚），"
        "跑它；若 generated/ 齐全却仍缺收据，说明有人绕开 run.ts 手放了产物"
    )
prov = json.loads(PROV.read_text(encoding="utf8"))
# 同一份 lock 既是 run.ts 拼命令的输入也是这里的对照物 —— banner/pin 都不在 Python 侧另抄一份（R18）
lock = json.loads((ROOT / "tools.lock.json").read_text(encoding="utf8"))
spec_sha = hashlib.sha256(SPEC.read_bytes()).hexdigest()
if prov.get("specSha256") != spec_sha:
    sys.exit(
        "产物血统不符：当前 spec/openapi.yaml 的 sha256 与收据不一致 —— 这正是收据要抓的两种情形"
        "（spec 改过没重新生成 / generated/ 被手改后又被算回去）。先跑 `npm run generate`；"
        "若刚跑过仍不符，收据与产物的生成时刻对不上，查是否绕开了 run.ts。\n"
        f"  收据={prov.get('specSha256')}\n  现值={spec_sha}\n  收据时刻={prov.get('generatedAt')}"
    )
if prov.get("banner") != lock.get("banner"):
    sys.exit(f"收据里的 banner 与 tools.lock.json → banner 不符：{prov.get('banner')!r}")
# 生成器 pin 与 lock 对账（收据必须是按当前 pin 生成的那一批）
if prov.get("generators") != lock.get("generators"):
    sys.exit(
        "产物收据里的生成器 pin 与 tools.lock.json 不一致 —— 生成之后 lock 又被动过，"
        f"或这批产物不是按当前 pin 生成的：\n  收据={prov.get('generators')}\n  lock={lock.get('generators')}"
    )
# R1（prework P3-5）第四道：收据必须声称"三家全量"。run.ts 现在会把**实际**生成的语言集
# 写进收据 languages —— 单跑一语言（如 `run.ts go`）的收据在这里就红，部分重生成不能再
# 冒充"三语言出自当前 spec"。旧收据没有该字段，同样过不了这道（升级即强制重跑全量）。
ran = prov.get("languages")
if not isinstance(ran, list) or set(ran) != {"typescript", "python", "go"}:
    sys.exit(
        "产物收据的语言集不是三家全量 —— 这是部分重生成的收据（R1），"
        f"languages={ran!r}。跑全量 `npm run generate` 再来本探针；"
        "不要为通过而放宽本道或手改收据（放宽 = 把这条守卫变成装饰）。"
    )
# 真产物是扁平的：`--output-path generated/python` + `--meta none` 直接把包内容铺在该目录下，
# 所以是 generated/python/models/ 而不是 brief 初稿写的 generated/python/snowluma_webui/models/
# （`package_name_override: snowluma_webui` 只进 pyproject 的包名，不生成那层目录）。
MODELS = GENERATED_PY / "models"

if not MODELS.is_dir():
    sys.exit(
        f"{MODELS} 不存在 —— generated/ 是 git-ignored 构建产物，"
        "跑一次 `npm run generate` 再跑本探针（本次缺的是产物，不是路径：路径锚在仓库根，任何 CWD 都对）"
    )


def snake(pascal: str) -> str:
    """spec 的 schema 名 → 生成物的模块文件名词干（openapi-python-client 的命名规则）。"""
    return re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", pascal).lower()


def read_model(schema: str) -> str:
    """按**精确文件名**读一个模型模块（B5：不做子串匹配）。"""
    f = MODELS / f"{snake(schema)}.py"
    if not f.is_file():
        sys.exit(f"{f} 不存在 —— 模型 {schema} 的生成物模块缺失或命名规则变了，findings 需复核")
    return f.read_text(encoding="utf8")


def read_api_module(stem: str) -> tuple[pathlib.Path, str]:
    """按 operation 文件名在 api/ 子树里定位分派模块；同名多文件时报歧义而不是瞎挑一个。"""
    hits = sorted(p for p in (GENERATED_PY / "api").rglob(f"{stem}.py"))
    if len(hits) != 1:
        sys.exit(
            f"api/ 下名为 {stem}.py 的分派模块应恰有一枚，实际 {len(hits)} 枚：{hits} —— "
            "目录形状与 findings 记录不符，探针按名字定位的前提没了"
        )
    return hits[0], hits[0].read_text(encoding="utf8")


# 全树一次性读完（B2 的"整个 generated/python"从此字面成立）；跳过缓存目录。
tree = {
    p: p.read_text(encoding="utf8")
    for p in GENERATED_PY.rglob("*.py")
    if "__pycache__" not in p.parts
}
if not tree:
    sys.exit(f"{GENERATED_PY} 存在但没有任何 .py —— 产物形状与 findings 记录不符")

# ---- (2) 两条 union 都没有生成物：模型模块不存在 + CamelCase 名字全树不出现 ----
for schema in ("LoginResult", "StateStreamFrame"):
    module_file = MODELS / f"{snake(schema)}.py"
    if module_file.exists():
        sys.exit(
            f"Python 侧竟生成了 {module_file.name} union 模块，与 findings Q1"
            "（'oneOf 塌为匿名无标签联合，union 类型根本不生成'）不符 —— 回写 spike/findings.md"
        )
    where = [str(p.relative_to(GENERATED_PY)) for p in tree if schema in tree[p]]
    if where:
        sys.exit(
            f"具名 {schema} 出现在 {where}，与 findings Q1 的'响应塌为匿名无标签联合'不符"
            " —— 改名/挪位/生成器行为变化都在此拦下 —— 回写 spike/findings.md"
        )

# ---- (4) 匿名试解析以带 schema 名的稳定变量为锚（B4），不钉 `-> A | B` 字面 ----
login_path, login_src = read_api_module("login")
for n in (0, 1):  # LoginResult 两支 ⇒ 两个试解析变量；一支都不许多
    if f"componentsschemas_login_result_type_{n}" not in login_src:
        sys.exit(
            f"{login_path} 里找不到 componentsschemas_login_result_type_{n} —— "
            f"login 的匿名试解析链形状变了（findings Q1），回写 spike/findings.md：\n{login_src[:600]}"
        )
stream_path, stream_src = read_api_module("stream_state")
for n in range(5):  # StateStreamFrame 五支
    if f"componentsschemas_state_stream_frame_type_{n}" not in stream_src:
        sys.exit(
            f"{stream_path} 里找不到 componentsschemas_state_stream_frame_type_{n} —— "
            "state/stream 的匿名试解析链不再是五支（spec 有 5 个分支），回写 spike/findings.md"
        )
if not re.search(r"\|\s*str\b", stream_src):
    sys.exit(
        f"{stream_path} 的匿名 union 里不再出现 str —— findings Q3 的 Python 小节"
        "（'response_200 = response.text，返回类型含 str'）需复核"
    )

# ---- (1)+(3) 两支 login 模型都是 attrs、都无 pydantic、布尔 tag 都是裸 bool ----
for schema, tag_fields in (("LoginSuccess", ("success",)), ("LoginNeedsTotp", ("success", "needs_totp"))):
    src = read_model(schema)
    if "from attrs import" not in src:
        sys.exit(f"{schema} 不再是 attrs：\n{src[:400]}")
    if "BaseModel" in src or "pydantic" in src:
        sys.exit(
            f"{schema} 里出现了 pydantic/BaseModel —— openapi-python-client 的默认模板"
            "不再是 attrs，findings 的'默认模板是 attrs'那条要回写：\n" + src[:400]
        )
    for field in tag_fields:
        if f"Literal[True]" in src or f"Literal[False]" in src:
            sys.exit(
                f"{schema} 的布尔单值 enum 如今渲染成 Literal —— 生成器行为变了"
                "（findings Q1 判的是'裸 bool 零校验'，且 spike 实测 `literal_enums: true` 也救不了布尔），"
                "必须回写 spike/findings.md"
            )
        if not re.search(rf"^\s+{field}:\s*bool\s*$", src, re.M):
            sys.exit(
                f"{schema}.{field} 不再是裸 bool —— findings Q1 的'零校验'结论需复核"
                f"（B3：false 支与 true 支同一条规则，两支都得钉）：\n{src[:600]}"
            )

print(
    "python 探针 OK：attrs（非 pydantic）+ 两条 union（LoginResult 两支、StateStreamFrame 五支）"
    "均无具名生成模块、以匿名 componentsschemas_<union>_type_N 试解析（`A | B`）"
    "+ 布尔单值 enum 退化为裸 bool"
)
