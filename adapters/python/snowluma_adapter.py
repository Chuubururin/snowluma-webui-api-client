# 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
"""SnowLuma WebUI 管理面 Python 适配层（设计口径）。

与 adapters/typescript/client.ts 语义逐条对应（规则单源、实现三份、输出必检）：

1. 归一化：响应体按 adapters/rules.json 单源规则表变换（设计口径）；
2. 门控引导：bootstrap_session 可重入循环（设计口径）——login → consent 闸 → 改密闸 →
   改密成功后服务端已 sessionTokens.clear()，必须用新密码回到 login；
3. 会话生命周期：401 按方法安全性分治（设计口径）——GET/HEAD 自动重登一次并重放原请求，
   例外是 /api/update/check（external-fetch，自动重放等于打外部版本源）；
   非幂等写方法 401 一律不重放，抛 SessionExpiredError。

纯 stdlib（R31）。**传输必须注入**：构造时传 transport(callable)，签名
`transport(method, path, opts) -> (status, parsed_json)`，opts 含 body/headers。
生产接线（urllib/httpx 皆可）与测试假传输的写法见 plan6 计划文档 §传输接线；
本模块刻意不内置任何 socket 代码 —— 传输策略是部署决策，注入是测试的显式缝隙。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable

def resolve_rules_path(here: Path) -> Path:
    """两个真实布局各一条，不加第三种回落（自定义规则表走 load_rules(path) 的显式入参）：

    - 装包后：`rules.json` 与本文件同目录（包内 sibling）—— 工件里的默认路径靠这条成立；
    - 仓 内 ：`adapters/rules.json`，在本文件的上一级（三语共用一张表）。

    写成接受 `here` 的纯函数而不是直接读 `__file__`：否则要验"包内优先"只能靠模块重载，
    测的就不是判据而是 sys.path 杂技。
    """
    sibling = here / "rules.json"
    return sibling if sibling.exists() else here.parent / "rules.json"


_DEFAULT_RULES = resolve_rules_path(Path(__file__).resolve().parent)

SAFE_METHODS = {"GET", "HEAD"}
NO_AUTO_REPLAY_PATHS = {"/api/update/check"}
BOOTSTRAP_MAX_PASSES = 4

Transport = Callable[[str, str, dict], "tuple[int, Any]"]


class RulesError(Exception):
    pass


class AdapterError(Exception):
    def __init__(self, message: str, kind: str, status: int | None = None):
        super().__init__(message)
        self.kind = kind
        self.status = status


class LoginError(AdapterError):
    def __init__(self, kind: str, message: str, status: int):
        super().__init__(f"登录失败（{kind}）：{message}", kind, status)


class TotpRequiredError(AdapterError):
    def __init__(self):
        super().__init__("需要第二因子（TOTP）：带 totp 重调 bootstrap_session", "totp-required")


class ConsentRequiredError(AdapterError):
    def __init__(self, documents: list, version: str):
        super().__init__(
            f"需要同意用户协议（version={version}）——同意是替操作者做的法律行为，"
            "默认不代做；显式传 accept_agreements=True 解锁",
            "consent-required",
        )
        self.documents = documents
        self.version = version


class PasswordWeakError(AdapterError):
    def __init__(self, rules: list):
        super().__init__("新密码未通过强度要求", "password-weak", 400)
        self.rules = rules


class PasswordChangeRequiredError(AdapterError):
    def __init__(self):
        super().__init__("服务端要求改密但未提供 newPassword", "password-change-required")


class SessionExpiredError(AdapterError):
    def __init__(self, method: str, path: str, reason: str):
        super().__init__(
            f"会话失效且不自动恢复（{method} {path}）：{reason}", "session-expired", 401
        )
        self.method = method
        self.path = path


def validate_rules(table: Any) -> dict:
    """按 rules.schema.json 的契约做结构校验（仓库不新增 ajv 依赖），不符即抛。"""
    if not isinstance(table, dict):
        raise RulesError("规则表必须是对象")
    if not isinstance(table.get("schemaVersion"), str) or not re.fullmatch(
        r"\d+\.\d+\.\d+", table["schemaVersion"]
    ):
        raise RulesError(f"schemaVersion 必须是 x.y.z 字符串：{table.get('schemaVersion')!r}")
    if not isinstance(table.get("rules"), list):
        raise RulesError("rules 必须是数组")
    seen: set[str] = set()
    allowed = {"id", "match", "op", "when", "unwrapKey", "rename"}
    for raw in table["rules"]:
        if not isinstance(raw, dict):
            raise RulesError("规则项必须是对象")
        rid = raw.get("id")
        if not isinstance(rid, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", rid):
            raise RulesError(f"规则 id 非法：{rid!r}")
        if rid in seen:
            raise RulesError(f"规则 id 重复：{rid}")
        seen.add(rid)
        match = raw.get("match")
        if not isinstance(match, dict) or not isinstance(match.get("path"), str) or not match["path"].startswith("/"):
            raise RulesError(f"{rid}: match.path 必须以 / 开头")
        if not isinstance(match.get("method"), str) or not re.fullmatch(r"[A-Z]+", match["method"]):
            raise RulesError(f"{rid}: match.method 必须大写")
        if raw.get("op") not in ("unwrap", "rename"):
            raise RulesError(f"{rid}: op 只能是 unwrap|rename：{raw.get('op')!r}")
        if raw["op"] == "unwrap":
            unwrap_key = raw.get("unwrapKey")
            if not isinstance(unwrap_key, str) or unwrap_key == "":
                raise RulesError(f"{rid}: unwrap 需要非空的 unwrapKey")
            when = raw.get("when")
            # when:null 与缺省同义（无条件解包）；when 只许是带非空字符串 hasKey 的对象，空对象非法。
            if when is not None and (
                not isinstance(when, dict) or not isinstance(when.get("hasKey"), str) or when.get("hasKey") == ""
            ):
                raise RulesError(f"{rid}: when.hasKey 必须是非空字符串")
        if raw["op"] == "rename":
            rename = raw.get("rename")
            if (
                not isinstance(rename, dict)
                or not isinstance(rename.get("from"), str)
                or rename["from"] == ""
                or not isinstance(rename.get("to"), str)
                or rename["to"] == ""
            ):
                raise RulesError(f"{rid}: rename 需要非空的 {{from,to}}")
        for key in raw:
            if key not in allowed:
                raise RulesError(f"{rid}: 未知键 {key}")
    return table


def load_rules(path: str | None = None) -> dict:
    p = Path(path) if path else _DEFAULT_RULES
    return validate_rules(json.loads(p.read_text(encoding="utf-8")))


def _template_to_regex(template: str) -> re.Pattern:
    parts = []
    for seg in template.split("/"):
        if seg.startswith("{") and seg.endswith("}"):
            # 段里不含换行：[^/] 会把尾换行吞进段内，"path\n" 就误命中了（TS/Go 同改，三语同形）。
            parts.append("[^/\\n]+")
        else:
            parts.append(re.escape(seg))
    # fullmatch 而不是 ^...$：Python 的 $ 在串尾换行符之前也命中，
    # "/api/status\n" 会误匹配 "/api/status"——TS/Go 都不会，三语同形必须去掉这个宽容。
    return re.compile("/".join(parts))


def apply_rules(rules: dict, method: str, path: str, body: Any) -> Any:
    """对成功响应体应用全部匹配规则（错误信封不归一化，走异常路径）。"""
    out = body
    for rule in rules["rules"]:
        match = rule["match"]
        if match["method"] != method.upper():
            continue
        if not _template_to_regex(match["path"]).fullmatch(path):
            continue
        if not isinstance(out, dict):
            continue
        if rule["op"] == "unwrap":
            when = rule.get("when") or {}
            has_key = when.get("hasKey")
            if has_key is not None and has_key not in out:
                continue
            inner = out.get(rule["unwrapKey"])
            if not isinstance(inner, dict):
                continue
            out = dict(inner)
        else:  # rename
            rename = rule["rename"]
            if rename["from"] not in out:
                continue
            if rename["from"] == rename["to"]:
                continue  # 改名到自己 = no-op，三语同形
            out = dict(out)
            out[rename["to"]] = out.pop(rename["from"])
    return out


class SnowlumaClient:
    """用法（测试/脚本）：client = SnowlumaClient(transport=fake_transport)。

    transport 签名：transport(method, path, opts) -> (status:int, parsed_json)，
    opts = {"body": Any|None, "headers": dict}。生产接线的 urllib/httpx 包装
    见 plan6 计划文档 §传输接线 —— 本模块不内置 socket 代码（传输策略是部署决策）。
    """

    def __init__(self, transport: Transport, rules: dict | None = None, rules_path: str | None = None):
        if not callable(transport):
            raise AdapterError("transport 必须是可调用对象（签名见类 docstring）", "protocol")
        # 注入的规则表与从磁盘读到的一样过结构校验：非法表静默失效等于把 fail-closed 洗成 fail-open。
        self._rules = validate_rules(rules) if rules is not None else load_rules(rules_path)
        self._transport = transport
        self._token: str | None = None
        self._password: str | None = None
        self._totp: str | None = None

    @property
    def token(self) -> str | None:
        return self._token

    def _call(self, method: str, path: str, body: Any = None, auth: str | None = None) -> tuple[int, Any]:
        headers = {"authorization": auth} if auth else {}
        return self._transport(method, path, {"body": body, "headers": headers})

    def _login_once(self, password: str) -> tuple[int, Any]:
        body: dict = {"password": password}
        if self._totp is not None:
            body["totp"] = self._totp
        return self._call("POST", "/api/login", body)

    @staticmethod
    def _as_object(body: Any, where: str) -> dict:
        """200 的响应体必须是对象。

        网关错误页、截断响应或被改写过的代理回包都会让 200 带上来一个字符串/数组/null。
        这跟"缺 token"是同一类协议分歧 ⇒ 报结构化的 protocol 错，而不是让调用方的
        `.get()` 抛 AttributeError（那条路径既没有 where 也没有形状信息，排查时等于空白）。
        """
        if not isinstance(body, dict):
            raise AdapterError(f"{where} 的 200 响应体不是对象（实为 {type(body).__name__}）", "protocol", 200)
        return body

    def _request_internal(self, method: str, path: str, body: Any, allow_relogin: bool) -> Any:
        if self._token is None:
            raise AdapterError("未建立会话：先 bootstrap_session", "no-session")
        status, data = self._call(method, path, body, f"Bearer {self._token}")
        if status == 401:
            if method in SAFE_METHODS and path not in NO_AUTO_REPLAY_PATHS and allow_relogin and self._password is not None:
                # 设计口径：安全方法 401 → 重登一次 → 重放原请求 → 仍失败抛错。
                st, login_body = self._login_once(self._password)
                if st == 200 and isinstance(login_body, dict) and isinstance(login_body.get("token"), str):
                    self._token = login_body["token"]
                    return self._request_internal(method, path, body, False)
                raise SessionExpiredError(method, path, "重登失败（密码可能已变更或账号被限速）")
            reason = (
                "该 GET 带 external-fetch 副作用标记，自动重放会打外部版本源"
                if method in SAFE_METHODS
                else "非幂等写方法不自动重放（重复执行有实际后果）"
            )
            raise SessionExpiredError(method, path, reason)
        if status >= 400:
            message = data.get("message") if isinstance(data, dict) else str(data)
            raise AdapterError(f"{method} {path} 失败（{status}）：{message}", "request-failed", status)
        return apply_rules(self._rules, method, path, data)

    def request(self, method: str, path: str, body: Any = None) -> Any:
        return self._request_internal(method.upper(), path, body, True)

    def bootstrap_session(
        self,
        password: str,
        new_password: str | None = None,
        accept_agreements: bool = False,
        totp: str | None = None,
    ) -> dict:
        """设计口径门控引导。可重入：改密成功（requireRelogin）后自动用新密码回到 login。"""
        self._password = password
        self._totp = totp
        for _ in range(BOOTSTRAP_MAX_PASSES):
            # ── 步骤 1：login ──
            status, body = self._login_once(password)
            if status != 200:
                message = body.get("message") if isinstance(body, dict) else str(body)
                kind = {401: "rejected", 429: "locked"}.get(status, "failed")
                raise LoginError(kind, str(message), status)
            body = self._as_object(body, "POST /api/login")
            if body.get("needsTotp") is True:
                raise TotpRequiredError()
            if not isinstance(body.get("token"), str):
                raise AdapterError("login 200 缺 token（形状与 spec LoginSuccess 不符）", "protocol")
            self._token = body["token"]
            must_change = body.get("mustChangePassword") is True

            # ── 步骤 2：consent 闸 ──
            st, raw_payload = self._call("GET", "/api/agreements", None, f"Bearer {self._token}")
            if st == 200:
                payload = self._as_object(raw_payload, "GET /api/agreements")
                if payload.get("consentRequired") is True:
                    version = payload.get("version")
                    if not isinstance(version, str):
                        raise AdapterError("同意闸 200 缺 version（record-consent 的必填体无从取得）", "protocol", 200)
                    if not accept_agreements:
                        raise ConsentRequiredError(payload.get("documents") or [], version)
                    st2, rec = self._call(
                        "POST",
                        "/api/agreements/record-consent",
                        {"version": version},
                        f"Bearer {self._token}",
                    )
                    if st2 == 409:
                        # 设计口径：409 {currentVersion} → 用返回版本重试，仅一次。
                        current = rec.get("currentVersion") if isinstance(rec, dict) else None
                        if not isinstance(current, str):
                            raise AdapterError("record-consent 409 缺 currentVersion", "protocol", 409)
                        st2, rec = self._call(
                            "POST",
                            "/api/agreements/record-consent",
                            {"version": current},
                            f"Bearer {self._token}",
                        )
                    if st2 != 200:
                        message = rec.get("message") if isinstance(rec, dict) else str(rec)
                        raise AdapterError(f"record-consent 失败（{st2}）：{message}", "request-failed", st2)

            # ── 步骤 3：改密闸 ──
            if not must_change:
                # ── 步骤 4：返回归一化会话状态 ──
                return {"token": self._token, "consentRequired": False, "mustChangePassword": False}
            if new_password is None:
                raise PasswordChangeRequiredError()
            st3, changed = self._call(
                "POST",
                "/api/auth/change-password",
                {"oldPassword": password, "newPassword": new_password},
                f"Bearer {self._token}",
            )
            if st3 == 400:
                if isinstance(changed, dict) and isinstance(changed.get("rules"), list):
                    raise PasswordWeakError(changed["rules"])
                message = changed.get("message") if isinstance(changed, dict) else str(changed)
                raise AdapterError(f"改密失败（400）：{message}", "password-failed", 400)
            if st3 != 200:
                message = changed.get("message") if isinstance(changed, dict) else str(changed)
                raise AdapterError(f"改密失败（{st3}）：{message}", "password-failed", st3)
            changed = self._as_object(changed, "POST /api/auth/change-password")
            if changed.get("success") is not True or changed.get("requireRelogin") is not True:
                raise AdapterError("change-password 200 形状与 spec PasswordChanged 不符", "protocol")
            # ★ 服务端已 sessionTokens.clear()，当前 token 当场作废 → 用新密码回步骤 1。
            password = new_password
            self._token = None
        raise AdapterError(f"bootstrap 循环超过 {BOOTSTRAP_MAX_PASSES} 轮仍未收敛", "protocol")
