# 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
"""openapi-python-client 的 post_hook：给输出目录内所有 .py 补一行许可声明。

实测约束（spike/findings.md Q6 · tools.lock.json → generationConstraints['openapi-python-client']）：

* post_hooks 由生成器经 shell 执行，cwd 是输出目录、不传文件名，
  所以本脚本自己遍历 cwd —— 这也意味着"跑错目录"的代价是把别人的文件改了，
  下方对"看起来像仓库根"的情形直接拒跑。
* 命令首 token 必须不带引号且在 PATH 上（`shutil.which`），所以 python-config.yml 里写的是
  `python ../../tools/gen/add-header.py`；而 venv 的 Scripts 目录不在 PATH 上时，
  ruff 与本 hook 都会被静默跳过（"Skipping Integration"），头部就不会落进产物。
* 三家生成器重新生成都会整体覆盖文件（Q6），所以头部只能走生成器配置，不能靠生成后手工插。

只用标准库：本脚本由 `python`（venv 里的解释器）执行，不依赖生成器的包。
"""
import pathlib
import sys

BANNER = "派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器"
PY_BANNER = f"# {BANNER}"

root = pathlib.Path(".")

# 防跑错目录：post_hook 的 cwd 应是 generated/python，若同时看到 tools.lock.json 与 spec/，
# 那是仓库根 —— 在那儿遍历 *.py 会给本仓库自己的脚本盖章，静默污染源码。
if (root / "tools.lock.json").exists() and (root / "spec").is_dir():
    sys.exit("add-header.py 拒绝在仓库根运行（post_hook 的 cwd 应是生成输出目录）")

targets = sorted(root.rglob("*.py"))
if not targets:
    sys.exit(f"add-header.py 在 {root.resolve()} 下没找到任何 .py —— cwd 不对，拒绝视为成功")

changed = 0
for p in targets:
    text = p.read_text(encoding="utf8")
    if PY_BANNER in text.splitlines()[:3]:
        continue
    lines = text.splitlines(keepends=True)
    insert_at = 1 if lines and lines[0].startswith("#!") else 0
    lines.insert(insert_at, PY_BANNER + "\n")
    p.write_text("".join(lines), encoding="utf8")
    changed += 1

print(f"banner ok: {PY_BANNER!r} -> python 产物 {len(targets)} 个文件（本次新插入 {changed}）")
