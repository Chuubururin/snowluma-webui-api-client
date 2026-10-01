// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_TIER_COUNTS,
  REPLAY_CLASS_BY_OP,
  SIDE_EFFECT_LABELS,
  VERIFICATION_STATUSES,
  normalizeParamForm,
  replayClassOf,
  tierKey,
} from './tiers.js';

const op = (method: string, path: string) => ({ method, path, file: 'x', line: 1 });

describe('REPLAY_CLASS_BY_OP', () => {
  it('覆盖设计口径的完整 55 个操作', () => {
    expect(Object.keys(REPLAY_CLASS_BY_OP)).toHaveLength(55);
  });

  it('三档计数与 spec 逐字一致', () => {
    const counts = { t1: 0, t2: 0, t3: 0 } as Record<string, number>;
    for (const v of Object.values(REPLAY_CLASS_BY_OP)) counts[v] += 1;
    expect(counts).toEqual(EXPECTED_TIER_COUNTS);
    expect(EXPECTED_TIER_COUNTS).toEqual({ t1: 25, t2: 7, t3: 23 });
  });

  it('键格式为 "METHOD /path"', () => {
    expect(tierKey(op('GET', '/api/logs'))).toBe('GET /api/logs');
    expect(Object.keys(REPLAY_CLASS_BY_OP).every((k) => /^(GET|POST|PUT|DELETE|PATCH) \//.test(k))).toBe(true);
  });

  // 设计口径：按方法分档必然漏掉的两个例子，必须显式钉住
  it('GET 但涉密/涉真实进程的操作归 T3', () => {
    expect(replayClassOf(op('GET', '/api/system/backup/export'))).toBe('t3');
    expect(replayClassOf(op('GET', '/api/processes/:pid/probe-login'))).toBe('t3');
  });

  it('POST 但纯计算的操作归 T1', () => {
    expect(replayClassOf(op('POST', '/api/auth/check-strength'))).toBe('t1');
  });

  it('三条 SSE 归 T1', () => {
    for (const p of ['/api/logs/stream', '/api/state/stream', '/api/debug/stream']) {
      expect(replayClassOf(op('GET', p))).toBe('t1');
    }
  });

  it('login/logout 归 T2 而非 T1（改变服务端会话表）', () => {
    expect(replayClassOf(op('POST', '/api/login'))).toBe('t2');
    expect(replayClassOf(op('POST', '/api/logout'))).toBe('t2');
  });

  it('未归类操作抛错，不允许静默通过', () => {
    expect(() => replayClassOf(op('GET', '/api/brand-new-endpoint'))).toThrow(/未归类/);
  });
});

// 裁定 R18：验证状态取值是单一真源，必须可回归而非仅类型层巧合
describe('VERIFICATION_STATUSES', () => {
  it('恰为五个约定取值，顺序无关，无拼写变体', () => {
    expect([...VERIFICATION_STATUSES].sort()).toEqual(
      ['destructive-static-only', 'static-only', 'unverified-requires-nondev', 'unverified-requires-qq', 'verified'].sort(),
    );
    expect(VERIFICATION_STATUSES).toHaveLength(5);
  });
});

// 裁定 R18 的同一处理方式（终审 I3c）：设计口径把 x-snowluma-side-effects 的取值绑在
// 扫描器的七个标签上，并警告"新增标签必须同步改 CHECKERS，否则声明与扫描各说各话"。
// 词表此前是 side-effects-scan.ts 的模块私有数组，校验器无从引用 ⇒ 拼错的标签
// （`external_request` 少一个连字符）会静默废掉设计口径那条"GET 带 external-fetch 永不自动重放"。
describe('SIDE_EFFECT_LABELS', () => {
  it('恰为设计口径的七个标签，顺序与扫描器书写顺序一致', () => {
    expect([...SIDE_EFFECT_LABELS]).toEqual([
      'persist',
      'save',
      'clear',
      'delete-or-write-fs',
      'cookie',
      'external-fetch',
      'mutate-map',
    ]);
    expect(SIDE_EFFECT_LABELS).toHaveLength(7);
  });

  it('服务端日志不计入副作用（设计口径明文排除）', () => {
    for (const forbidden of ['log', 'logging', 'report-error', 'server-log']) {
      expect(SIDE_EFFECT_LABELS).not.toContain(forbidden);
    }
  });
});

// 裁定 R19：OpenAPI 的 {x} 与上游 Express 的 :x 是同一参数的两种写法，归一化真源在此文件
describe('normalizeParamForm', () => {
  it('把 {uin} / {pid} 归一为 Express 的 :uin / :pid', () => {
    expect(normalizeParamForm('/api/config/{uin}')).toBe('/api/config/:uin');
    expect(normalizeParamForm('/api/processes/{pid}/probe-login')).toBe('/api/processes/:pid/probe-login');
  });

  it('无参路径原样返回', () => {
    expect(normalizeParamForm('/api/logs')).toBe('/api/logs');
    expect(normalizeParamForm('/api/debug/invoke-stream')).toBe('/api/debug/invoke-stream');
  });

  it('tiers.ts 自身的 6 条含参键已是 Express 形式，归一化前后身份不变', () => {
    const parameterized = Object.keys(REPLAY_CLASS_BY_OP).filter((k) => k.includes(':'));
    expect(parameterized).toHaveLength(6);
    for (const key of parameterized) expect(normalizeParamForm(key)).toBe(key);
    // 归一化后的键仍能命中真源（两侧比较的可行性）
    expect(replayClassOf(op('GET', normalizeParamForm('/api/config/{uin}')))).toBe('t1');
    expect(replayClassOf(op('GET', normalizeParamForm('/api/processes/{pid}/probe-login')))).toBe('t3');
  });
});
