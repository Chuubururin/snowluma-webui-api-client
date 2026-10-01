// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
package adapters

import (
	"strings"
	"testing"
)

func TestParseStateStreamFrameEachBranch(t *testing.T) {
	cases := []struct {
		name  string
		body  string
		check func(StateStreamFrame) bool
	}{
		{"ready", `{"kind":"ready"}`,
			func(f StateStreamFrame) bool { return f.Ready != nil && f.Dropped == nil && f.Processes == nil }},
		{"dropped", `{"kind":"dropped","count":3}`,
			func(f StateStreamFrame) bool { return f.Dropped != nil && f.Dropped.Count == 3 }},
		{"processes", `{"resource":"processes","data":[]}`,
			func(f StateStreamFrame) bool { return f.Processes != nil && len(f.Processes.Data) == 0 }},
		{"qq-list", `{"resource":"qq-list","data":[{"uin":"12345","nickname":"n"}]}`,
			func(f StateStreamFrame) bool {
				return f.QqList != nil && len(f.QqList.Data) == 1 && f.QqList.Data[0].Uin == "12345"
			}},
		{"connections", `{"resource":"connections","data":[]}`,
			func(f StateStreamFrame) bool { return f.Connections != nil && f.Processes == nil }},
	}
	for _, tc := range cases {
		f, err := ParseStateStreamFrame([]byte(tc.body))
		if err != nil {
			t.Fatalf("%s: 合法帧被拒收: %v", tc.name, err)
		}
		if !tc.check(f) {
			t.Errorf("%s: 分支落位不对: %+v", tc.name, f)
		}
	}
}

// 这一组是本步骤真正要证明的东西：**双标签**下的"恰好一支"。
// 少了它们，上面那张表只能证明"我能解析"，不能证明"我不会误判"。
func TestParseStateStreamFrameRejectsAmbiguousAndUnknown(t *testing.T) {
	bad := []struct {
		why, body string
		// wantMsg 非空时错误文案必须含它 —— 终审 A5①：`{}` 就算被 default 分支的
		// "resource 不是字符串"顺路拒掉，那也只是文案变差；不钉消息，删掉
		// `case !hasKind && !hasResource` 这条显式守卫不会有任何测试变红。
		wantMsg string
	}{
		{"两个标签键都不在场", `{}`, "既无 kind 也无 resource"},
		{"两个标签键同时在场（oneOf 要求恰好一支）", `{"kind":"ready","resource":"processes","data":[]}`, ""},
		{"未知 kind：不得退化成 ready", `{"kind":"disconnected"}`, ""},
		{"未知 resource：不得退化成 connections", `{"resource":"disk"}`, ""},
		{"不是对象", `[{"kind":"ready"}]`, ""},
		{"kind 不是字符串", `{"kind":true}`, ""},
		{"resource 不是字符串（A5：kind 那行的镜像，此前缺）", `{"resource":5}`, "resource 不是字符串"},
		{"根本不是 JSON（缺右花括号的截断帧）", `{"kind":"ready"`, ""},
	}
	for _, b := range bad {
		_, err := ParseStateStreamFrame([]byte(b.body))
		if err == nil {
			t.Errorf("%s —— 这一帧必须被拒收，但它被接受了：%s", b.why, b.body)
			continue
		}
		if b.wantMsg != "" && !strings.Contains(err.Error(), b.wantMsg) {
			t.Errorf("%s —— 拒收理由不对：期望错误含 %q，实际 %q", b.why, b.wantMsg, err.Error())
		}
	}
}
