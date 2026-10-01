// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 契约版本与 spec 描述的漂移守卫。
 *
 * 两类失效各钉一条：
 *  ① `info.version` 不再是三段 semver —— 出口 metadata 与 Release tag 都从它派生，
 *     它是占位符时三语工件就没有共同的版本语义；
 *  ② `info.description` 里重新长出会漂移的绝对计数或阶段自述 —— 契约从 12 长到全量时
 *     描述没跟上过一次（"实现进入下一阶段、叙述没跟上"），根因就是这类句子被写进真源。
 *
 * 计数的唯一归宿是 `npm run inventory`；阶段属 RoadMap，不属契约。
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

interface SpecInfo {
  version: string;
  description?: string;
}

function specInfo(): SpecInfo {
  const doc = parseYaml(readFileSync('spec/openapi.yaml', 'utf8')) as { info: SpecInfo };
  return doc.info;
}

/** 契约版本唯一真源。Task 3 的打包器与 Task 6 的 Release tag 都按这一句读法取值。 */
export function specContractVersion(): string {
  return specInfo().version;
}

describe('契约版本真源', () => {
  it('info.version 是 X.Y.Z 三段 semver', () => {
    expect(specContractVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('info.description 不含会被契约增长拖漂的绝对计数句', () => {
    const d = specInfo().description ?? '';
    expect(d).not.toMatch(/仅\s*\d+\s*个操作/);
    expect(d).not.toMatch(/全\s*\d+\s*操作/);
  });

  it('info.description 不写阶段自述（垂直切片那类，阶段属 RoadMap 不属契约）', () => {
    expect(specInfo().description ?? '').not.toMatch(/垂直切片/);
  });
});
