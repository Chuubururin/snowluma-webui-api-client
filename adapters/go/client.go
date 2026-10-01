// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
package adapters

import (
	"encoding/json"
	"fmt"
	"strings"
)

// 与 adapters/typescript/client.ts、adapters/python/snowluma_adapter.py 语义逐条对应
// （规则单源、实现三份、输出必检）：bootstrapSession 可重入门控循环（设计口径）、
// 401 按方法安全性分治（设计口径）、归一化走单源规则表（设计口径）。

// TransportOpts：请求选项（body 为待 JSON 序列化的任意值）。
type TransportOpts struct {
	Body    any
	Headers map[string]string
}

// Transport 可注入传输：返回状态码与已解析 JSON。测试注入脚本化假传输，无活实例。
type Transport func(method, path string, opts TransportOpts) (int, any, error)

// AdapterError：通用失败（含 kind 与可选 status）。
type AdapterError struct {
	Msg    string
	Kind   string
	Status int
}

func (e *AdapterError) Error() string { return e.Msg }

// LoginError：登录失败分类（401 rejected / 429 locked / 500 failed）。
type LoginError struct {
	AdapterError
}

// TotpRequiredError：needsTotp 分支且未提供 totp。
type TotpRequiredError struct{}

func (TotpRequiredError) Error() string { return "需要第二因子（TOTP）：带 totp 重调 BootstrapSession" }

// ConsentRequiredError：consent 闸且未显式 accept（设计口径：默认不代操作者做法律行为）。
type ConsentRequiredError struct {
	Documents []any
	Version   string
}

func (e *ConsentRequiredError) Error() string {
	return fmt.Sprintf("需要同意用户协议（version=%s）——显式传 acceptAgreements: true 解锁", e.Version)
}

// PasswordWeakError：改密 400 且带 rules（PasswordTooWeak）。
type PasswordWeakError struct {
	Rules []any
}

func (e *PasswordWeakError) Error() string { return "新密码未通过强度要求" }

// PasswordChangeRequiredError：命中改密闸但未提供 newPassword。
type PasswordChangeRequiredError struct{}

func (PasswordChangeRequiredError) Error() string { return "服务端要求改密但未提供 newPassword" }

// SessionExpiredError：401 且按设计口径不自动恢复。
type SessionExpiredError struct {
	Method, Path, Reason string
}

func (e *SessionExpiredError) Error() string {
	return fmt.Sprintf("会话失效且不自动恢复（%s %s）：%s", e.Method, e.Path, e.Reason)
}

// BootstrapOptions：设计口径的入参。AcceptAgreements 默认 false。
type BootstrapOptions struct {
	Password         string
	NewPassword      string
	NewPasswordSet   bool
	AcceptAgreements bool
	Totp             string
	TotpSet          bool
}

// SessionState：引导完成后的归一化会话状态。
type SessionState struct {
	Token              string
	ConsentRequired    bool
	MustChangePassword bool
}

// SnowlumaClient：三块价值（归一化/门控引导/生命周期）之上的一语言实现。
type SnowlumaClient struct {
	transport Transport
	rules     RulesTable
	baseURL   string
	token     *string
	password  *string
	totp      *string
}

// NewSnowlumaClient：transport 必须注入（与 Python 版同决策：传输策略是部署决策，
// 库内不内置 socket；Go 侧生产可用 http.Transport 包装，见 plan6 文档 §传输接线）。
func NewSnowlumaClient(transport Transport, rules RulesTable, baseURL string) (*SnowlumaClient, error) {
	if transport == nil {
		return nil, &AdapterError{Msg: "transport 必须注入", Kind: "protocol"}
	}
	// 注入的规则表与从磁盘读到的一样过结构校验（与 TS/Python 同裁定）：
	// 非法表静默失效等于把 fail-closed 洗成 fail-open。
	if err := rules.Validate(); err != nil {
		return nil, err
	}
	base := strings.TrimRight(baseURL, "/")
	if base == "" {
		base = "http://127.0.0.1:5099"
	}
	return &SnowlumaClient{transport: transport, rules: rules, baseURL: base}, nil
}

// Token：bootstrap 之后有效。
func (c *SnowlumaClient) Token() *string { return c.token }

func (c *SnowlumaClient) call(method, path string, body any, auth string) (int, any, error) {
	opts := TransportOpts{}
	if body != nil {
		opts.Body = body
	}
	if auth != "" {
		opts.Headers = map[string]string{"authorization": auth}
	}
	return c.transport(method, path, opts)
}

func (c *SnowlumaClient) loginOnce() (int, any, error) {
	body := map[string]any{"password": *c.password}
	if c.totp != nil {
		body["totp"] = *c.totp
	}
	return c.call("POST", "/api/login", body, "")
}

func errMessage(body any) string {
	if m, ok := body.(map[string]any); ok {
		if s, ok := m["message"].(string); ok {
			return s
		}
	}
	raw, _ := json.Marshal(body)
	return string(raw)
}

func (c *SnowlumaClient) requestInternal(method, path string, body any, allowRelogin bool) (any, error) {
	if c.token == nil {
		return nil, &AdapterError{Msg: "未建立会话：先 BootstrapSession", Kind: "no-session"}
	}
	status, data, err := c.call(method, path, body, "Bearer "+*c.token)
	if err != nil {
		return nil, err
	}
	if status == 401 {
		safe := method == "GET" || method == "HEAD"
		externalFetch := path == "/api/update/check"
		if safe && !externalFetch && allowRelogin && c.password != nil {
			// 设计口径：安全方法 401 → 重登一次 → 重放原请求 → 仍失败抛错。
			st, loginBody, err := c.loginOnce()
			if err == nil && st == 200 {
				if m, ok := loginBody.(map[string]any); ok {
					if tok, ok := m["token"].(string); ok {
						c.token = &tok
						return c.requestInternal(method, path, body, false)
					}
				}
			}
			return nil, &SessionExpiredError{Method: method, Path: path, Reason: "重登失败（密码可能已变更或账号被限速）"}
		}
		reason := "非幂等写方法不自动重放（重复执行有实际后果）"
		if safe {
			reason = "该 GET 带 external-fetch 副作用标记，自动重放会打外部版本源"
		}
		return nil, &SessionExpiredError{Method: method, Path: path, Reason: reason}
	}
	if status >= 400 {
		return nil, &AdapterError{
			Msg:    fmt.Sprintf("%s %s 失败（%d）：%s", method, path, status, errMessage(data)),
			Kind:   "request-failed",
			Status: status,
		}
	}
	return ApplyRules(c.rules, method, path, data), nil
}

// Request：归一化请求（2xx 返回按规则表变换后的 JSON 体；401 按设计口径分治）。
func (c *SnowlumaClient) Request(method, path string, body any) (any, error) {
	return c.requestInternal(strings.ToUpper(method), path, body, true)
}

// BootstrapSession：设计口径门控引导。可重入：改密成功（requireRelogin）后自动用新密码回到 login。
func (c *SnowlumaClient) BootstrapSession(opts BootstrapOptions) (SessionState, error) {
	password := opts.Password
	if opts.TotpSet {
		c.totp = &opts.Totp
	}
	for pass := 0; pass < 4; pass++ {
		// ── 步骤 1：login ──
		c.password = &password
		status, body, err := c.loginOnce()
		if err != nil {
			return SessionState{}, err
		}
		if status != 200 {
			kind := "failed"
			if status == 401 {
				kind = "rejected"
			} else if status == 429 {
				kind = "locked"
			}
			return SessionState{}, &LoginError{AdapterError{
				Msg: fmt.Sprintf("登录失败（%s）：%s", kind, errMessage(body)), Kind: kind, Status: status,
			}}
		}
		m, _ := body.(map[string]any)
		if v, ok := m["needsTotp"].(bool); ok && v {
			return SessionState{}, TotpRequiredError{}
		}
		tok, ok := m["token"].(string)
		if !ok {
			return SessionState{}, &AdapterError{Msg: "login 200 缺 token（形状与 spec LoginSuccess 不符）", Kind: "protocol"}
		}
		c.token = &tok
		mustChange, _ := m["mustChangePassword"].(bool)

		// ── 步骤 2：consent 闸 ──
		st, payload, err := c.call("GET", "/api/agreements", nil, "Bearer "+tok)
		if err != nil {
			return SessionState{}, err
		}
		if st == 200 {
			// 200 的体必须是对象：非对象体按可选键读会静默跳过同意闸（fail-open），
			// 与 TS/Python 的 protocol 错分叉。
			pm, ok := payload.(map[string]any)
			if !ok {
				return SessionState{}, &AdapterError{Msg: "agreements 200 响应体不是 JSON 对象（形状与 spec AgreementsPayload 不符）", Kind: "protocol"}
			}
			if required, ok := pm["consentRequired"].(bool); ok && required {
				version, ok := pm["version"].(string)
				if !ok {
					return SessionState{}, &AdapterError{Msg: "同意闸 200 缺 version（record-consent 的必填体无从取得）", Kind: "protocol"}
				}
				if !opts.AcceptAgreements {
					docs, _ := pm["documents"].([]any)
					return SessionState{}, &ConsentRequiredError{Documents: docs, Version: version}
				}
				st2, rec, err := c.call("POST", "/api/agreements/record-consent", map[string]any{"version": version}, "Bearer "+tok)
				if err != nil {
					return SessionState{}, err
				}
				if st2 == 409 {
					// 设计口径：409 {currentVersion} → 用返回版本重试，仅一次。
					rm, _ := rec.(map[string]any)
					current, ok := rm["currentVersion"].(string)
					if !ok {
						return SessionState{}, &AdapterError{Msg: "record-consent 409 缺 currentVersion", Kind: "protocol", Status: 409}
					}
					st2, rec, err = c.call("POST", "/api/agreements/record-consent", map[string]any{"version": current}, "Bearer "+tok)
					if err != nil {
						return SessionState{}, err
					}
				}
				if st2 != 200 {
					return SessionState{}, &AdapterError{
						Msg: fmt.Sprintf("record-consent 失败（%d）：%s", st2, errMessage(rec)), Kind: "request-failed", Status: st2,
					}
				}
			}
		}

		// ── 步骤 3：改密闸 ──
		if !mustChange {
			// ── 步骤 4：返回归一化会话状态 ──
			return SessionState{Token: tok, ConsentRequired: false, MustChangePassword: false}, nil
		}
		if !opts.NewPasswordSet {
			return SessionState{}, PasswordChangeRequiredError{}
		}
		st3, changed, err := c.call("POST", "/api/auth/change-password", map[string]any{
			"oldPassword": password, "newPassword": opts.NewPassword,
		}, "Bearer "+tok)
		if err != nil {
			return SessionState{}, err
		}
		if st3 == 400 {
			cm, _ := changed.(map[string]any)
			if rules, ok := cm["rules"].([]any); ok {
				return SessionState{}, &PasswordWeakError{Rules: rules}
			}
			return SessionState{}, &AdapterError{
				Msg: fmt.Sprintf("改密失败（400）：%s", errMessage(changed)), Kind: "password-failed", Status: 400,
			}
		}
		if st3 != 200 {
			return SessionState{}, &AdapterError{
				Msg: fmt.Sprintf("改密失败（%d）：%s", st3, errMessage(changed)), Kind: "password-failed", Status: st3,
			}
		}
		cm, ok := changed.(map[string]any)
		if !ok {
			return SessionState{}, &AdapterError{Msg: "change-password 200 响应体不是 JSON 对象（形状与 spec PasswordChanged 不符）", Kind: "protocol"}
		}
		if v, _ := cm["success"].(bool); !v {
			return SessionState{}, &AdapterError{Msg: "change-password 200 形状与 spec PasswordChanged 不符", Kind: "protocol"}
		}
		if v, _ := cm["requireRelogin"].(bool); !v {
			return SessionState{}, &AdapterError{Msg: "change-password 200 形状与 spec PasswordChanged 不符", Kind: "protocol"}
		}
		// ★ 服务端已 sessionTokens.clear()，当前 token 当场作废 → 用新密码回步骤 1。
		password = opts.NewPassword
		c.token = nil
	}
	return SessionState{}, &AdapterError{Msg: "bootstrap 循环超过 4 轮仍未收敛", Kind: "protocol"}
}
