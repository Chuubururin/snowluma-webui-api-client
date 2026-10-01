// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
// 三语 golden fixture（设计口径）：同一份 cases.json 喂三份适配层，
// 比较解析后的规范化对象。本文件是 TypeScript 侧；Python/Go 侧读同一份文件。
// 用例可带自有 rules 表（触达仓库表覆盖不到的 rename/链式/无条件分支），同样过 validateRules。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyRules, loadRules, validateRules } from './rules.js';

const GOLDEN = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'golden', 'cases.json'), 'utf8'),
) as {
  cases: Array<{ name: string; method: string; path: string; response: unknown; expected: unknown; rules?: unknown }>;
};

describe('三语 golden fixture（规则单源 TS 侧）', () => {
  const rules = loadRules();
  for (const c of GOLDEN.cases) {
    it(c.name, () => {
      // 按键存在性分派（与 Python/Go 同裁定）：null 是非法表（validateRules 抛），
      // [] 是合法空表——truthiness 分派会让 null 静默回退仓库表、[] 在 Go 侧行为漂移。
      const table = 'rules' in c ? validateRules({ schemaVersion: '1.0.0', rules: c.rules }) : rules;
      expect(applyRules(table, c.method, c.path, c.response)).toEqual(c.expected);
    });
  }
});
