// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
package adapters

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

// scriptedTransport：按队列弹出响应；记录全部调用供断言。队列耗尽即失败（不许静默）。
type scriptedCall struct {
	Method, Path string
	Body         any
	Headers      map[string]string
}

type scriptedTransport struct {
	calls     []scriptedCall
	responses []scriptedResponse
	t         *testing.T
}

type scriptedResponse struct {
	status int
	body   any
	err    error
}

func (s *scriptedTransport) transport(method, path string, opts TransportOpts) (int, any, error) {
	s.calls = append(s.calls, scriptedCall{Method: method, Path: path, Body: opts.Body, Headers: opts.Headers})
	if len(s.responses) == 0 {
		s.t.Fatalf("脚本耗尽：%s %s 无对应响应（已 %d 次调用）", method, path, len(s.calls))
	}
	r := s.responses[0]
	s.responses = s.responses[1:]
	if r.err != nil {
		return 0, nil, r.err
	}
	return r.status, r.body, nil
}

func newClient(t *testing.T, responses []scriptedResponse, rules RulesTable) (*SnowlumaClient, *scriptedTransport) {
	t.Helper()
	s := &scriptedTransport{responses: responses, t: t}
	c, err := NewSnowlumaClient(s.transport, rules, "http://127.0.0.1:5099")
	if err != nil {
		t.Fatalf("NewSnowlumaClient: %v", err)
	}
	return c, s
}

func noRules() RulesTable { return RulesTable{SchemaVersion: "1.0.0"} }

func loginOK() scriptedResponse {
	return scriptedResponse{status: 200, body: map[string]any{"success": true, "token": "tok-1", "mustChangePassword": false}}
}

func agreementsNoConsent() scriptedResponse {
	return scriptedResponse{status: 200, body: map[string]any{"version": "v1", "consentRequired": false, "documents": []any{}}}
}

func agreementsConsent() scriptedResponse {
	return scriptedResponse{status: 200, body: map[string]any{
		"version":         "v1",
		"consentRequired": true,
		"documents":       []any{map[string]any{"id": "eula", "title": "EULA", "declaredVersion": "1", "effectiveDate": "2026-01-01", "text": "条款"}},
	}}
}

func agreementsConsent缺Version() scriptedResponse {
	return scriptedResponse{status: 200, body: map[string]any{
		"consentRequired": true,
		"documents":       []any{map[string]any{"id": "eula"}},
	}}
}

func TestBootstrap直通(t *testing.T) {
	c, s := newClient(t, []scriptedResponse{loginOK(), agreementsNoConsent()}, noRules())
	session, err := c.BootstrapSession(BootstrapOptions{Password: "pw"})
	if err != nil {
		t.Fatalf("BootstrapSession: %v", err)
	}
	want := SessionState{Token: "tok-1"}
	if !reflect.DeepEqual(session, want) {
		t.Fatalf("session = %+v, want %+v", session, want)
	}
	if s.calls[0].Path != "/api/login" || !reflect.DeepEqual(s.calls[0].Body, map[string]any{"password": "pw"}) {
		t.Fatalf("login 调用不符：%+v", s.calls[0])
	}
	if s.calls[1].Headers["authorization"] != "Bearer tok-1" {
		t.Fatalf("agreements 应带 Bearer：%+v", s.calls[1])
	}
}

func TestBootstrapNeedsTotp(t *testing.T) {
	needs := scriptedResponse{status: 200, body: map[string]any{"success": false, "needsTotp": true}}
	s := &scriptedTransport{responses: []scriptedResponse{needs}, t: t}
	c, s := newClient(t, s.responses, noRules())
	_, err := c.BootstrapSession(BootstrapOptions{Password: "pw"})
	var totp TotpRequiredError
	if !errors.As(err, &totp) {
		t.Fatalf("期望 TotpRequiredError，实为 %v", err)
	}

	ok := scriptedResponse{status: 200, body: map[string]any{"success": true, "token": "t2", "mustChangePassword": false}}
	s2 := &scriptedTransport{responses: []scriptedResponse{ok, agreementsNoConsent()}, t: t}
	c2, s2 := newClient(t, s2.responses, noRules())
	if _, err := c2.BootstrapSession(BootstrapOptions{Password: "pw", Totp: "123456", TotpSet: true}); err != nil {
		t.Fatalf("带 totp 应通过：%v", err)
	}
	if !reflect.DeepEqual(s2.calls[0].Body, map[string]any{"password": "pw", "totp": "123456"}) {
		t.Fatalf("login 体应带 totp：%+v", s2.calls[0].Body)
	}
}

func TestBootstrapLogin失败分类(t *testing.T) {
	cases := []struct {
		status int
		kind   string
	}{
		{401, "rejected"},
		{429, "locked"},
		{500, "failed"},
	}
	for _, tc := range cases {
		s := &scriptedTransport{responses: []scriptedResponse{{status: tc.status, body: map[string]any{"success": false, "message": "文案"}}}, t: t}
		c, s := newClient(t, s.responses, noRules())
		_, err := c.BootstrapSession(BootstrapOptions{Password: "pw"})
		var le *LoginError
		if !errors.As(err, &le) {
			t.Fatalf("status=%d 期望 LoginError，实为 %v", tc.status, err)
		}
		if le.Kind != tc.kind {
			t.Fatalf("kind = %s, want %s", le.Kind, tc.kind)
		}
	}
}

// 200 的响应体不是对象 ⇒ AdapterError(protocol)。网关错误页/截断响应会让 200 带上字符串、
// null 或数组；按可选键读会静默跳过同意闸（fail-open），比抛错更糟——三语同形钉住。
func TestBootstrap200非对象体(t *testing.T) {
	nonObjects := []any{"<html>502 from proxy</html>", nil, []any{"tok-1"}, 42}
	for _, body := range nonObjects {
		// login 侧：非对象体不许以 nil-map 静默路径混过去
		responses := []scriptedResponse{{status: 200, body: body}}
		c, _ := newClient(t, responses, noRules())
		_, err := c.BootstrapSession(BootstrapOptions{Password: "pw"})
		var ae *AdapterError
		if !errors.As(err, &ae) || ae.Kind != "protocol" {
			t.Fatalf("login 体为 %v 期望 protocol 错，实为 %v", body, err)
		}
		// agreements 侧：非对象体不许静默跳过同意闸
		responses2 := []scriptedResponse{loginOK(), {status: 200, body: body}}
		c2, _ := newClient(t, responses2, noRules())
		_, err2 := c2.BootstrapSession(BootstrapOptions{Password: "pw"})
		var ae2 *AdapterError
		if !errors.As(err2, &ae2) || ae2.Kind != "protocol" {
			t.Fatalf("agreements 体为 %v 期望 protocol 错，实为 %v", body, err2)
		}
	}
	// 改密 200 非对象体：同一条 protocol 错
	responses := []scriptedResponse{
		{status: 200, body: map[string]any{"success": true, "token": "t3", "mustChangePassword": true}},
		agreementsNoConsent(),
		{status: 200, body: "<html>502 from proxy</html>"},
	}
	c, _ := newClient(t, responses, noRules())
	_, err := c.BootstrapSession(BootstrapOptions{Password: "pw", NewPassword: "np", NewPasswordSet: true})
	var ae *AdapterError
	if !errors.As(err, &ae) || ae.Kind != "protocol" {
		t.Fatalf("改密 200 体为字符串期望 protocol 错，实为 %v", err)
	}
}

func TestBootstrapConsent闸(t *testing.T) {
	s := &scriptedTransport{responses: []scriptedResponse{loginOK(), agreementsConsent()}, t: t}
	c, s := newClient(t, s.responses, noRules())
	_, err := c.BootstrapSession(BootstrapOptions{Password: "pw"})
	var consent *ConsentRequiredError
	if !errors.As(err, &consent) {
		t.Fatalf("期望 ConsentRequiredError，实为 %v", err)
	}
	if len(consent.Documents) != 1 || consent.Version != "v1" {
		t.Fatalf("documents/version 不符：%+v", consent)
	}
	if len(s.calls) != 2 {
		t.Fatalf("默认不代同意，不应有 record-consent：%+v", s.calls)
	}

	s2 := &scriptedTransport{responses: []scriptedResponse{
		loginOK(), agreementsConsent(), {status: 200, body: map[string]any{"success": true, "version": "v1"}},
	}, t: t}
	c2, s2 := newClient(t, s2.responses, noRules())
	if _, err := c2.BootstrapSession(BootstrapOptions{Password: "pw", AcceptAgreements: true}); err != nil {
		t.Fatalf("accept 后应通过：%v", err)
	}
	if s2.calls[2].Method != "POST" || s2.calls[2].Path != "/api/agreements/record-consent" ||
		!reflect.DeepEqual(s2.calls[2].Body, map[string]any{"version": "v1"}) {
		t.Fatalf("record-consent 调用不符：%+v", s2.calls[2])
	}
}

func TestBootstrapConsent缺Version走protocol(t *testing.T) {
	// consentRequired:true 但 version 缺失 ⇒ 必须 protocol 错，不可静默转 "" 后发出 record-consent。
	s := &scriptedTransport{responses: []scriptedResponse{loginOK(), agreementsConsent缺Version()}, t: t}
	c, _ := newClient(t, s.responses, noRules())
	_, err := c.BootstrapSession(BootstrapOptions{Password: "pw"})
	var ae *AdapterError
	if !errors.As(err, &ae) || ae.Kind != "protocol" {
		t.Fatalf("缺 version 期望 protocol 错，实为 %v", err)
	}
}

func TestBootstrapConsent409重试仅一次(t *testing.T) {
	s := &scriptedTransport{responses: []scriptedResponse{
		loginOK(), agreementsConsent(),
		{status: 409, body: map[string]any{"success": false, "message": "版本不符", "currentVersion": "v2"}},
		{status: 200, body: map[string]any{"success": true, "version": "v2"}},
	}, t: t}
	c, s := newClient(t, s.responses, noRules())
	if _, err := c.BootstrapSession(BootstrapOptions{Password: "pw", AcceptAgreements: true}); err != nil {
		t.Fatalf("409 重试后应通过：%v", err)
	}
	var consents []scriptedCall
	for _, call := range s.calls {
		if call.Path == "/api/agreements/record-consent" {
			consents = append(consents, call)
		}
	}
	if len(consents) != 2 {
		t.Fatalf("record-consent 应恰两次：%+v", s.calls)
	}
	if !reflect.DeepEqual(consents[0].Body, map[string]any{"version": "v1"}) ||
		!reflect.DeepEqual(consents[1].Body, map[string]any{"version": "v2"}) {
		t.Fatalf("重试版本不符：%+v", consents)
	}
}

func TestBootstrap改密闸(t *testing.T) {
	mustChange := scriptedResponse{status: 200, body: map[string]any{"success": true, "token": "t3", "mustChangePassword": true}}

	s1 := &scriptedTransport{responses: []scriptedResponse{mustChange, agreementsNoConsent()}, t: t}
	c1, s1 := newClient(t, s1.responses, noRules())
	_, err := c1.BootstrapSession(BootstrapOptions{Password: "pw"})
	var pcr PasswordChangeRequiredError
	if !errors.As(err, &pcr) {
		t.Fatalf("期望 PasswordChangeRequiredError，实为 %v", err)
	}

	s2 := &scriptedTransport{responses: []scriptedResponse{
		mustChange, agreementsNoConsent(),
		{status: 400, body: map[string]any{"success": false, "message": "强度不足", "rules": []any{map[string]any{"a": 1}}}},
	}, t: t}
	c2, s2 := newClient(t, s2.responses, noRules())
	_, err = c2.BootstrapSession(BootstrapOptions{Password: "pw", NewPassword: "np", NewPasswordSet: true})
	var weak *PasswordWeakError
	if !errors.As(err, &weak) {
		t.Fatalf("期望 PasswordWeakError，实为 %v", err)
	}
	if !reflect.DeepEqual(weak.Rules, []any{map[string]any{"a": 1}}) {
		t.Fatalf("rules 不符：%+v", weak.Rules)
	}

	s3 := &scriptedTransport{responses: []scriptedResponse{
		mustChange, agreementsNoConsent(),
		{status: 400, body: map[string]any{"success": false, "message": "当前密码不正确"}},
	}, t: t}
	c3, s3 := newClient(t, s3.responses, noRules())
	_, err = c3.BootstrapSession(BootstrapOptions{Password: "pw", NewPassword: "np", NewPasswordSet: true})
	var ae *AdapterError
	if !errors.As(err, &ae) || ae.Kind != "password-failed" {
		t.Fatalf("期望 password-failed AdapterError，实为 %v", err)
	}
	var weak2 *PasswordWeakError
	if errors.As(err, &weak2) {
		t.Fatalf("无 rules 的 400 不应是 PasswordWeakError")
	}
}

func TestBootstrap改密成功后重登(t *testing.T) {
	s := &scriptedTransport{responses: []scriptedResponse{
		{status: 200, body: map[string]any{"success": true, "token": "old", "mustChangePassword": true}},
		agreementsNoConsent(),
		{status: 200, body: map[string]any{"success": true, "requireRelogin": true}},
		{status: 200, body: map[string]any{"success": true, "token": "new", "mustChangePassword": false}},
		agreementsNoConsent(),
	}, t: t}
	c, s := newClient(t, s.responses, noRules())
	session, err := c.BootstrapSession(BootstrapOptions{Password: "old-pw", NewPassword: "new-pw", NewPasswordSet: true})
	if err != nil {
		t.Fatalf("BootstrapSession: %v", err)
	}
	if session.Token != "new" {
		t.Fatalf("session.Token = %q, want new", session.Token)
	}
	var logins []scriptedCall
	for _, call := range s.calls {
		if call.Path == "/api/login" {
			logins = append(logins, call)
		}
	}
	if len(logins) != 2 ||
		!reflect.DeepEqual(logins[0].Body, map[string]any{"password": "old-pw"}) ||
		!reflect.DeepEqual(logins[1].Body, map[string]any{"password": "new-pw"}) {
		t.Fatalf("重登序列不符：%+v", logins)
	}
}

func TestRequest401生命周期(t *testing.T) {
	t.Run("GET 401 → 重登一次并重放", func(t *testing.T) {
		s := &scriptedTransport{responses: []scriptedResponse{
			loginOK(), agreementsNoConsent(),
			{status: 401, body: map[string]any{"success": false, "message": "Token expired"}},
			loginOK(),
			{status: 200, body: map[string]any{"ok": true}},
		}, t: t}
		c, s := newClient(t, s.responses, noRules())
		if _, err := c.BootstrapSession(BootstrapOptions{Password: "pw"}); err != nil {
			t.Fatal(err)
		}
		out, err := c.Request("GET", "/api/qq-list", nil)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(out, map[string]any{"ok": true}) {
			t.Fatalf("out = %v", out)
		}
		after := s.calls[2:]
		if after[0].Path != "/api/qq-list" || after[1].Path != "/api/login" || after[2].Path != "/api/qq-list" {
			t.Fatalf("重放序列不符：%+v", after)
		}
	})

	t.Run("GET 重登后仍 401 → SessionExpiredError", func(t *testing.T) {
		s := &scriptedTransport{responses: []scriptedResponse{
			loginOK(), agreementsNoConsent(),
			{status: 401, body: map[string]any{"success": false, "message": "expired"}},
			loginOK(),
			{status: 401, body: map[string]any{"success": false, "message": "expired again"}},
		}, t: t}
		c, s := newClient(t, s.responses, noRules())
		if _, err := c.BootstrapSession(BootstrapOptions{Password: "pw"}); err != nil {
			t.Fatal(err)
		}
		_, err := c.Request("GET", "/api/qq-list", nil)
		var se *SessionExpiredError
		if !errors.As(err, &se) {
			t.Fatalf("期望 SessionExpiredError，实为 %v", err)
		}
	})

	t.Run("POST 401 → 不重放", func(t *testing.T) {
		s := &scriptedTransport{responses: []scriptedResponse{
			loginOK(), agreementsNoConsent(),
			{status: 401, body: map[string]any{"success": false, "message": "expired"}},
		}, t: t}
		c, s := newClient(t, s.responses, noRules())
		if _, err := c.BootstrapSession(BootstrapOptions{Password: "pw"}); err != nil {
			t.Fatal(err)
		}
		_, err := c.Request("POST", "/api/logs/level", map[string]any{"level": "debug"})
		var se *SessionExpiredError
		if !errors.As(err, &se) {
			t.Fatalf("期望 SessionExpiredError，实为 %v", err)
		}
		if len(s.calls) != 3 {
			t.Fatalf("不重放：应只有 bootstrap 两步 + 原请求，实 %d", len(s.calls))
		}
	})

	t.Run("external-fetch 例外与 cookie 例外", func(t *testing.T) {
		s := &scriptedTransport{responses: []scriptedResponse{
			loginOK(), agreementsNoConsent(),
			{status: 401, body: map[string]any{"success": false, "message": "expired"}},
			{status: 401, body: map[string]any{"success": false, "message": "expired"}},
			loginOK(),
			{status: 200, body: map[string]any{"ok": true}},
		}, t: t}
		c, s := newClient(t, s.responses, noRules())
		if _, err := c.BootstrapSession(BootstrapOptions{Password: "pw"}); err != nil {
			t.Fatal(err)
		}
		if _, err := c.Request("GET", "/api/update/check", nil); err == nil {
			t.Fatal("update/check 401 应抛错")
		}
		if len(s.calls) != 3 {
			t.Fatalf("external-fetch 例外：不重登，实 %d 次调用", len(s.calls))
		}
		if _, err := c.Request("GET", "/api/status", nil); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, call := range s.calls[3:] {
			if call.Path == "/api/login" {
				found = true
			}
		}
		if !found {
			t.Fatal("/api/status（cookie）应走重放")
		}
	})

	t.Run("其它 4xx → AdapterError 带服务端 message", func(t *testing.T) {
		s := &scriptedTransport{responses: []scriptedResponse{
			loginOK(), agreementsNoConsent(),
			{status: 400, body: map[string]any{"success": false, "message": "无效的账号"}},
		}, t: t}
		c, s := newClient(t, s.responses, noRules())
		if _, err := c.BootstrapSession(BootstrapOptions{Password: "pw"}); err != nil {
			t.Fatal(err)
		}
		_, err := c.Request("POST", "/api/debug/invoke", map[string]any{})
		var ae *AdapterError
		if !errors.As(err, &ae) || ae.Kind != "request-failed" || !strings.Contains(ae.Error(), "无效的账号") {
			t.Fatalf("期望 request-failed 带文案，实为 %v", err)
		}
	})
}

func TestRulesApply(t *testing.T) {
	table, err := LoadRules("../rules.json")
	if err != nil {
		t.Fatalf("LoadRules: %v", err)
	}
	if got := ApplyRules(table, "GET", "/api/config/12345", map[string]any{"config": map[string]any{"a": 1}}); !reflect.DeepEqual(got, map[string]any{"a": 1}) {
		t.Fatalf("unwrap 生效失败：%v", got)
	}
	if got := ApplyRules(table, "GET", "/api/config/12345", map[string]any{"other": 1}); !reflect.DeepEqual(got, map[string]any{"other": 1}) {
		t.Fatalf("hasKey 未命中应原样：%v", got)
	}

	custom, err := ValidateRulesJSON([]byte(`{"schemaVersion":"1.0.0","rules":[
		{"id":"cfg","match":{"path":"/api/config/{uin}","method":"GET"},"op":"unwrap","when":{"hasKey":"config"},"unwrapKey":"config"},
		{"id":"alias","match":{"path":"/api/x","method":"GET"},"op":"rename","rename":{"from":"old","to":"new"}}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := ApplyRules(custom, "GET", "/api/x", map[string]any{"old": 1, "keep": 2}); !reflect.DeepEqual(got, map[string]any{"new": 1, "keep": 2}) {
		t.Fatalf("rename 生效失败：%v", got)
	}
	if _, err := ValidateRulesJSON([]byte(`{"schemaVersion":"1.0.0","rules":[{"id":"a","match":{"path":"/","method":"GET"},"op":"nope"}]}`)); err == nil {
		t.Fatal("未知 op 应报错")
	}
}

// 第四轮白盒的三语分叉收口：以下语义裁定在三份实现里逐字对齐，任何一侧回退即红。
func TestRules三语同形(t *testing.T) {
	// rename from===to ⇒ no-op（键保留）
	custom, err := ValidateRulesJSON([]byte(`{"schemaVersion":"1.0.0","rules":[
		{"id":"r1","match":{"path":"/api/x","method":"GET"},"op":"rename","rename":{"from":"a","to":"a"}}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := ApplyRules(custom, "GET", "/api/x", map[string]any{"a": 1, "b": 2}); !reflect.DeepEqual(got, map[string]any{"a": 1, "b": 2}) {
		t.Fatalf("rename 自改名应 no-op：%v", got)
	}

	// when:null 与缺省同义 ⇒ 无条件解包
	nullWhen, err := ValidateRulesJSON([]byte(`{"schemaVersion":"1.0.0","rules":[
		{"id":"u1","match":{"path":"/api/x","method":"GET"},"op":"unwrap","unwrapKey":"config","when":null}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := ApplyRules(nullWhen, "GET", "/api/x", map[string]any{"config": map[string]any{"v": 1}}); !reflect.DeepEqual(got, map[string]any{"v": 1}) {
		t.Fatalf("when:null 应无条件解包：%v", got)
	}

	// when:{} / 空串键 / rules:null ⇒ 校验拒绝
	for name, raw := range map[string]string{
		"when:{}":      `{"schemaVersion":"1.0.0","rules":[{"id":"u2","match":{"path":"/","method":"GET"},"op":"unwrap","unwrapKey":"config","when":{}}]}`,
		"空unwrapKey":   `{"schemaVersion":"1.0.0","rules":[{"id":"u3","match":{"path":"/","method":"GET"},"op":"unwrap","unwrapKey":""}]}`,
		"空rename.from": `{"schemaVersion":"1.0.0","rules":[{"id":"r2","match":{"path":"/","method":"GET"},"op":"rename","rename":{"from":"","to":"x"}}]}`,
		"rules:null":   `{"schemaVersion":"1.0.0","rules":null}`,
	} {
		if _, err := ValidateRulesJSON([]byte(raw)); err == nil {
			t.Fatalf("%s 应校验拒绝", name)
		}
	}

	// 构造函数注入的非法表 ⇒ NewSnowlumaClient 报错（不静默 no-op）
	bad := RulesTable{SchemaVersion: "1.0.0", Rules: []Rule{{ID: "bad", Match: RuleMatch{Path: "/", Method: "GET"}, Op: "nope"}}}
	if _, err := NewSnowlumaClient(func(method, path string, opts TransportOpts) (int, any, error) { return 200, nil, nil }, bad, "http://127.0.0.1:5099"); err == nil {
		t.Fatal("注入非法规则表应在构造时报错")
	}
}
