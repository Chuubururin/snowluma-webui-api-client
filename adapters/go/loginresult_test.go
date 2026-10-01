// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
package adapters

import "testing"

func TestParseLoginResult(t *testing.T) {
	ok, err := ParseLoginResult([]byte(`{"success":true,"token":"abc","mustChangePassword":false}`))
	if err != nil || ok.Success == nil || ok.Success.Token != "abc" {
		t.Fatalf("success 分支未正确解析: %+v err=%v", ok, err)
	}
	totp, err := ParseLoginResult([]byte(`{"success":false,"needsTotp":true}`))
	if err != nil || totp.NeedsTotp == nil || totp.Success != nil {
		t.Fatalf("needsTotp 分支未正确解析: %+v err=%v", totp, err)
	}
	if _, err := ParseLoginResult([]byte(`{"message":"没有标签"}`)); err == nil {
		t.Fatal("缺 success 字段时必须报错，不能默认挑一个分支")
	}
}
