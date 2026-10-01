派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器

本目录（`spec/`）下的**全部**产物均为派生产物：内容抄录或生成自 SnowLuma 上游源码，
仅用于非商业自用，**不发布到包管理器**（npm / PyPI / Go module）。本仓 GitHub Release
工件（三语 SDK tarball）属自用分发，不在此禁止之列——口径收缩的裁定与理由见
`docs/concepts/upstream-sync.md`。本声明的范围**顺延到根下的 `extracted/`** —— 它是
上一条豁免规则点名的目录，正因其内文件按规则不携带本行，覆盖它的这句话不能只写在
`spec/` 里（终审 N-9）。

JSON 一类无注释语法、且结构由代码 interface 严格读取的产物（如 `anchor.json`、`extracted/*.json`），
不在文件内携带本声明，由本文件覆盖声明。有注释语法或元数据字段的产物
（`.ts` / `.go` / `.py` / YAML `info.description` 等）仍须在产物内写明该行。
