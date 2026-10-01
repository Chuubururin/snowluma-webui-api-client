// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
package adapters

import (
	"encoding/json"
	"fmt"

	"example.com/sl/generated/snowluma"
)

// LoginResult 是 snowluma.LoginResult 的**可判别**包装。
//
// 为什么需要它：R22 让本项目不写 discriminator，而 oapi-codegen v2.8.0 对
// `oneOf` + 布尔 `enum:[单值]` 塌成 struct{union json.RawMessage}（findings Q5），
// 调用方拿不到"到底哪个分支"。判别信息其实**在字节里**（success 字段），
// 所以不需要回头写 discriminator，只需要一次读取。
//
// 为什么不能在 snowluma 包里补方法：生成类型自带 UnmarshalJSON，重复声明编译不过。
// 因此适配层**新增类型**是唯一不与重新生成冲突的形状（设计口径、findings Q5）。
//
// 实际生成名（见 generated/go/snowluma/types.gen.go，与 findings Q5 一致）：
//   - snowluma.LoginResult    = struct{ union json.RawMessage }（:899）
//   - snowluma.LoginSuccess   { MustChangePassword bool; Success LoginSuccessSuccess; Token string }（:906）
//   - snowluma.LoginNeedsTotp { NeedsTotp LoginNeedsTotpNeedsTotp; Success LoginNeedsTotpSuccess }（:887）
type LoginResult struct {
	Success   *snowluma.LoginSuccess
	NeedsTotp *snowluma.LoginNeedsTotp
}

// ParseLoginResult 按布尔 tag `success` 选支。
//
// 判别 ≠ 校验：本函数只回答"tag 指向哪一支"，不保证那一支的字段真的在。
// `{success:true}` 会正常进 Success 支、Token 是零值空串 —— 分支内必填字段
// （token/mustChangePassword 的 required 断言）的执法点是 spec + 真机 schema diff
// （设计口径），不是这里；调用方若要把零值当错误，得自己检。
func ParseLoginResult(body []byte) (LoginResult, error) {
	var tag struct {
		Success *bool `json:"success"`
	}
	if err := json.Unmarshal(body, &tag); err != nil {
		return LoginResult{}, fmt.Errorf("读取 success 标签失败: %w", err)
	}
	if tag.Success == nil {
		return LoginResult{}, fmt.Errorf("响应缺少布尔字段 success，无法判别分支")
	}
	var out LoginResult
	if *tag.Success {
		var s snowluma.LoginSuccess
		if err := json.Unmarshal(body, &s); err != nil {
			return LoginResult{}, fmt.Errorf("按 LoginSuccess 解析失败: %w", err)
		}
		out.Success = &s
		return out, nil
	}
	var n snowluma.LoginNeedsTotp
	if err := json.Unmarshal(body, &n); err != nil {
		return LoginResult{}, fmt.Errorf("按 LoginNeedsTotp 解析失败: %w", err)
	}
	out.NeedsTotp = &n
	return out, nil
}
