// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import { resolveLocalPointer } from './pointer.js';

describe('resolveLocalPointer', () => {
  const doc = {
    components: {
      schemas: {
        Pet: { type: 'object', properties: { name: { type: 'string' } } },
      },
    },
  };

  it('解析正常路径', () => {
    const r = resolveLocalPointer(doc, '#/components/schemas/Pet');
    expect(r.found).toBe(true);
    expect(r.value).toEqual({ type: 'object', properties: { name: { type: 'string' } } });
  });

  it('不存在的键返回 found=false', () => {
    expect(resolveLocalPointer(doc, '#/components/schemas/Nope').found).toBe(false);
  });

  it('原型链键不命中（constructor/toString/hasOwnProperty 等）', () => {
    // 修复前 `key in cur` 会沿原型链走，`#/components/schemas/constructor` 返回
    // found=true, value=function Object()，让 DANGLING_REF 门禁说谎。
    expect(resolveLocalPointer(doc, '#/components/schemas/constructor').found).toBe(false);
    expect(resolveLocalPointer(doc, '#/components/schemas/toString').found).toBe(false);
    expect(resolveLocalPointer(doc, '#/components/schemas/hasOwnProperty').found).toBe(false);
    expect(resolveLocalPointer(doc, '#/components/schemas/__proto__').found).toBe(false);
  });

  it('根指针返回整个文档', () => {
    expect(resolveLocalPointer(doc, '#').value).toBe(doc);
    expect(resolveLocalPointer(doc, '#/').value).toBe(doc);
  });

  it('转义字符（~0 → ~，~1 → /）', () => {
    const d = { 'a~b': 1, 'c/d': 2 };
    expect(resolveLocalPointer(d, '#/a~0b').value).toBe(1);
    expect(resolveLocalPointer(d, '#/c~1d').value).toBe(2);
  });
});
