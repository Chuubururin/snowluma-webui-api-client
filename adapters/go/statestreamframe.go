// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
package adapters

import (
	"encoding/json"
	"fmt"

	"example.com/sl/generated/snowluma"
)

// StateStreamFrame 是 snowluma.StateStreamFrame 的可判别包装（裁定 R28）。
//
// 与 LoginResult 的判别包装的差别就是本任务存在的理由：这里有两个标签键，
// 且生成物不暴露任何一个（struct{union json.RawMessage}，types.gen.go:1058-1060），
// 所以"哪一支"这件事只存在于原始字节里 —— 判别逻辑必须住在适配层，不在生成器。
//
// 判别规则与 spec 的 oneOf 语义逐条对齐，一条都不放宽：
//   - 恰好一个标签键在场。两个都在场 ⇒ 非法（oneOf 要的是恰好一支，
//     立的那道关 ONEOF_BRANCH_OVERLAP 说的是同一件事）；两个都不在 ⇒ 非法。
//   - 标签值不认识 ⇒ 报错，**不退化成"最接近的一个分支"**。
//     上游加一种 kind 时适配层必须在这里炸，而不是静默把它当 ready。
//
// 实际生成名（见 generated/go/snowluma/types.gen.go，逐一核对无误）：
//   - snowluma.StateStreamFrame   = struct{ union json.RawMessage }（:1058）
//   - snowluma.StateFrameReady    { Kind StateFrameReadyKind }（:1042）
//   - snowluma.StateFrameDropped  { Count int; Kind StateFrameDroppedKind }（:1006）
//   - snowluma.StateFrameProcesses   { Data []HookProcessInfo; Resource ...; AdditionalProperties ... }（:1017）
//   - snowluma.StateFrameQqList   { Data []QQInfo; Resource ...; AdditionalProperties ... }（:1030）
//     —— 类型名是单 Q 的 `QqList`，但元素类型是双 Q 的 `QQInfo`；QQInfo{Nickname,Uin string}（:983）
//   - snowluma.StateFrameConnections { Data []AccountConnections; Resource ...; AdditionalProperties ... }（:992）
type StateStreamFrame struct {
	Ready       *snowluma.StateFrameReady
	Dropped     *snowluma.StateFrameDropped
	Processes   *snowluma.StateFrameProcesses
	QqList      *snowluma.StateFrameQqList
	Connections *snowluma.StateFrameConnections
}

// ParseStateStreamFrame 解析 SSE 流里**一帧**的 JSON（`data: ` 前缀由调用方剥掉，
// 注释行 `: heartbeat` 由调用方跳过 —— 见 `sse-response.ts:56` 与 `:62`）。
// 它刻意不认识传输本身：Go 生成物的流消费是坏的（实测
// `ParseStreamStateResponse` 走 io.ReadAll 后 Close），
// "逐行取 JSON 再交给这里"是适配层的职责，"这一帧进哪个分支"是且仅是本函数的问题。
func ParseStateStreamFrame(body []byte) (StateStreamFrame, error) {
	// 探存在性用 map[string]json.RawMessage：判别只看键在不在，
	// 不预设值类型 —— 值类型留给各分支自己的 UnmarshalJSON 去管。
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(body, &probe); err != nil {
		return StateStreamFrame{}, fmt.Errorf("帧不是 JSON 对象: %w", err)
	}
	kindRaw, hasKind := probe["kind"]
	resourceRaw, hasResource := probe["resource"]
	switch {
	case hasKind && hasResource:
		return StateStreamFrame{}, fmt.Errorf("帧同时带 kind 与 resource 两个标签键，oneOf 要求恰好一支")
	case !hasKind && !hasResource:
		return StateStreamFrame{}, fmt.Errorf("帧既无 kind 也无 resource，无法判别分支")
	case hasKind:
		var kind string
		if err := json.Unmarshal(kindRaw, &kind); err != nil {
			return StateStreamFrame{}, fmt.Errorf("kind 不是字符串: %w", err)
		}
		var out StateStreamFrame // 终审 A5：原先这里的 raw 字段处处写、无人读，连同每次解析多一次 body 拷贝
		switch kind {
		case "ready":
			return into(&out, &out.Ready, body, "StateFrameReady")
		case "dropped":
			return into(&out, &out.Dropped, body, "StateFrameDropped")
		default:
			return StateStreamFrame{}, fmt.Errorf("未知 kind %q（缓存内只有 ready/dropped；上游新增须同步本适配层）", kind)
		}
	default:
		var resource string
		if err := json.Unmarshal(resourceRaw, &resource); err != nil {
			return StateStreamFrame{}, fmt.Errorf("resource 不是字符串: %w", err)
		}
		var out StateStreamFrame
		switch resource {
		case "processes":
			return into(&out, &out.Processes, body, "StateFrameProcesses")
		case "qq-list":
			return into(&out, &out.QqList, body, "StateFrameQqList")
		case "connections":
			return into(&out, &out.Connections, body, "StateFrameConnections")
		default:
			return StateStreamFrame{}, fmt.Errorf("未知 resource %q（缓存内只有 processes/qq-list/connections）", resource)
		}
	}
}

// into 把 body 解进 T 并把指针放进 dst。写成泛型是为了让五个分支共用同一条
// "解析失败就带类型名报错"的路径 —— 错误文案里的类型名是调试时唯一能认出哪一支坏了的东西。
func into[T any](out *StateStreamFrame, dst **T, body []byte, typeName string) (StateStreamFrame, error) {
	var v T
	if err := json.Unmarshal(body, &v); err != nil {
		return StateStreamFrame{}, fmt.Errorf("按 %s 解析失败: %w", typeName, err)
	}
	*dst = &v
	return *out, nil
}
