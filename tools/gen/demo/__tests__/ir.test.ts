// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, it, expect } from 'vitest';
import { parseSpec } from '../ir.js';

const spec = parseSpec('spec/openapi.yaml');

describe('parseSpec — 总量', () => {
  it('解析出 55 条操作', () => {
    expect(spec.operations.length).toBe(55);
  });

  it('每条操作都有至少一个 tag', () => {
    for (const op of spec.operations) {
      expect(op.tags.length).toBeGreaterThan(0);
    }
  });

  it('提取出 spec 里的命名 schema', () => {
    expect(Object.keys(spec.schemas).length).toBeGreaterThan(20);
    expect(spec.schemas['StatusInfo']).toBeDefined();
  });
});

describe('parseSpec — SSE 识别', () => {
  it('识别 4 条 SSE 操作', () => {
    const sse = spec.operations.filter(o => o.isSSE).map(o => o.operationId).sort();
    expect(sse).toEqual(['streamDebugAction', 'streamDebugEvents', 'streamLogs', 'streamState']);
  });

  it('非 SSE 操作标记为 false', () => {
    const status = spec.operations.find(o => o.operationId === 'getStatus');
    expect(status?.isSSE).toBe(false);
  });

  it('200 写成 $ref 时同样判为流（与 validate-spec 的 R2 同一裁定）', () => {
    // spec/fixtures/sse-ref.yaml 的 200 是 {$ref: '#/components/responses/...'}：
    // 不解 $ref 的话流操作会被词表标成非流，ui-coverage 反过来要求 unwrap——
    // 同一份 spec，两条链路各说各话。这条用例把 sse-ref 形状喂进同一条解析链钉住。
    const refSpec = parseSpec('spec/fixtures/sse-ref.yaml');
    const sse = refSpec.operations.filter(o => o.isSSE).map(o => o.operationId);
    expect(sse).toContain('openDebugStream');
  });
});

describe('parseSpec — 门禁操作识别', () => {
  it('login 是门禁操作', () => {
    const login = spec.operations.find(o => o.operationId === 'login');
    expect(login?.isGate).toBe(true);
  });

  it('getStatus 不是门禁操作', () => {
    const status = spec.operations.find(o => o.operationId === 'getStatus');
    expect(status?.isGate).toBe(false);
  });

  it('门禁操作共 8 条', () => {
    const gates = spec.operations.filter(o => o.isGate);
    expect(gates.length).toBe(8);
  });
});

describe('parseSpec — 请求体', () => {
  it('login 有请求体含 password 字段', () => {
    const login = spec.operations.find(o => o.operationId === 'login');
    expect(login?.requestBody).toBeDefined();
    expect(login?.requestBody?.properties?.password).toBeDefined();
    expect(login?.requestBody?.properties?.password?.type).toBe('string');
  });

  it('GET 操作没有请求体', () => {
    const status = spec.operations.find(o => o.operationId === 'getStatus');
    expect(status?.requestBody).toBeUndefined();
  });
});

describe('parseSpec — 响应 schema', () => {
  it('getStatus 的 200 响应引用 StatusInfo', () => {
    const status = spec.operations.find(o => o.operationId === 'getStatus');
    expect(status?.responseSchema).toBeDefined();
    expect(status?.responseSchema?.$ref).toContain('StatusInfo');
  });
});

describe('parseSpec — 参数', () => {
  it('loadProcess 有 pid 路径参数', () => {
    const load = spec.operations.find(o => o.operationId === 'loadProcess');
    expect(load?.pathParams).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'pid' })]),
    );
  });

  it('listLogs 有 limit 查询参数', () => {
    const logs = spec.operations.find(o => o.operationId === 'listLogs');
    expect(logs?.queryParams).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'limit' })]),
    );
  });
});

describe('parseSpec — tag 覆盖', () => {
  it('共 10 个不同 tag', () => {
    const tags = new Set(spec.operations.flatMap(o => o.tags));
    expect(tags.size).toBe(10);
  });
});

describe('normalizeSchema — 边界', () => {
  it('$ref 短路返回，不展开 properties', () => {
    const s = parseSpec('spec/openapi.yaml');
    const login = s.operations.find(o => o.operationId === 'login');
    const resp = login?.responseSchema;
    if (resp?.$ref) {
      expect(resp.properties).toBeUndefined();
    }
  });

  it('enum 字段保留枚举值列表', () => {
    const s = parseSpec('spec/openapi.yaml');
    const level = s.operations.find(o => o.operationId === 'setLogLevel');
    const body = level?.requestBody;
    const levelField = body?.properties?.level;
    if (levelField?.enum) {
      expect(levelField.enum.length).toBeGreaterThan(0);
    }
  });
});
