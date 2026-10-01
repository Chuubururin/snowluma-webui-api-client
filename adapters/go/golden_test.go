// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
// 三语 golden fixture（设计口径）Go 侧：读同一份 cases.json。
package adapters

import (
	"encoding/json"
	"os"
	"testing"
)

type goldenCase struct {
	Name     string          `json:"name"`
	Method   string          `json:"method"`
	Path     string          `json:"path"`
	Response any             `json:"response"`
	Expected any             `json:"expected"`
	Rules    json.RawMessage `json:"rules"`
}

func TestGoldenFixtures(t *testing.T) {
	raw, err := os.ReadFile("../golden/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []goldenCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	rules, err := LoadRules("../rules.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range doc.Cases {
		// 用例可带自有 rules 表（触达仓库表覆盖不到的 rename/链式/无条件分支），同一裁定过校验。
		table := rules
		if len(c.Rules) > 0 {
			table, err = ValidateRulesJSON([]byte(`{"schemaVersion":"1.0.0","rules":` + string(c.Rules) + `}`))
			if err != nil {
				t.Fatalf("case %s: %v", c.Name, err)
			}
		}
		out := ApplyRules(table, c.Method, c.Path, c.Response)
		if !reflectDeepEqual(out, c.Expected) {
			t.Errorf("case %s：规范化结果与 golden 不符\n got: %#v\nwant: %#v", c.Name, out, c.Expected)
		}
	}
}

// reflectDeepEqual：JSON 往返后的 any（map[string]any / []any / 数字）与 golden 解析值比较。
func reflectDeepEqual(a, b any) bool {
	ab, err1 := json.Marshal(a)
	bb, err2 := json.Marshal(b)
	if err1 != nil || err2 != nil {
		return false
	}
	var aa, ba any
	_ = json.Unmarshal(ab, &aa)
	_ = json.Unmarshal(bb, &ba)
	return jsonEqual(aa, ba)
}

func jsonEqual(a, b any) bool {
	switch av := a.(type) {
	case map[string]any:
		bm, ok := b.(map[string]any)
		if !ok || len(av) != len(bm) {
			return false
		}
		for k, v := range av {
			bv, ok := bm[k]
			if !ok || !jsonEqual(v, bv) {
				return false
			}
		}
		return true
	case []any:
		bl, ok := b.([]any)
		if !ok || len(av) != len(bl) {
			return false
		}
		for i := range av {
			if !jsonEqual(av[i], bl[i]) {
				return false
			}
		}
		return true
	default:
		return a == b
	}
}
