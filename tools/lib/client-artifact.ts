// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 出口工件的名字常量单源。
 *
 * 为什么单独一个文件：这些名字同时被三处消费 —— 打包器的目录布局、README 的 import 句、
 * 示例代码的 specifier。任何一处另写一遍字面量，就有了"文档承诺的入口与工件里的入口
 * 是两个东西"的失效面，而它在源码树的所有门禁里都看不见（门禁都从仓内路径走）。
 */

/** 许可口径行；有注释位的产物文件首行必须带它（JSON 类由 NOTICE.md 覆盖，同 spec/NOTICE.md 的既有豁免）。 */
export const BANNER = '派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器';

/** TypeScript 工件的包名（`import … from '<这里>'` 的唯一出处）。不发布到 npm，只服务本地安装。 */
export const TS_PACKAGE_NAME = 'snowluma-webui-clients';

/** Python 装包后的可导入名（目录名 == import 名，不设 src/ 布局，免得两处不同名）。 */
export const PY_PACKAGE = 'snowluma_client';

/** Python 发行名（`pip` / `importlib.metadata.version()` 用它，与 PY_PACKAGE 是两件事，故分开命名）。 */
export const PY_DIST_NAME = 'snowluma-client';

/**
 * Go module id：沿用生成物既有的 id（由 `go mod init` 落），于是手写适配器的 import
 * 零改写，且合并成单 module 后 `replace` 就地消失。
 * 刻意留在 RFC 2606 保留域内：它永不可被 `go get` 拉取 —— 这正是"不发 Go module"的写法。
 */
export const GO_MODULE_ID = 'example.com/sl/generated';

/** 生成码在 Go 工件里的子包（import 前缀 = `${GO_MODULE_ID}/${GO_PACKAGE_DIR}`）。 */
export const GO_PACKAGE_DIR = 'snowluma';

/** 行为适配层在 Go 工件里的子包（`package adapters`，与仓内一致，零改写）。 */
export const GO_ADAPTER_DIR = 'adapters';

/** 三语工件目录名（tarball 与本地 staging 同名，避免"CI 里那套名字"分叉）。 */
export const ARTIFACT_DIRS = {
  typescript: 'typescript',
  python: 'python',
  go: 'go',
} as const;

export type ArtifactLang = keyof typeof ARTIFACT_DIRS;

export const ARTIFACT_LANGS: readonly ArtifactLang[] = ['typescript', 'python', 'go'];
