// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 证明 R22 的 oneOf + enum:[单值] 在 hey-api 产物里保留 TS 原生窄化（findings Q1 附带结论）。
 *
 * 路径是 `../../generated/...`：本文件住在 tools/gen/ 下，往上两级才是仓库根。
 * （初稿写的是 `../generated/...`，那会解析成 tools/generated/ —— 实测 TS2307。）
 *
 * 为什么取 `types.gen.ts` 而不是 `index.ts`：前者**零 import**（实测 `grep -n "^import"
 * generated/typescript/types.gen.ts` 无命中），后者会把 client/、core/、sdk.gen.ts 一起拉进
 * 类型检查 —— 那是"验一个联合类型有没有塌成判别联合"，不是"把 hey-api 的整个 client 运行时
 * 也验一遍"。收窄导入面买到的是**归因范围**：红点只会出现在 types.gen.ts 与它引用的符号里。
 * 它**不**等于"红了只可能是判别联合的事"（终审 B1）—— types.gen.ts 是 995 行的 `.ts` 而非
 * `.d.ts`，`skipLibCheck` 对它不起作用，其中任何一处类型错都会把本探针染红。整份产物的
 * 编译覆盖归 `tsconfig.gen-ts.json`（`npm run probe` 的第二条 tsc），不在这里。
 *
 * 本文件被 tsconfig.json 的 exclude 挡在全仓 `tsc --noEmit` 之外（裁定 N29：`generated/` 是
 * git-ignored 构建产物，探针若进主 include，"仓库能不能类型检查"就取决于"这台机器跑过
 * `npm run generate` 没有"）。它由 `tsconfig.probe.json` 单独检查，见 package.json 的 probe 脚本。
 */
import type { LoginResult } from '../../generated/typescript/types.gen.js';

export function tokenIfLoggedIn(r: LoginResult): string | null {
  // 只有 hey-api 真把两分支塌成判别联合时，`=== true` 才窄化出带 token 的那一支。
  if (r.success === true) return r.token;
  return null;
}

declare const sample: LoginResult;
// 反向证据：未窄化就取 token **必须**编译不过。
//  · union 保住了 → 这行报 TS2339，@ts-expect-error 被消费，tsc 绿；
//  · hey-api 把它展平成单对象 → 这行不报错，于是 TS 反过来报 **TS2578 未使用的抑制指令**，tsc 红。
// 两个方向都拦得住 —— 那正是探针该有的性质：R22 的"TS 仍保留判别能力"一旦不成立，这里立刻变红。
// @ts-expect-error 联合类型不共享 token 属性
export const unNarrowed: unknown = sample.token;
