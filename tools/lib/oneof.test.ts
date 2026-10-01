// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { findUnionOverlaps } from './oneof.js';

const doc = (yaml: string): unknown => parse(yaml);

describe('findUnionOverlaps', () => {
  it('开放分支 + 超集分支：真实的超集响应会同时命中两支 ⇒ 举证成功', () => {
    const issues = findUnionOverlaps(doc(`
      components:
        schemas:
          Weak:
            type: object
            required: [success, message, rules]
            properties:
              success: { type: boolean, enum: [false] }
              message: { type: string }
              rules: { type: array, items: { type: object } }
          Plain:
            type: object
            required: [success, message]
            properties:
              success: { type: boolean, enum: [false] }
              message: { type: string }
          Union:
            oneOf:
              - $ref: '#/components/schemas/Weak'
              - $ref: '#/components/schemas/Plain'
    `));
    expect(issues).toHaveLength(1);
    expect(issues[0].a).toBe('Weak');
    expect(issues[0].b).toBe('Plain');
    // witness 必须自带 rules —— 那正是"超集那一支被开放分支误收"的凭证
    expect(JSON.parse(issues[0].witness)).toEqual({ success: false, message: 'x', rules: [{}] });
  });

  it('把开放分支关死后同一对分支不再举证（这条就是 PasswordFailure 的修法）', () => {
    const issues = findUnionOverlaps(doc(`
      components:
        schemas:
          Weak:
            type: object
            required: [success, message, rules]
            properties:
              success: { type: boolean, enum: [false] }
              message: { type: string }
              rules: { type: array, items: { type: object } }
          Plain:
            type: object
            required: [success, message]
            additionalProperties: false
            properties:
              success: { type: boolean, enum: [false] }
              message: { type: string }
          Union:
            oneOf:
              - $ref: '#/components/schemas/Weak'
              - $ref: '#/components/schemas/Plain'
    `));
    expect(issues).toEqual([]);
  });

  it('两支靠互斥的单值 enum 区分时不报（设计口径的标准形状，不许误伤）', () => {
    const issues = findUnionOverlaps(doc(`
      components:
        schemas:
          Ok:
            type: object
            required: [success]
            properties: { success: { type: boolean, enum: [true] } }
          No:
            type: object
            required: [success]
            properties: { success: { type: boolean, enum: [false] } }
          Union:
            oneOf:
              - $ref: '#/components/schemas/Ok'
              - $ref: '#/components/schemas/No'
    `));
    expect(issues).toEqual([]);
  });

  it('子树里出现本模块不求值的关键字时判为不可判并闭嘴（宁可漏报也不误报）', () => {
    // not/pattern/… 都不在 EVALUABLE 里。若实现把它们当"无约束"照常求值，
    // 这里就会凭一个不成立的 witness 报红 —— 那正是本项目最忌讳的"校验器自己说谎"。
    for (const extra of ['not: { required: [rules] }', 'pattern: "^a$"']) {
      const issues = findUnionOverlaps(doc(`
        components:
          schemas:
            A:
              type: object
              required: [message]
              ${extra}
              properties: { message: { type: string } }
            B:
              type: object
              required: [message, rules]
              properties: { message: { type: string }, rules: { type: array, items: { type: object } } }
            Union:
              oneOf:
                - $ref: '#/components/schemas/A'
                - $ref: '#/components/schemas/B'
      `));
      expect(issues).toEqual([]);
    }
  });

  it('内联 oneOf（没有 $ref）也扫得到，标签退回分支下标', () => {
    const issues = findUnionOverlaps(doc(`
      paths:
        /x:
          post:
            responses:
              '200':
                content:
                  application/json:
                    schema:
                      oneOf:
                        - { type: object, required: [a], properties: { a: { type: string } } }
                        - { type: object, required: [a, b], properties: { a: { type: string }, b: { type: string } } }
    `));
    expect(issues).toHaveLength(1);
    expect(issues[0].at).toContain('oneOf');
    expect(issues[0].a).toBe('#0');
    expect(issues[0].b).toBe('#1');
  });

  it('两支各自都判不了的形状（无 type 无 enum）不产 witness，也不崩', () => {
    expect(() =>
      findUnionOverlaps(doc('components:\n  schemas:\n    U:\n      oneOf:\n        - { description: a }\n        - { description: b }\n')),
    ).not.toThrow();
    expect(findUnionOverlaps(doc('components:\n  schemas:\n    U:\n      oneOf:\n        - { description: a }\n        - { description: b }\n'))).toEqual([]);
  });

  it('悬空 $ref 不产误报（由 DANGLING_REF 另行报告）', () => {
    expect(
      findUnionOverlaps(doc('components:\n  schemas:\n    U:\n      oneOf:\n        - $ref: "#/components/schemas/Nope"\n        - { type: object, required: [a], properties: { a: { type: string } } }\n')),
    ).toEqual([]);
  });

  it('YAML 锚点共享子图（DAG）时仍要扫完，不能当成循环跳过', () => {
    const issues = findUnionOverlaps(doc(`
      components:
        schemas:
          Msg: &msg { type: string }
          Weak:
            type: object
            required: [success, message, rules]
            properties:
              success: { type: boolean, enum: [false] }
              message: *msg
              rules: { type: array, items: { type: object } }
          Plain:
            type: object
            required: [success, message]
            properties:
              success: { type: boolean, enum: [false] }
              message: *msg
          Union:
            oneOf:
              - $ref: '#/components/schemas/Weak'
              - $ref: '#/components/schemas/Plain'
    `));
    expect(issues).toHaveLength(1);
  });

  it('nullable 是能被正确求值的关键字，不是"不可判"的借口', () => {
    // A 接受 'a' 与 null 两个取值、B 只接受 'a' ⇒ 两支持有公共实例 {tag:'a'}，确实重叠。
    // 若实现把 nullable 当不可判整对跳过，这个重叠就报不出来 —— 那正是本用例要防的失明。
    const issues = findUnionOverlaps(doc(`
      components:
        schemas:
          A:
            type: object
            required: [tag]
            properties: { tag: { type: string, nullable: true, enum: ['a', null] } }
          B:
            type: object
            required: [tag]
            properties: { tag: { type: string, enum: ['a'] } }
          U:
            oneOf:
              - $ref: '#/components/schemas/A'
              - $ref: '#/components/schemas/B'
    `));
    expect(issues).toHaveLength(1);
    expect(JSON.parse(issues[0].witness)).toEqual({ tag: 'a' });
  });

  it('无 nullable 的一支不接受 null：省得把"类型写漏"当成重叠', () => {
    const issues = findUnionOverlaps(doc(`
      components:
        schemas:
          A:
            type: object
            required: [tag]
            properties: { tag: { type: 'null', enum: [null] } }
          B:
            type: object
            required: [tag]
            properties: { tag: { type: string } }
          U:
            oneOf:
              - $ref: '#/components/schemas/A'
              - $ref: '#/components/schemas/B'
    `));
    expect(issues).toEqual([]);
  });

  it('minimum 不使分支判不可判，且样本必须落在界内（否则自证会把真重叠判丢）', () => {
    // A 只有 count>=1；B 只有 count>=0。公共实例存在（count=1），必须报出来。
    // 若 sample() 对 integer 恒返回 1 之外的值或忽略 minimum，两支的自证会先失败 ⇒ 漏报。
    const issues = findUnionOverlaps(doc(`
      components:
        schemas:
          A:
            type: object
            required: [count]
            properties: { count: { type: integer, minimum: 1 } }
          B:
            type: object
            required: [count]
            properties: { count: { type: integer, minimum: 0 } }
          U:
            oneOf:
              - $ref: '#/components/schemas/A'
              - $ref: '#/components/schemas/B'
    `));
    expect(issues).toHaveLength(1);
    expect(JSON.parse(issues[0].witness)).toEqual({ count: 1 });
  });

  it('上下界互斥时不误报（界外实例必须被 matches 拒掉）', () => {
    const issues = findUnionOverlaps(doc(`
      components:
        schemas:
          A:
            type: object
            required: [n]
            properties: { n: { type: integer, minimum: 10 } }
          B:
            type: object
            required: [n]
            properties: { n: { type: integer, maximum: 5 } }
          U:
            oneOf:
              - $ref: '#/components/schemas/A'
              - $ref: '#/components/schemas/B'
    `));
    // A 声明 minimum:10 ⇒ 样本 n=10 越出 B 的上界 5；B 没声明 minimum ⇒ sample() 取默认 1，
    // 1 在 B 自己的 maximum:5 之内、却低于 A 的下界 10 ⇒ 两个方向都举不出证。
    // 注意这不是"证明了互斥"：真实重叠区（比如 n=3 且两支都不含对方独有的界）本例不存在，
    // 一旦某支还带别的必填键，实例合成会先失败从而漏报 —— 漏报是本项目允许的失败方向。
    expect(issues).toEqual([]);
  });

  it('真 $ref 循环（A→B→A 互指）有限时间返回且不举 witness——去重护栏的终止性钉住', () => {
    // matches 的 seen 集与 sample 的 depth 封顶是仅有的两道护栏；护栏被移除时本用例
    // 以栈溢出而非断言失败的形式变红——同样是红，且能在合成 spec 上复现。
    // 两支在 success 上互斥（enum false vs true）⇒ 正确结果是不报重叠；
    // child 的互指 $ref 让解析必须真的走进环里才出得了结果。
    const issues = findUnionOverlaps(doc(`
      components:
        schemas:
          A:
            type: object
            required: [success]
            properties:
              success: { type: boolean, enum: [false] }
              child: { $ref: '#/components/schemas/B' }
          B:
            type: object
            required: [success]
            properties:
              success: { type: boolean, enum: [true] }
              child: { $ref: '#/components/schemas/A' }
          Union:
            oneOf:
              - $ref: '#/components/schemas/A'
              - $ref: '#/components/schemas/B'
    `));
    expect(issues).toEqual([]);
  });
});
