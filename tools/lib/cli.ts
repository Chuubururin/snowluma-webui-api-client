// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { pathToFileURL } from 'node:url';

/**
 * 「我是不是被当作脚本直接运行的？」——tools/ 下四个带 CLI 分支的模块共用这一条判定。
 *
 * 为什么不各写 `import.meta.url === pathToFileURL(process.argv[1]).href`：
 * `process.argv[1]` 的类型是 `string | undefined`——在 `tsx -e` / REPL / 被别的模块 import 时
 * 它就是 undefined，而 `pathToFileURL(undefined)` **直接抛** ERR_INVALID_ARG_TYPE。
 * 后果不是"CLI 分支没跑"，而是**整个模块连 import 都进不去**：客户端批次最常见的探针写法
 * `node_modules/.bin/tsx -e "import('./tools/build-anchor.ts')"` 当场崩成看起来像模块自身的错
 * （终审 M4 实测：build-anchor / validate-spec / check-drift / side-effects-scan 四个全崩）。
 * `tools.lock.json` 的 fetchCommand 之所以躲过，纯粹因为 lib/upstream.ts 没有 CLI 守卫。
 *
 * 仍走 pathToFileURL 做规范化——Windows 下把路径与 import.meta.url 做字符串拼接比较不可靠
 * （全局约束 R3 的教训），这里只是先判空、不改变比较方式。
 */
export function isCliEntry(moduleUrl: string, argv1: string | undefined): boolean {
  return argv1 !== undefined && moduleUrl === pathToFileURL(argv1).href;
}
