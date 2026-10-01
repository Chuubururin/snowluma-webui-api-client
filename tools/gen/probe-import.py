# 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
"""生成包的**真 import** 冒烟（终审 W8）。

与 probe.py 的分工：probe.py 是 stdlib 源码文本探针，留在系统 `python` 上（R31）；
本文件才动运行时 —— 用 `.venv-gen` 的解释器，因为生成包 import 期就需要 httpx + attrs
（openapi-python-client 0.29.1 的自带依赖，实测 `pip list`：attrs 26.1.0 / httpx 0.28.1 /
pydantic 2.13.5 全在）。probe.py 旧 docstring 说 import 需要"新装包、未获授权"，那句话
实测为假，本文件是它的反面证据：包在这台机器上**本来就能被 import**，此前只是没人试。

跑法（唯一正确形态，勿手敲变体）：`npm run probe:py-import`
—— 它走 `tools/py-venv-run.ts`，解释器目录名由 `tools/gen/run.ts` 的 `VENV_BIN_DIR` 按平台给出
（Windows 是 `Scripts`、POSIX 是 `bin`），所以这条腿不再依赖 package.json 里的反斜杠字面量；
把本文件挪成 venv 的 `-m` 目标是另一条死路
（此前 post_hook 那次栽在"带引号的绝对路径进 PATH 查找"，见 tools.lock.json
generationConstraints['openapi-python-client']）。

验什么（"可消费"的下限，逐层加）：
1) 整个生成包的所有子模块能被 import（语法、依赖、包结构三样一起成立）。
   产物是 `--meta none` 的扁平布局（包根 = generated/python 本身），模块里写的是
   `from ...client import ...`——直接把 `api.auth.login` 当顶层包挂上 sys.path 会炸
   "beyond top-level package"，所以必须用 spec_from_file_location 把 generated/python
   挂成一枚具名包再走相对导入，这同时钉住了"生成物的包结构自身成立"。
2) 模型能实例化、to_dict/from_dict 往返稳定（attrs 生成物真的可用）。
3) 匿名 union 的试解析在**真实响应对象**上的行为与 findings 逐字一致：
   login 两支 200（JSON）分对支；state/stream 的 401（普通 JSON）解析成 AuthGateError，
   而 200 帧（text/event-stream）必抛 TypeError —— 它把 `response.text` 整段喂给逐支
   from_dict，正是 findings Q3"Python 产不出可用流消费"的运行时证词。注意本脚本**不**验
   tag 一致性：`{success:true, needsTotp:true}` 会安静进 LoginSuccess 支（生成器就这么写的），
   设计口径把那条断言留给了适配层。
"""

import httpx  # .venv-gen 里应有（openapi-python-client 自带）；缺了就大声炸

import importlib
import importlib.util
import pathlib
import pkgutil
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
PKG = ROOT / "generated" / "python"
if not PKG.is_dir() or not (PKG / "__init__.py").is_file():
    sys.exit(f"{PKG}（含 __init__.py）不存在 —— 先跑 `npm run generate`（import 冒烟没有输入）")

# 把扁平产物挂成具名包 snowluma_gen（名字只在本次进程内存在，不装包、不写 sys.path 前门）
spec = importlib.util.spec_from_file_location("snowluma_gen", PKG / "__init__.py", submodule_search_locations=[str(PKG)])
pkg = importlib.util.module_from_spec(spec)
sys.modules["snowluma_gen"] = pkg
spec.loader.exec_module(pkg)

# ---- 1) 全子模块 import ----
loaded, failed = [], []
for mod in pkgutil.walk_packages(pkg.__path__, prefix="snowluma_gen."):
    if "__pycache__" in mod.name:
        continue
    try:
        importlib.import_module(mod.name)
        loaded.append(mod.name)
    except Exception as e:  # noqa: BLE001 —— 每个失败都要报，不许静默跳过
        failed.append(f"{mod.name}: {type(e).__name__}: {e}")
if failed:
    sys.exit("生成包 import 冒烟失败（模块 import 全量清单不许有一枚红）：\n  " + "\n  ".join(failed))

# ---- 2) 模型往返（attrs 可用性的下限） ----
from snowluma_gen.models import AuthGateError, LoginNeedsTotp, LoginSuccess

ok = LoginSuccess(success=True, token="t-1", must_change_password=False)
assert LoginSuccess.from_dict(ok.to_dict()) == ok, "LoginSuccess 往返不等"
nt = LoginNeedsTotp(success=False, needs_totp=True)
assert LoginNeedsTotp.from_dict(nt.to_dict()) == nt, "LoginNeedsTotp 往返不等"

# ---- 3) 匿名 union 试解析在真实字节上分对支 ----
from snowluma_gen.api.auth import login as login_mod
from snowluma_gen.api.streams import stream_state as stream_mod


def parse(module, *, status: int, json_body=None, text_body=None, content_type: str):
    kwargs = {"json": json_body} if json_body is not None else {"text": text_body}
    resp = httpx.Response(
        status_code=status,
        headers={"content-type": content_type},
        request=httpx.Request("GET", "http://example.invalid"),
        **kwargs,
    )
    return module._parse_response(client=None, response=resp)


# login：200 两支都真实可解析（application/json 路径是生成物的强项）
for payload, want in [
    ({"success": True, "token": "t-1", "mustChangePassword": False}, LoginSuccess),
    ({"success": False, "needsTotp": True}, LoginNeedsTotp),
]:
    got = parse(login_mod, status=200, json_body=payload, content_type="application/json")
    if not isinstance(got, want):
        sys.exit(
            f"login 对样本 {payload} 应解析成 {want.__name__}，实际 {type(got).__name__} —— "
            "试解析顺序/形状与 findings Q1 的记录不符"
        )

# state/stream：门控支（普通 JSON）可用……
got = parse(stream_mod, status=401, json_body={"status": "failed", "message": "x"}, content_type="application/json")
if not isinstance(got, AuthGateError):
    sys.exit(f"stream 的 401 门控响应应解析成 AuthGateError，实际 {type(got).__name__}")

# ……但 200 帧在生成物层面**必然解析失败**：stream_state.py 把 response.text（整段
# SSE 传输文本，不是 dict）喂给逐支 from_dict，最后 raise TypeError —— findings Q3
# "Python 产不出可用流消费"的运行时证词。若哪天它不炸了，是生成器行为变了，须回写 findings。
try:
    parse(stream_mod, status=200, text_body='data: {"kind": "ready"}\n\n', content_type="text/event-stream")
    sys.exit(
        "stream 的 200 帧竟然被生成物解析成功了 —— findings Q3 判'Python 产不出可用流消费'"
        "（response.text 整段喂 from_dict → TypeError），生成器行为变了，回写 spike/findings.md"
    )
except TypeError:
    pass  # 期望：Q3 的运行时形状，原样钉住

print(
    f"python import 冒烟 OK：{len(loaded)} 个子模块全部 import（httpx {httpx.__version__} + "
    "attrs 扁平包经具名挂载）+ 2 组模型 to_dict/from_dict 往返 + login 两支 200 分对 + "
    "stream 401 可解析、200 帧按 Q3 判词抛 TypeError"
)
