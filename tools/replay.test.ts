// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import {
  TierRefusedError,
  collectReplay,
  opsForTier,
  parseArgs,
  substitutePath,
  type Client,
  type ReplayRecord,
} from './replay.js';

function fakeClient(handler: (method: string, path: string, body?: unknown) => Promise<unknown>): Client {
  return {
    bootstrapSession: async () => {
      throw new Error('测试内不应触发 bootstrap');
    },
    request: handler,
    token: 'test-token',
  } as unknown as Client;
}

describe('opsForTier（tiers.ts 单源）', () => {
  it('t1=25 / t2=7，与 EXPECTED_TIER_COUNTS 一致', () => {
    expect(opsForTier('t1')).toHaveLength(25);
    expect(opsForTier('t2')).toHaveLength(7);
  });
  it('t3 不在可请求档位（收集器另有硬拒绝）', () => {
    // 't3' 在 Tier 类型里合法存在，运行期由收集器硬拒绝；这里只验证列表查询无害。
    expect(() => opsForTier('t3')).not.toThrow(); // 列表查询无害；真正的拒绝在 collectReplay
  });
});

describe('substitutePath（R19：Express 形 :x）', () => {
  it('替换具名参数；缺失返回 null', () => {
    expect(substitutePath('/api/config/:uin', { uin: '12345' })).toBe('/api/config/12345');
    expect(substitutePath('/api/processes/:pid/load', {})).toBeNull();
  });
  it('值做 URI 编码', () => {
    expect(substitutePath('/api/x/:name', { name: 'a b' })).toBe('/api/x/a%20b');
  });
});

describe('collectReplay', () => {
  it('t3 → TierRefusedError（永不自动重放）', async () => {
    const c = fakeClient(async () => ({}));
    // 't3' 在 Tier 类型里合法存在（tiers.ts 有 23 条 t3），运行期由收集器硬拒绝。
    await expect(collectReplay({ client: c, tier: 't3' })).rejects.toBeInstanceOf(TierRefusedError);
  });

  it('t2 无可牺牲声明 → TierRefusedError', async () => {
    const c = fakeClient(async () => ({}));
    await expect(collectReplay({ client: c, tier: 't2' })).rejects.toBeInstanceOf(TierRefusedError);
    await expect(
      collectReplay({ client: c, tier: 't2', disposeInstance: true }),
    ).resolves.toBeDefined();
  });

  it('t1 全流程：命中、路径参数缺失跳过、无请求体跳过、SSE 跳过、错误记录', async () => {
    const seen: Array<{ m: string; p: string }> = [];
    const c = fakeClient(async (m, p) => {
      seen.push({ m, p });
      if (p === '/api/status') return { status: 'running' };
      throw Object.assign(new Error('无效的账号'), { status: 400 });
    });
    const report = await collectReplay({
      client: c,
      tier: 't1',
      params: {},
      bodies: { 'POST /api/auth/check-strength': { password: 'x' } },
    });
    // SSE 三条必须被跳过（JSON 重放对 event-stream 无意义）
    const skippedStreams = report.results.filter(
      (r): r is { op: string; skipped: string } => 'skipped' in r && r.op.includes('/stream'),
    );
    expect(skippedStreams).toHaveLength(3);
    // check-strength 有体 → 已发；config/qq-list 类带 :uin 的 → 缺参数跳过
    expect(seen).toContainEqual({ m: 'GET', p: '/api/status' });
    expect(seen).toContainEqual({ m: 'POST', p: '/api/auth/check-strength' });
    const statusRec = report.results.find((r): r is ReplayRecord => 'status' in r && r.op === 'GET /api/status');
    expect(statusRec?.status).toBe(200);
    const errRec = report.results.find((r): r is ReplayRecord => 'error' in (r as ReplayRecord) && r.op === 'GET /api/debug/actions');
    expect(errRec?.status).toBe(400);
    expect(report.replayed + report.skipped).toBe(25);
  });

  it('params 齐备时 :uin/:pid 端点也会被重放', async () => {
    const seen: string[] = [];
    const c = fakeClient(async (_m, p) => {
      seen.push(p);
      return {};
    });
    const report = await collectReplay({
      client: c,
      tier: 't1',
      params: { uin: '12345', pid: '999' },
      bodies: { 'POST /api/auth/check-strength': { password: 'x' } },
    });
    expect(seen).toContain('/api/config/12345');
    // probe-login 是 T3（tiers.ts 归档），不出现在 t1 集合 —— 这正是单源清单的意义。
    expect(seen).not.toContain('/api/processes/999/probe-login');
    expect(report.skipped).toBe(3); // 仅 SSE 三条
  });
});

describe('parseArgs', () => {
  it('tier 白名单外拒绝（T3 永不）', () => {
    expect(() => parseArgs(['node', 'replay.ts', '--tier', 't3', '--password', 'p'])).toThrow(TierRefusedError);
    expect(() => parseArgs(['node', 'replay.ts'])).toThrow(TierRefusedError);
    expect(() => parseArgs(['node', 'replay.ts', '--tier', 't1'])).toThrow(/--password/);
  });

  it('内联 JSON 参数与默认值', () => {
    const args = parseArgs([
      'node', 'replay.ts',
      '--tier', 't2',
      '--password', 'pw',
      '--i-have-disposable-instance',
      '--params', '{"uin":"12345"}',
      '--bodies', '{"POST /api/logs/level":{"level":"debug"}}',
    ]);
    expect(args.tier).toBe('t2');
    expect(args.dispose).toBe(true);
    expect(args.params).toEqual({ uin: '12345' });
    expect(args.bodies).toEqual({ 'POST /api/logs/level': { level: 'debug' } });
    expect(args.baseUrl).toBe('http://127.0.0.1:5099');
  });
});
