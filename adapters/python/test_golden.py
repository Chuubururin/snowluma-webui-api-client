# 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
"""三语 golden fixture（设计口径）Python 侧：读同一份 cases.json。

用例可带自有 rules 表（触达仓库表覆盖不到的 rename/链式/无条件分支），同样过 validate_rules。
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from snowluma_adapter import apply_rules, load_rules, validate_rules

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[1] / "golden" / "cases.json").read_text(encoding="utf-8")
)


class GoldenFixtureTests(unittest.TestCase):
    def setUp(self):
        self.rules = load_rules()

    def test_cases(self):
        for case in GOLDEN["cases"]:
            with self.subTest(case=case["name"]):
                table = validate_rules({"schemaVersion": "1.0.0", "rules": case["rules"]}) if "rules" in case else self.rules
                out = apply_rules(table, case["method"], case["path"], case["response"])
                self.assertEqual(out, case["expected"])


if __name__ == "__main__":
    unittest.main()
