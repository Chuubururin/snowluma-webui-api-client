// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REFERENCE_TIER, resolveUpstreamFile, symbolNearLine } from './lib/reference-tier.js';

describe('reference tier', () => {
  it('锚定文件能解析到 vendor 本地路径', async () => {
    const r = await resolveUpstreamFile('packages/webui/src/lib/api/client.ts');
    expect(r).not.toBeNull();
    expect(r!.tier).toBe('anchored');
  });
  it('未进锚定清单的文件解析不到（不得当豁免依据）', async () => {
    expect(await resolveUpstreamFile('packages/webui/src/components/pages/does-not-exist.tsx')).toBeNull();
  });
  it('前端组件页已随 Tier A 升级进清单', async () => {
    const r = await resolveUpstreamFile('packages/webui/src/components/pages/overview-page.tsx');
    expect(r, 'overview-page.tsx 必须已锚定，否则 parity 表的面板出处无法机器核对').not.toBeNull();
    expect(r!.tier).toBe('anchored');
  });
  it('symbolNearLine 只在窗口内认符号', async () => {
    const r = (await resolveUpstreamFile('packages/core/src/webui/consent.ts'))!;
    expect(await symbolNearLine(r.absPath, 226, 'isConsentRequired')).toBe(true);
    expect(await symbolNearLine(r.absPath, 226, 'totallyMadeUpSymbol')).toBe(false);
  });
  it('窗口外不算命中（±5 是本仓对"行号引用"的容忍上限）', async () => {
    const r = (await resolveUpstreamFile('packages/core/src/webui/consent.ts'))!;
    expect(await symbolNearLine(r.absPath, 226, 'isConsentRequired', 0)).toBe(true);
    expect(await symbolNearLine(r.absPath, 1, 'isConsentRequired', 5)).toBe(false);
  });
  it('判定结果 ∈ {A,B}，且与 vendor 实际能不能解到前端组件一致', () => {
    expect(['A', 'B']).toContain(REFERENCE_TIER);
    if (REFERENCE_TIER === 'A') {
      // 判 A 的唯一合法依据：前端组件真的在 vendor 里，且 anchor 仍钉在既定 commit
      return resolveUpstreamFile('packages/webui/src/router/index.tsx').then((r) =>
        expect(r, '判 A 却没解到 router/index.tsx ⇒ 判定是空的').not.toBeNull(),
      );
    }
    return Promise.resolve();
  });
  it('anchor.commit 是完整的 40 位十六进制 SHA（green-advance 机械换锚，陈旧性归 drift/计数门禁）', () => {
    // 硬编码"仍钉在既定 commit"曾让首次真实 green-advance 的 PR 必红：机械换锚是
    // 已裁定的合法路径，锚点是否陈旧由 countExpectations/哈希比对负责，这里只钉形状。
    const commit = JSON.parse(readFileSync('spec/anchor.json', 'utf8')).commit;
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
  });
});
