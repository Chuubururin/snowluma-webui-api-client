# 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
"""规则表默认解析的三条分支。

判据是"装包后不传 path 也必须读到规则表"：适配层一旦只认仓内深度，工件离开本仓布局
就读不到表 —— 而仓内测试全跑在 adapters/python/ 这个深度上，永远看不见那条失效。
包内 sibling 优先这条必须有"两处都有表"的用例，否则它退化成"父目录那条也过"的假断言。
"""

import tempfile
import unittest
from pathlib import Path

from snowluma_adapter import load_rules, resolve_rules_path


class RulesResolution(unittest.TestCase):
    def test_repo_layout_resolves_to_adapters_rules(self):
        here = Path(__file__).resolve().parent
        got = resolve_rules_path(here)
        self.assertEqual(got, here.parent / "rules.json")
        self.assertTrue(got.exists(), "仓内布局必须读到 adapters/rules.json")

    def test_packaged_sibling_wins(self):
        """两处都有表时必须选包内 sibling —— 装包后的布局全靠这一条。"""
        with tempfile.TemporaryDirectory() as td:
            pkg = Path(td) / "snowluma_client"
            pkg.mkdir()
            (pkg / "rules.json").write_text('{"sibling": true}', encoding="utf-8")
            (Path(td) / "rules.json").write_text('{"parent": true}', encoding="utf-8")
            self.assertEqual(resolve_rules_path(pkg), pkg / "rules.json")

    def test_default_load_rules_reads_a_valid_table(self):
        """不传 path 的默认装载必须过结构校验：读到半张表也算失效。"""
        table = load_rules()
        self.assertIn("rules", table)
        self.assertTrue(table["rules"], "默认规则表为空，等于归一化静默不生效")

    def test_missing_table_does_not_fall_back_silently(self):
        """两处都没有表时不得静默返回一个能用的东西：报错要来自文件不存在。"""
        with tempfile.TemporaryDirectory() as td:
            pkg = Path(td) / "snowluma_client"
            pkg.mkdir()
            self.assertFalse(resolve_rules_path(pkg).exists())
            with self.assertRaises(FileNotFoundError):
                load_rules(str(pkg / "rules.json"))


if __name__ == "__main__":
    unittest.main()
