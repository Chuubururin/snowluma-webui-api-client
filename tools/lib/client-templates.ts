// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 三语工件的 README 与示例内容。
 *
 * 两条设计约束：
 *  ① README 里承诺的 import / 安装命令，必须与 examples/* 里的写法**出自同一处常量**——
 *     否则文档与工件分叉时，消费者照文档 import 会拿到 undefined，而这类失效在源码树的
 *     任何门禁里都看不见（门禁都从仓内相对路径走）。
 *  ② 每个示例埋一个 OK 标记（OK_TOKEN），由 tools/smoke-clients.ts 断言。示例不被执行
 *     的文档就是新的漂移源，所以标记既是文档内容也是出口闸的判据。
 */
import {
  ARTIFACT_DIRS,
  BANNER,
  GO_ADAPTER_DIR,
  GO_MODULE_ID,
  GO_PACKAGE_DIR,
  PY_DIST_NAME,
  PY_PACKAGE,
  TS_PACKAGE_NAME,
  type ArtifactLang,
} from './client-artifact.js';

export interface ReadmeCtx {
  version: string;
  anchor: string;
}

/** 示例成功执行后打印的标记 —— 本页与 smoke-clients.ts 之间的契约。 */
export const OK_TOKEN: Record<ArtifactLang, string> = {
  typescript: 'LOGIN_OK',
  python: 'PY_ADAPTER_OK',
  go: 'GO_BUILD_OK',
};

export function requiredReadmeSections(): string[] {
  return ['这是什么', '怎么装', '最小调用示例', '版本与出处'];
}

/** 出处段三语共用：版本只说契约版本，锚点只给 SHA 短前缀，其余交给 provenance 文件。 */
function provenance(ctx: ReadmeCtx): string {
  return `## 版本与出处

- **契约版本**：\`${ctx.version}\`（真源是 \`spec/openapi.yaml\` 的 \`info.version\`；它描述契约，不描述上游实现）
- **上游锚点**：\`${ctx.anchor.slice(0, 7)}\`（\`spec/anchor.json\` 记录的 commit 短前缀）
- **本工件出自哪次构建**：见同目录 \`provenance.json\`（spec 哈希 + 三个生成器 pin）
- **许可**：见同目录 \`NOTICE.md\`

许可口径行（本工件每个有注释位的文件首行都带它）：${BANNER}。本工件不发布到任何包管理器，属自用分发。
操作、路径与 schema 的计数一律由源仓的 \`npm run inventory\` 现出，不写在这里。`;
}

const LANG_LABEL: Record<ArtifactLang, string> = {
  typescript: 'TypeScript',
  python: 'Python',
  go: 'Go',
};

function header(lang: ArtifactLang): string {
  return `# SnowLuma WebUI 管理面客户端（${LANG_LABEL[lang]}）\n\n> ${BANNER}\n`;
}

export function renderReadme(lang: ArtifactLang, ctx: ReadmeCtx): string {
  switch (lang) {
    case 'typescript':
      return `${header(lang)}
## 这是什么

SnowLuma 5099 管理面的一份类型化调用面，由核对过上游源码的 OpenAPI 3.0.3 契约生成，
外加一层**行为适配层**：登录 → 同意闸 → 改密闸的可重入 bootstrap、401 按方法安全性分治、
destructive 分级闸，以及与 Python / Go 同形的单源规则表。

目录布局：\`generated/\` 是生成码，\`adapter/\` 是手写的行为适配层，\`index.ts\` 是二者的出口，
打包产物在 \`dist/\`。规则表在打包期内嵌进 \`dist/\`（真源是源仓的 \`adapters/rules.json\`）——
本目录同时带一份 \`rules.json\` 供查阅或显式覆盖，但默认路径**不读盘**：消费者的打包位置无法预知，
按"运行时文件的上一级"找表会在装包后 ENOENT（这条是出口闸第一次真跑 TS 腿时抓到的）。

两层的名字都从同一个包名拿：生成面给出 \`getSystem\`、\`login\` 这类类型化调用，适配层给出
\`createClient\`（行为层工厂，收注入的 \`transport\`）。另有两处显式另名，是实测撞名的处置而不是装饰：
SDK 自己的传输配置工厂在出口上叫 \`createSdkClient\`（\`createClient\` 归行为层），
每操作错误并集类型叫 \`SdkLoginError\`（\`LoginError\` 归适配层的引导失败类）。

非幂等写请求（POST / DELETE）遇到 401 **不自动重放**，抛 \`SessionExpiredError\`——
重复执行有实际后果，这是有意的行为差异，不是缺陷。

## 怎么装

包名 \`${TS_PACKAGE_NAME}\`（本地安装用，不发布到 npm）。

\`\`\`bash
npm install ./${ARTIFACT_DIRS.typescript}
\`\`\`

以 bundler 形态消费（vite / webpack / tsup 的默认解析）。生成码用无扩展名相对导入，
\`NodeNext\` 那套扩展名规则不适用，需要自行打包。运行时零第三方依赖（不发网络请求库，走全局 \`fetch\`）。

## 最小调用示例

见 \`examples/basic.ts\`（用注入的假 \`fetch\`，不连任何真实实例）：

\`\`\`ts
${indentExample('typescript')}
\`\`\`

跑通会打印 \`${OK_TOKEN.typescript}\`。

${provenance(ctx)}
`;
    case 'python':
      return `${header(lang)}
## 这是什么

两条**互不重叠**的抽象，别当成一层：

| 层 | 是什么 | 网络 |
| --- | --- | --- |
| \`${PY_PACKAGE}\` 生成客户端 | \`Client\` / \`AuthenticatedClient\` + 类型化模型 | 自带传输（依赖 \`httpx\`，\`attrs\` 建模） |
| \`${PY_PACKAGE}.adapter\` | 行为适配层：可重入 bootstrap 门控链、401 分治、destructive 闸、单源规则表 | **不持有网络实现**——\`transport\` 必须注入，模块内零 socket 代码 |

传输策略是部署决策：测试注入假传输，生产接 \`urllib\` / \`httpx\` 皆可（接线由调用方持有）。
\`rules.json\` 是本包的数据文件，与 \`adapter.py\` 同目录，构造 \`SnowlumaClient\` 时不传路径也会读到它。

## 怎么装

\`\`\`bash
python -m venv .venv && . .venv/bin/activate
pip install ./${ARTIFACT_DIRS.python}
\`\`\`

## 最小调用示例

见 \`examples/basic.py\`：

\`\`\`py
${indentExample('python')}
\`\`\`

跑通会打印 \`${OK_TOKEN.python}\`。

${provenance(ctx)}
`;
    case 'go':
      return `${header(lang)}
## 这是什么

SnowLuma 5099 管理面的 Go 客户端，由核对过上游源码的 OpenAPI 3.0.3 契约经 oapi-codegen 生成
（\`${GO_MODULE_ID}/${GO_PACKAGE_DIR}\`），外加手写的行为适配层
（\`${GO_MODULE_ID}/${GO_ADAPTER_DIR}\`）：可重入 bootstrap 门控链、401 按方法安全性分治、
destructive 分级闸、与 TS / Python 同形的单源规则表。

## 怎么装

**这是一个本地 module 工件，intentionally not a published Go module。** module id 落在
RFC 2606 保留域（\`example.com/...\`），它永不可被 \`go get\` 拉取——这是刻意的，
与本工件"不发布到包管理器"的口径一致。不要把 module id 改成可远程获取的路径。

\`\`\`bash
cd 你的项目
go work init
go work use ./${ARTIFACT_DIRS.go}
\`\`\`

\`rules.json\` 必须与本 module 同目录（适配层的默认解析按 \`LoadRules(path)\` 的相对层级读它，
不依赖工作目录）。

## 最小调用示例

见 \`examples/basic.go\`（\`go run ./examples\`）：

\`\`\`go
${indentExample('go')}
\`\`\`

跑通会打印 \`${OK_TOKEN.go}\`。

${provenance(ctx)}
`;
  }
}

export function renderExample(lang: ArtifactLang): string {
  switch (lang) {
    case 'typescript':
      return `// ${BANNER}
// 一个 specifier 拿两层：createClient 是手写行为适配层，getSystem 是生成的类型化调用面。
// 假传输按路径分派，让门控引导真的走到终止，而不是返回一个万能 200。
import { createClient, getSystem } from '${TS_PACKAGE_NAME}';

const routes: Record<string, unknown> = {
  '/api/login': { success: true, token: 't', mustChangePassword: false },
  '/api/agreements': { version: 'v1', consentRequired: false, documents: [] },
};

const transport = async (_method: string, path: string) => ({
  status: 200,
  json: routes[path] ?? { success: true },
});

const client = createClient({ baseUrl: 'http://127.0.0.1:5099', transport });
const state = await client.bootstrapSession({ password: 'x' });

console.log('${OK_TOKEN.typescript}', state.token === 't' && typeof getSystem === 'function');
`;
    case 'python':
      return `# ${BANNER}
"""最小消费：构造适配层客户端即触发规则表装载（不传 rules_path 也必须读到包内 rules.json）。"""

from ${PY_PACKAGE} import adapter


def transport(method, path, opts=None):
    """假传输：不发任何网络请求。真实接线由调用方持有（urllib / httpx 皆可）。"""
    return (200, {"success": True, "token": "t", "mustChangePassword": False})


client = adapter.SnowlumaClient(transport=transport)
print("${OK_TOKEN.python}", client.token is None)
`;
    case 'go':
      return `// ${BANNER}
// 最小消费：只构造生成物的请求体与读适配层的契约版本常量，不发任何请求。
package main

import (
	"fmt"

	"${GO_MODULE_ID}/${GO_ADAPTER_DIR}"
	"${GO_MODULE_ID}/${GO_PACKAGE_DIR}"
)

func main() {
	_ = ${GO_PACKAGE_DIR}.LoginJSONRequestBody{}
	fmt.Println("${OK_TOKEN.go}", ${GO_ADAPTER_DIR}.ContractVersion)
}
`;
  }
}

/** README 内嵌示例时统一缩进零基（模板串里不能留缩进，否则 markdown 代码块被带偏）。 */
function indentExample(lang: ArtifactLang): string {
  return renderExample(lang)
    .split('\n')
    .filter((l) => !l.startsWith('// ' + BANNER) && !l.startsWith('# ' + BANNER))
    .join('\n')
    .trim();
}
