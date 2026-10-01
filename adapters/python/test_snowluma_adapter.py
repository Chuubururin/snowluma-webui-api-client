# 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
"""snowluma_adapter 的 unittest 套件（脚本化假传输，无活实例）。

与 adapters/typescript/client.test.ts 的用例语义逐条对应；golden fixture 的
跨语言等价断言见 adapters/golden（两边读同一份 cases 文件）。
运行：python adapters/python/test_snowluma_adapter.py
"""

from __future__ import annotations

import unittest

from snowluma_adapter import (
    AdapterError,
    ConsentRequiredError,
    LoginError,
    PasswordChangeRequiredError,
    PasswordWeakError,
    RulesError,
    SessionExpiredError,
    SnowlumaClient,
    TotpRequiredError,
    apply_rules,
    load_rules,
    validate_rules,
)

LOGIN_OK = {"status": 200, "json": {"success": True, "token": "tok-1", "mustChangePassword": False}}
AGREEMENTS_NO_CONSENT = {"status": 200, "json": {"version": "v1", "consentRequired": False, "documents": []}}
AGREEMENTS_CONSENT = {
    "status": 200,
    "json": {
        "version": "v1",
        "consentRequired": True,
        "documents": [{"id": "eula", "title": "EULA", "declaredVersion": "1", "effectiveDate": "2026-01-01", "text": "条款"}],
    },
}


class Scripted:
    """按队列弹出响应；记录全部调用供断言。队列耗尽即抛错（不许静默）。"""

    def __init__(self, responses):
        self.calls: list[dict] = []
        self._queue = list(responses)

    def __call__(self, method, path, opts):
        self.calls.append({"method": method, "path": path, "body": opts.get("body"), "headers": opts.get("headers")})
        if not self._queue:
            raise AssertionError(f"脚本耗尽：{method} {path} 无对应响应（已 {len(self.calls)} 次调用）")
        item = self._queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item["status"], item["json"]


def no_rules():
    return {"schemaVersion": "1.0.0", "rules": []}


class BootstrapTests(unittest.TestCase):
    def test_直通(self):
        s = Scripted([LOGIN_OK, AGREEMENTS_NO_CONSENT])
        c = SnowlumaClient(transport=s, rules=no_rules())
        session = c.bootstrap_session("pw")
        self.assertEqual(session, {"token": "tok-1", "consentRequired": False, "mustChangePassword": False})
        self.assertEqual(s.calls[0]["path"], "/api/login")
        self.assertEqual(s.calls[0]["body"], {"password": "pw"})
        self.assertEqual(s.calls[1]["headers"], {"authorization": "Bearer tok-1"})

    def test_needs_totp(self):
        needs = {"status": 200, "json": {"success": False, "needsTotp": True}}
        s1 = Scripted([needs])
        c1 = SnowlumaClient(transport=s1, rules=no_rules())
        with self.assertRaises(TotpRequiredError):
            c1.bootstrap_session("pw")

        s2 = Scripted([{"status": 200, "json": {"success": True, "token": "t2", "mustChangePassword": False}}, AGREEMENTS_NO_CONSENT])
        c2 = SnowlumaClient(transport=s2, rules=no_rules())
        c2.bootstrap_session("pw", totp="123456")
        self.assertEqual(s2.calls[0]["body"], {"password": "pw", "totp": "123456"})

    def test_login_失败分类(self):
        for status, kind in ((401, "rejected"), (429, "locked"), (500, "failed")):
            s = Scripted([{"status": status, "json": {"success": False, "message": f"文案{status}"}}])
            c = SnowlumaClient(transport=s, rules=no_rules())
            with self.assertRaises(LoginError) as ctx:
                c.bootstrap_session("pw")
            self.assertEqual(ctx.exception.kind, kind)
            self.assertIn(f"文案{status}", str(ctx.exception))

    def test_login_200_非对象体_协议错(self):
        # 代理错误页 / 截断响应会把 200 的体写成字符串、null 或数组。
        # 这与"缺 token"是同一类协议分歧，不该以 AttributeError 收场（TS/Go 侧是结构化错误）。
        for body in ("<html>502 from proxy</html>", None, ["tok-1"], 42):
            s = Scripted([{"status": 200, "json": body}])
            c = SnowlumaClient(transport=s, rules=no_rules())
            with self.assertRaises(AdapterError) as ctx:
                c.bootstrap_session("pw")
            self.assertEqual(ctx.exception.kind, "protocol", f"体为 {body!r}")

    def test_agreements_200_非对象体或缺_version_协议错(self):
        bad_payloads = [
            ("网关把 200 写成了文本", "<html>…</html>"),
            ("缺 version 的同意体", {"consentRequired": True, "documents": []}),
        ]
        for why, payload in bad_payloads:
            s = Scripted([LOGIN_OK, {"status": 200, "json": payload}])
            c = SnowlumaClient(transport=s, rules=no_rules())
            with self.assertRaises(AdapterError, msg=why) as ctx:
                c.bootstrap_session("pw", accept_agreements=True)
            self.assertEqual(ctx.exception.kind, "protocol", why)

    def test_consent_默认不代同意(self):
        s1 = Scripted([LOGIN_OK, AGREEMENTS_CONSENT])
        c1 = SnowlumaClient(transport=s1, rules=no_rules())
        with self.assertRaises(ConsentRequiredError) as ctx:
            c1.bootstrap_session("pw")
        self.assertEqual(len(ctx.exception.documents), 1)
        self.assertEqual(ctx.exception.version, "v1")
        self.assertEqual(len(s1.calls), 2)  # 不应有 record-consent 调用

        s2 = Scripted([LOGIN_OK, AGREEMENTS_CONSENT, {"status": 200, "json": {"success": True, "version": "v1"}}])
        c2 = SnowlumaClient(transport=s2, rules=no_rules())
        c2.bootstrap_session("pw", accept_agreements=True)
        self.assertEqual(
            s2.calls[2],
            {"method": "POST", "path": "/api/agreements/record-consent", "body": {"version": "v1"}, "headers": {"authorization": "Bearer tok-1"}},
        )

    def test_consent_409_重试仅一次(self):
        s = Scripted(
            [
                LOGIN_OK,
                AGREEMENTS_CONSENT,
                {"status": 409, "json": {"success": False, "message": "版本不符", "currentVersion": "v2"}},
                {"status": 200, "json": {"success": True, "version": "v2"}},
            ]
        )
        c = SnowlumaClient(transport=s, rules=no_rules())
        c.bootstrap_session("pw", accept_agreements=True)
        consents = [x for x in s.calls if x["path"] == "/api/agreements/record-consent"]
        self.assertEqual(len(consents), 2)
        self.assertEqual(consents[0]["body"], {"version": "v1"})
        self.assertEqual(consents[1]["body"], {"version": "v2"})

    def test_改密闸三态(self):
        must_change = {"status": 200, "json": {"success": True, "token": "t3", "mustChangePassword": True}}
        s1 = Scripted([must_change, AGREEMENTS_NO_CONSENT])
        c1 = SnowlumaClient(transport=s1, rules=no_rules())
        with self.assertRaises(PasswordChangeRequiredError):
            c1.bootstrap_session("pw")

        s2 = Scripted([must_change, AGREEMENTS_NO_CONSENT, {"status": 400, "json": {"success": False, "message": "强度不足", "rules": [{"a": 1}]}}])
        c2 = SnowlumaClient(transport=s2, rules=no_rules())
        with self.assertRaises(PasswordWeakError) as ctx:
            c2.bootstrap_session("pw", new_password="np")
        self.assertEqual(ctx.exception.rules, [{"a": 1}])

        s3 = Scripted([must_change, AGREEMENTS_NO_CONSENT, {"status": 400, "json": {"success": False, "message": "当前密码不正确"}}])
        c3 = SnowlumaClient(transport=s3, rules=no_rules())
        with self.assertRaises(AdapterError) as ctx3:
            c3.bootstrap_session("pw", new_password="np")
        self.assertEqual(ctx3.exception.kind, "password-failed")
        self.assertNotIsInstance(ctx3.exception, PasswordWeakError)

    def test_改密200_非对象体_协议错(self):
        must_change = {"status": 200, "json": {"success": True, "token": "t3", "mustChangePassword": True}}
        for body in ("<html>502 from proxy</html>", None, ["ok"]):
            s = Scripted([must_change, AGREEMENTS_NO_CONSENT, {"status": 200, "json": body}])
            c = SnowlumaClient(transport=s, rules=no_rules())
            with self.assertRaises(AdapterError, msg=f"体为 {body!r}") as ctx:
                c.bootstrap_session("pw", new_password="np")
            self.assertEqual(ctx.exception.kind, "protocol", f"体为 {body!r}")

    def test_改密成功后用新密码重登(self):
        s = Scripted(
            [
                {"status": 200, "json": {"success": True, "token": "old", "mustChangePassword": True}},
                AGREEMENTS_NO_CONSENT,
                {"status": 200, "json": {"success": True, "requireRelogin": True}},
                {"status": 200, "json": {"success": True, "token": "new", "mustChangePassword": False}},
                AGREEMENTS_NO_CONSENT,
            ]
        )
        c = SnowlumaClient(transport=s, rules=no_rules())
        session = c.bootstrap_session("old-pw", new_password="new-pw")
        self.assertEqual(session["token"], "new")
        logins = [x for x in s.calls if x["path"] == "/api/login"]
        self.assertEqual(len(logins), 2)
        self.assertEqual(logins[0]["body"], {"password": "old-pw"})
        self.assertEqual(logins[1]["body"], {"password": "new-pw"})


class LifecycleTests(unittest.TestCase):
    def boot(self, responses):
        s = Scripted([LOGIN_OK, AGREEMENTS_NO_CONSENT, *responses])
        c = SnowlumaClient(transport=s, rules=no_rules())
        c.bootstrap_session("pw")
        return c, s

    def test_get_401_重登一次并重放(self):
        c, s = self.boot(
            [
                {"status": 401, "json": {"success": False, "message": "Token expired"}},
                {"status": 200, "json": {"success": True, "token": "tok-1", "mustChangePassword": False}},
                {"status": 200, "json": {"ok": True}},
            ]
        )
        out = c.request("GET", "/api/qq-list")
        self.assertEqual(out, {"ok": True})
        after = s.calls[2:]
        self.assertEqual(after[0]["path"], "/api/qq-list")
        self.assertEqual(after[1]["path"], "/api/login")
        self.assertEqual(after[1]["body"], {"password": "pw"})
        self.assertEqual(after[2]["path"], "/api/qq-list")

    def test_get_重登后仍401(self):
        c, _ = self.boot(
            [
                {"status": 401, "json": {"success": False, "message": "expired"}},
                {"status": 200, "json": {"success": True, "token": "tok-1", "mustChangePassword": False}},
                {"status": 401, "json": {"success": False, "message": "expired again"}},
            ]
        )
        with self.assertRaises(SessionExpiredError):
            c.request("GET", "/api/qq-list")

    def test_post_401_不重放(self):
        c, s = self.boot([{"status": 401, "json": {"success": False, "message": "expired"}}])
        with self.assertRaises(SessionExpiredError):
            c.request("POST", "/api/logs/level", {"level": "debug"})
        self.assertEqual(len(s.calls), 3)  # bootstrap 两步 + 原请求

    def test_external_fetch_例外(self):
        c, s = self.boot(
            [
                {"status": 401, "json": {"success": False, "message": "expired"}},
                {"status": 401, "json": {"success": False, "message": "expired"}},
                {"status": 200, "json": {"success": True, "token": "tok-1", "mustChangePassword": False}},
                {"status": 200, "json": {"ok": True}},
            ]
        )
        with self.assertRaises(SessionExpiredError):
            c.request("GET", "/api/update/check")
        self.assertEqual(len(s.calls), 3)  # 无重登
        c.request("GET", "/api/status")
        tail = s.calls[3:]
        self.assertTrue(any(x["path"] == "/api/login" for x in tail))  # cookie 例外走重放

    def test_其它4xx_带服务端message(self):
        c, _ = self.boot([{"status": 400, "json": {"success": False, "message": "无效的账号"}}])
        with self.assertRaises(AdapterError) as ctx:
            c.request("POST", "/api/debug/invoke", {})
        self.assertEqual(ctx.exception.kind, "request-failed")
        self.assertIn("无效的账号", str(ctx.exception))


class RulesTests(unittest.TestCase):
    def test_仓库规则表通过校验且_unwrap_生效(self):
        rules = load_rules()
        s = Scripted([LOGIN_OK, AGREEMENTS_NO_CONSENT, {"status": 200, "json": {"config": {"a": 1}}}])
        c = SnowlumaClient(transport=s, rules=rules)
        c.bootstrap_session("pw")
        self.assertEqual(c.request("GET", "/api/config/12345"), {"a": 1})

    def test_unwrap条件与_rename(self):
        rules = validate_rules(
            {
                "schemaVersion": "1.0.0",
                "rules": [
                    {"id": "cfg", "match": {"path": "/api/config/{uin}", "method": "GET"}, "op": "unwrap", "when": {"hasKey": "config"}, "unwrapKey": "config"},
                    {"id": "alias", "match": {"path": "/api/x", "method": "GET"}, "op": "rename", "rename": {"from": "old", "to": "new"}},
                ],
            }
        )
        self.assertEqual(apply_rules(rules, "GET", "/api/config/1", {"config": {"a": 1}}), {"a": 1})
        self.assertEqual(apply_rules(rules, "GET", "/api/config/1", {"other": 1}), {"other": 1})
        self.assertEqual(apply_rules(rules, "GET", "/api/x", {"old": 1, "keep": 2}), {"new": 1, "keep": 2})
        self.assertEqual(apply_rules(rules, "GET", "/api/other", {"config": {"a": 1}}), {"config": {"a": 1}})

    def test_结构校验拒绝(self):
        with self.assertRaises(RulesError):
            validate_rules({"schemaVersion": "1.0.0", "rules": [{"id": "a", "match": {"path": "/", "method": "GET"}, "op": "unwrap"}]})
        with self.assertRaises(RulesError):
            validate_rules(
                {
                    "schemaVersion": "1.0.0",
                    "rules": [
                        {"id": "a", "match": {"path": "/", "method": "GET"}, "op": "unwrap", "unwrapKey": "k"},
                        {"id": "a", "match": {"path": "/", "method": "POST"}, "op": "unwrap", "unwrapKey": "k"},
                    ],
                }
            )
        with self.assertRaises(RulesError):
            validate_rules({"schemaVersion": "1.0.0", "rules": [{"id": "a", "match": {"path": "/", "method": "GET"}, "op": "nope"}]})
        with self.assertRaises(RulesError):
            validate_rules({"schemaVersion": "bad", "rules": []})

    def test_transport必须注入(self):
        with self.assertRaises(AdapterError):
            SnowlumaClient(transport=None)  # type: ignore[arg-type]

    # 第四轮白盒的三语分叉收口：以下语义裁定在三份实现里逐字对齐，任何一侧回退即红。
    def test_三语同形_rename自改名_noop(self):
        rules = validate_rules(
            {"schemaVersion": "1.0.0", "rules": [{"id": "r1", "match": {"path": "/api/x", "method": "GET"}, "op": "rename", "rename": {"from": "a", "to": "a"}}]}
        )
        self.assertEqual(apply_rules(rules, "GET", "/api/x", {"a": 1, "b": 2}), {"a": 1, "b": 2})

    def test_三语同形_when_null_无条件与空对象拒绝(self):
        rules = validate_rules(
            {"schemaVersion": "1.0.0", "rules": [{"id": "u1", "match": {"path": "/api/x", "method": "GET"}, "op": "unwrap", "unwrapKey": "config", "when": None}]}
        )
        self.assertEqual(apply_rules(rules, "GET", "/api/x", {"config": {"v": 1}}), {"v": 1})
        with self.assertRaises(RulesError):
            validate_rules(
                {"schemaVersion": "1.0.0", "rules": [{"id": "u2", "match": {"path": "/", "method": "GET"}, "op": "unwrap", "unwrapKey": "config", "when": {}}]}
            )

    def test_三语同形_空串键拒绝(self):
        for bad in (
            {"id": "u3", "match": {"path": "/", "method": "GET"}, "op": "unwrap", "unwrapKey": ""},
            {"id": "r4", "match": {"path": "/", "method": "GET"}, "op": "rename", "rename": {"from": "", "to": "x"}},
            {"id": "r5", "match": {"path": "/", "method": "GET"}, "op": "rename", "rename": {"from": "x", "to": ""}},
        ):
            with self.assertRaises(RulesError, msg=str(bad)):
                validate_rules({"schemaVersion": "1.0.0", "rules": [bad]})

    def test_三语同形_路径尾换行不命中(self):
        rules = load_rules()
        body = {"config": {"a": 1}}
        # Python 的 $ 曾在串尾换行符之前也命中——fullmatch 裁定后与 TS/Go 同拒。
        self.assertEqual(apply_rules(rules, "GET", "/api/config/12345\n", body), body)

    def test_三语同形_注入非法规则表_构造即抛(self):
        s = Scripted([LOGIN_OK])
        with self.assertRaises(RulesError):
            SnowlumaClient(transport=s, rules={"schemaVersion": "1.0.0", "rules": [{"id": "bad"}]})


if __name__ == "__main__":
    unittest.main()
