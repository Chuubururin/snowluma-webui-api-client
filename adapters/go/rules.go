// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
package adapters

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// RulesTable / Rule：adapters/rules.json 的结构化形状（设计口径规则单源）。
// 与 rules.schema.json 的契约一致；ValidateRules 手写结构校验（仓库不加 ajv 等依赖），不符即错。

type RuleMatch struct {
	Path   string
	Method string
}

type Rule struct {
	ID        string
	Match     RuleMatch
	Op        string // "unwrap" | "rename"
	When      map[string]any
	UnwrapKey string
	Rename    map[string]string
}

type RulesTable struct {
	SchemaVersion string
	Rules         []Rule
}

// RulesError：规则表结构/内容不合法。
type RulesError struct{ Msg string }

func (e *RulesError) Error() string { return e.Msg }

// LoadRules 读规则表；默认路径相对本文件解析（与 TS 的 import.meta.url / Python 的
// __file__ 同策略）——CWD 相对会在任何非包目录的消费方（真实二进制、仓库根）下读不到。
func LoadRules(path string) (RulesTable, error) {
	if path == "" {
		_, thisFile, _, ok := runtime.Caller(0)
		if !ok {
			return RulesTable{}, &RulesError{Msg: "LoadRules: 无法定位 rules.go（runtime.Caller 失败）"}
		}
		path = filepath.Join(filepath.Dir(thisFile), "..", "rules.json")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return RulesTable{}, err
	}
	return ValidateRulesJSON(raw)
}

// ValidateRulesJSON 解析并校验规则表字节。
func ValidateRulesJSON(raw []byte) (RulesTable, error) {
	var doc struct {
		SchemaVersion string           `json:"schemaVersion"`
		Rules         []map[string]any `json:"rules"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return RulesTable{}, &RulesError{Msg: "规则表不是合法 JSON：" + err.Error()}
	}
	// "rules": null 会 unmarshal 成 nil slice 且无错——静默变成永不命中的空表（fail-open），
	// 与 TS/Python 的"必须是数组"分叉。空数组 [] 合法，null 不合法。
	if doc.Rules == nil {
		return RulesTable{}, &RulesError{Msg: "rules 必须是数组（null 不合法）"}
	}
	table := RulesTable{SchemaVersion: doc.SchemaVersion}
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(doc.SchemaVersion) {
		return RulesTable{}, &RulesError{Msg: fmt.Sprintf("schemaVersion 必须是 x.y.z：%q", doc.SchemaVersion)}
	}
	seen := map[string]bool{}
	allowed := map[string]bool{"id": true, "match": true, "op": true, "when": true, "unwrapKey": true, "rename": true}
	idRe := regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	for _, r := range doc.Rules {
		id, _ := r["id"].(string)
		if !idRe.MatchString(id) {
			return RulesTable{}, &RulesError{Msg: fmt.Sprintf("规则 id 非法：%q", id)}
		}
		if seen[id] {
			return RulesTable{}, &RulesError{Msg: "规则 id 重复：" + id}
		}
		seen[id] = true
		for k := range r {
			if !allowed[k] {
				return RulesTable{}, &RulesError{Msg: fmt.Sprintf("%s: 未知键 %s", id, k)}
			}
		}
		match, _ := r["match"].(map[string]any)
		path, _ := match["path"].(string)
		method, _ := match["method"].(string)
		if !strings.HasPrefix(path, "/") {
			return RulesTable{}, &RulesError{Msg: fmt.Sprintf("%s: match.path 必须以 / 开头", id)}
		}
		if !regexp.MustCompile(`^[A-Z]+$`).MatchString(method) {
			return RulesTable{}, &RulesError{Msg: fmt.Sprintf("%s: match.method 必须大写", id)}
		}
		op, _ := r["op"].(string)
		rule := Rule{ID: id, Match: RuleMatch{Path: path, Method: method}, Op: op}
		switch op {
		case "unwrap":
			key, _ := r["unwrapKey"].(string)
			if key == "" {
				return RulesTable{}, &RulesError{Msg: fmt.Sprintf("%s: unwrap 需要非空 unwrapKey", id)}
			}
			rule.UnwrapKey = key
			// when:null 与缺省同义（无条件解包）；when 显式出现且非 null 时必须带字符串 hasKey，
			// 空对象 {} 也非法——TS/Python 侧同一裁定。
			if w, present := r["when"]; present && w != nil {
				wm, ok := w.(map[string]any)
				if !ok {
					return RulesTable{}, &RulesError{Msg: fmt.Sprintf("%s: when 必须是对象或 null", id)}
				}
				hk, ok := wm["hasKey"].(string)
				if !ok || hk == "" {
					return RulesTable{}, &RulesError{Msg: fmt.Sprintf("%s: when.hasKey 必须是非空字符串", id)}
				}
				rule.When = map[string]any{"hasKey": hk}
			}
		case "rename":
			rename, _ := r["rename"].(map[string]any)
			from, _ := rename["from"].(string)
			to, _ := rename["to"].(string)
			if from == "" || to == "" {
				return RulesTable{}, &RulesError{Msg: fmt.Sprintf("%s: rename 需要非空 {from,to}", id)}
			}
			rule.Rename = map[string]string{"from": from, "to": to}
		default:
			return RulesTable{}, &RulesError{Msg: fmt.Sprintf("%s: op 只能是 unwrap|rename：%q", id, op)}
		}
		table.Rules = append(table.Rules, rule)
	}
	return table, nil
}

// templateToRegex：`{x}` 匹配单个非 / 段，其余字符按字面转义。
func templateToRegex(template string) *regexp.Regexp {
	parts := strings.Split(template, "/")
	for i, seg := range parts {
		if strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "}") {
			// 段里不含换行：[^/] 会把尾换行吞进段内，"path\n" 就误命中了（TS/Python 同改，三语同形）。
			parts[i] = "[^/\\n]+"
		} else {
			parts[i] = regexp.QuoteMeta(seg)
		}
	}
	return regexp.MustCompile("^" + strings.Join(parts, "/") + "$")
}

// ApplyRules 对成功响应体应用全部匹配规则（错误信封不归一化，走异常路径）。
func ApplyRules(rules RulesTable, method, path string, body any) any {
	out := body
	for _, rule := range rules.Rules {
		if rule.Match.Method != strings.ToUpper(method) {
			continue
		}
		if !templateToRegex(rule.Match.Path).MatchString(path) {
			continue
		}
		obj, ok := out.(map[string]any)
		if !ok {
			continue
		}
		switch rule.Op {
		case "unwrap":
			if rule.When != nil {
				if hk, ok := rule.When["hasKey"].(string); ok {
					if _, present := obj[hk]; !present {
						continue
					}
				}
			}
			inner, ok := obj[rule.UnwrapKey].(map[string]any)
			if !ok {
				continue
			}
			out = cloneMap(inner)
		case "rename":
			rename := rule.Rename
			v, present := obj[rename["from"]]
			if !present {
				continue
			}
			if rename["from"] == rename["to"] {
				continue // 改名到自己 = no-op，三语同形
			}
			next := cloneMap(obj)
			next[rename["to"]] = v
			delete(next, rename["from"])
			out = next
		}
	}
	return out
}

func cloneMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// Validate：对已解析的结构化表做与 ValidateRulesJSON 同源的检查（构造函数注入的表
// 和从磁盘读到的一样过校验——非法表静默失效等于把 fail-closed 洗成 fail-open）。
// nil Rules 视为空表；JSON 侧的 "rules":null 拒绝发生在 ValidateRulesJSON。
func (t RulesTable) Validate() error {
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(t.SchemaVersion) {
		return &RulesError{Msg: fmt.Sprintf("schemaVersion 必须是 x.y.z：%q", t.SchemaVersion)}
	}
	idRe := regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	seen := map[string]bool{}
	for _, r := range t.Rules {
		if !idRe.MatchString(r.ID) {
			return &RulesError{Msg: fmt.Sprintf("规则 id 非法：%q", r.ID)}
		}
		if seen[r.ID] {
			return &RulesError{Msg: "规则 id 重复：" + r.ID}
		}
		seen[r.ID] = true
		if !strings.HasPrefix(r.Match.Path, "/") {
			return &RulesError{Msg: fmt.Sprintf("%s: match.path 必须以 / 开头", r.ID)}
		}
		if !regexp.MustCompile(`^[A-Z]+$`).MatchString(r.Match.Method) {
			return &RulesError{Msg: fmt.Sprintf("%s: match.method 必须大写", r.ID)}
		}
		switch r.Op {
		case "unwrap":
			if r.UnwrapKey == "" {
				return &RulesError{Msg: fmt.Sprintf("%s: unwrap 需要非空 unwrapKey", r.ID)}
			}
			// When 的形状与 ValidateRulesJSON 同裁定：非 nil 就必须带非空字符串 hasKey，
			// 否则 apply 时静默降级成无条件解包（fail-open）。
			if r.When != nil {
				if hk, ok := r.When["hasKey"].(string); !ok || hk == "" {
					return &RulesError{Msg: fmt.Sprintf("%s: when.hasKey 必须是非空字符串", r.ID)}
				}
			}
		case "rename":
			if r.Rename == nil || r.Rename["from"] == "" || r.Rename["to"] == "" {
				return &RulesError{Msg: fmt.Sprintf("%s: rename 需要非空 {from,to}", r.ID)}
			}
		default:
			return &RulesError{Msg: fmt.Sprintf("%s: op 只能是 unwrap|rename：%q", r.ID, r.Op)}
		}
	}
	return nil
}
