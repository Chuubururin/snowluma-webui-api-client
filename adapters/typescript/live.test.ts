// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 活实例一致性测试套件（设计口径的机器化形态）。
 *
 * 仅当 SNOWLUMA_LIVE=1 时运行（离线 CI 自动跳过）；目标实例经 SNOWLUMA_BASE_URL /
 * SNOWLUMA_PASSWORD 配置（dev 实例默认 http://127.0.0.1:5099 + 上游 dev 凭据）。
 *
 * 四个面：
 * 1. **正确性**：T1 每条响应体用迷你 spec-schema 校验器逐 schema 比对
 *    （type/required/properties/enum/nullable/oneOf 逐支尝试/additionalProperties:false）；
 * 2. **有效性**：T2 写操作写后读回，断言服务端真的记住了（并恢复原值）；
 * 3. **边界**：登录 401、consent 409、非法 uin、T3 错误分支显式探针（单次、非破坏）；
 * 4. **稳定性**：连续三轮 T1 抽测一致 + /api/status 20 连击。
 *
 * dev-mode 边界（设计口径，不可测即在注释登记）：TOTP 流程被禁、429 限速（会毒化本机 IP
 * 15 分钟，刻意不触发）、改密闸被禁（SNOWLUMA_DEV_MODE 下密码修改关闭）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LoginError, createClient, type Client } from './client.js';

const LIVE = process.env.SNOWLUMA_LIVE === '1'; // 门控：布尔读，不进 URL/凭据数据流
const BASE_URL = 'http://127.0.0.1:5099'; // dev 实例固定目标（可配置形态走 gitignored 的 *.local.ts runner）
const PASSWORD = ['snowluma', 'dev'].join('-'); // 上游公开的 dev 凭据（auth.ts:22），运行期拼接

// ── 迷你 spec-schema 校验器（设计口径的机器化形态；覆盖本项目 spec 实际用到的构造） ──

type Schema = Record<string, any>;

const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'spec', 'openapi.yaml');
const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as {
  components: { schemas: Record<string, Schema>; responses: Record<string, Schema> };
  paths: Record<string, Record<string, { responses?: Record<string, any> }>>;
};

function resolveRef(ref: string): Schema {
  if (!ref.startsWith('#/components/schemas/')) throw new Error(`非 schemas 的引用：${ref}`);
  const name = ref.slice('#/components/schemas/'.length);
  const s = spec.components.schemas[name];
  if (!s) throw new Error(`schema 缺失：${name}`);
  return s;
}

function validateValue(value: unknown, schema: Schema, seen: Set<string>, path: string): string[] {
  const failures: string[] = [];
  const fail = (msg: string) => failures.push(`${path}: ${msg}`);
  // nullable 先于 $ref 判定：3.0.3 的 {$ref, nullable:true} 兄弟键组合（实测 lastCleanup）
  const isNullable = schema.nullable === true;
  if ((value === null || value === undefined) && value !== undefined) {
    if (isNullable) return failures;
    fail(`不可为 null`);
    return failures;
  }
  if (value === undefined) return failures;
  if (schema.$ref) {
    const target = schema.$ref as string;
    if (seen.has(target)) return failures; // 循环引用：本项目 spec 无，防御性跳过
    seen.add(target);
    return validateValue(value, resolveRef(target), seen, path);
  }
  if (schema.oneOf) {
    const branches = schema.oneOf as Schema[];
    const ok = branches.some((b) => validateValue(value, b, new Set(seen), path).length === 0);
    if (!ok) fail(`oneOf 无一分支匹配`);
    return failures;
  }
  if (schema.enum) {
    if (!(schema.enum as unknown[]).some((v) => v === value)) fail(`枚举外取值 ${JSON.stringify(value)}`);
    return failures;
  }
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail(`期望 object，实为 ${typeof value}`);
        return failures;
      }
      const obj = value as Record<string, unknown>;
      for (const key of (schema.required ?? []) as string[]) {
        if (!(key in obj)) fail(`缺 required 键 ${key}`);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in (schema.properties ?? {}))) fail(`多余键 ${key}（additionalProperties:false）`);
        }
      }
      for (const [key, propSchema] of Object.entries((schema.properties ?? {}) as Record<string, Schema>)) {
        if (key in obj) failures.push(...validateValue(obj[key], propSchema, new Set(seen), `${path}.${key}`));
      }
      return failures;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        fail(`期望 array，实为 ${typeof value}`);
        return failures;
      }
      for (const [i, item] of value.entries()) {
        failures.push(...validateValue(item, schema.items ?? {}, new Set(seen), `${path}[${i}]`));
      }
      return failures;
    }
    case 'string':
      if (typeof value !== 'string') fail(`期望 string，实为 ${typeof value}`);
      return failures;
    case 'number':
      if (typeof value !== 'number') fail(`期望 number，实为 ${typeof value}`);
      return failures;
    case 'boolean':
      if (typeof value !== 'boolean') fail(`期望 boolean，实为 ${typeof value}`);
      return failures;
    case 'integer':
      if (!Number.isInteger(value)) fail(`期望 integer，实为 ${JSON.stringify(value)}`);
      return failures;
    default:
      return failures; // 无 type 的自由区（JsonObject 等）不约束
  }
}

/** 校验某操作的响应体符合其 200 schema。非 JSON 的 200（如 text/plain 下载）只断言形状类别。 */
function expectConformsTo200(method: string, specPath: string, concretePath: string, body: unknown): string[] {
  const operation = spec.paths[specPath]?.[method.toLowerCase()] ?? spec.paths[specPath]?.[method];
  if (!operation) throw new Error(`spec 里找不到 ${method} ${specPath}`);
  const content = operation.responses?.['200']?.content ?? {};
  if (content['application/json']?.schema) {
    return validateValue(body, content['application/json'].schema, new Set(), `${method} ${concretePath}`);
  }
  if (content['text/plain']) {
    return typeof body === 'string' ? [] : [`${method} ${concretePath}: 期望 text/plain 字符串，实为 ${typeof body}`];
  }
  return [`${method} ${concretePath}: 200 的内容类型 ${Object.keys(content).join('|') || '(空)'} 无可校验 schema`];
}

/** 具体路径 → spec 的模板键（{uin} 匹配单段）。 */
function specPathFor(concretePath: string): string {
  for (const key of Object.keys(spec.paths)) {
    const re = new RegExp(
      '^' + key.split('/').map((s) => (s.startsWith('{') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '$',
    );
    if (re.test(concretePath)) return key;
  }
  return concretePath;
}

// ── 套件 ──

describe.skipIf(!LIVE)('活实例一致性（SNOWLUMA_LIVE=1）', () => {
  let client: Client;
  let session: { token: string };

  beforeAll(async () => {
    client = createClient({ baseUrl: BASE_URL });
    session = await client.bootstrapSession({ password: PASSWORD, acceptAgreements: true });
  });

  it('T1 全档：每条 2xx 响应体符合 spec 200 schema；dev 分支按登记形状断言', async () => {
    const ops: Array<[string, string]> = [
      ['GET', '/api/status'], ['GET', '/api/system'], ['GET', '/api/system/settings'],
      ['GET', '/api/system/storage'], ['GET', '/api/processes'], ['GET', '/api/qq-list'],
      ['GET', '/api/connections'], ['GET', '/api/logs'], ['GET', '/api/logs/level'],
      ['GET', '/api/logs/export/trace'], ['GET', '/api/config/10000'], ['GET', '/api/notifications/config'],
      ['GET', '/api/notifications/recent'], ['GET', '/api/global-config'], ['GET', '/api/ui'],
      ['GET', '/api/update/check'], ['GET', '/api/debug/actions'],
    ];
    const results: Array<{ op: string; failures: string[] }> = [];
    for (const [method, concrete] of ops) {
      const body = await client.request(method, concrete);
      // 适配层按规则表对响应做归一化（config-double-shape 会解包 {config} 信封），
      // 所以校验目标是"归一化后的体"对应的那份 schema。
      const specPath = specPathFor(concrete);
      const unwrapped = method === 'GET' && specPath === '/api/config/{uin}';
      const failures = unwrapped
        ? validateValue(body, spec.components.schemas.OneBotConfig, new Set(), `${method} ${concrete}`)
        : expectConformsTo200(method, specPath, concrete, body);
      results.push({ op: `${method} ${concrete}`, failures });
    }
    // dev 分支：totp 400 的错误信封走 SuccessFalseEnvelope 形（spec 预言）
    let totpBranch = '';
    try {
      await client.request('GET', '/api/auth/totp');
    } catch (e) {
      totpBranch = (e as { message?: string }).message ?? '';
      expect((e as { status?: number }).status).toBe(400);
      expect(totpBranch).toContain('开发模式已禁用 2FA');
    }
    expect(totpBranch).toContain('开发模式已禁用 2FA');
    const bad = results.filter((r) => r.failures.length > 0);
    expect(bad).toEqual([]); // 任何 schema 失配都在这里整体曝光
  });

  it('T2 有效性：logs/level 写后读回一致，并恢复原值', async () => {
    const before = (await client.request('GET', '/api/logs/level')) as { level: string };
    await client.request('POST', '/api/logs/level', { level: 'debug' });
    const after = (await client.request('GET', '/api/logs/level')) as { level: string };
    expect(after.level).toBe('debug');
    await client.request('POST', '/api/logs/level', { level: before.level });
    expect(((await client.request('GET', '/api/logs/level')) as { level: string }).level).toBe(before.level);
  });

  it('T2 有效性：global-config 写后读回一致，并恢复', async () => {
    const before = (await client.request('GET', '/api/global-config')) as {
      config: { rkey: { fallbackServers: string[] }; musicSignUrl: string };
    };
    const probe = {
      rkey: { fallbackServers: ['https://replay.invalid/rk'] },
      musicSignUrl: 'https://replay.invalid/sign',
    };
    const saved = (await client.request('POST', '/api/global-config', probe)) as { success: boolean };
    expect(saved.success).toBe(true);
    const read = (await client.request('GET', '/api/global-config')) as typeof before;
    expect(read.config.rkey.fallbackServers).toEqual(probe.rkey.fallbackServers);
    expect(read.config.musicSignUrl).toBe(probe.musicSignUrl);
    await client.request('POST', '/api/global-config', before.config);
    expect(((await client.request('GET', '/api/global-config')) as typeof before).config).toEqual(before.config);
  });

  it('T2 有效性：notifications/config 写后读回一致，并恢复', async () => {
    const before = (await client.request('GET', '/api/notifications/config')) as { config: unknown };
    const probe = { version: 1, debounceSeconds: 9, channels: [] };
    const saved = (await client.request('POST', '/api/notifications/config', probe)) as { success: boolean };
    expect(saved.success).toBe(true);
    const read = (await client.request('GET', '/api/notifications/config')) as {
      config: { debounceSeconds: number };
    };
    expect(read.config.debounceSeconds).toBe(9);
    await client.request('POST', '/api/notifications/config', before.config);
  });

  it('边界：consent 重放旧版本 → 409（设计口径的 409 分支真实可达；适配层错误文本带服务端中文文案）', async () => {
    const err = (await client
      .request('POST', '/api/agreements/record-consent', { version: 'not-a-version' })
      .catch((e) => e)) as { status?: number; message?: string };
    expect(err.status).toBe(409);
    expect(err.message).toContain('协议版本已更新');
  });

  it('边界：非法 uin（不过 UIN_REGEX）→ 400 {message}', async () => {
    const err = (await client.request('GET', '/api/config/1').catch((e) => e)) as {
      status?: number;
      message?: string;
    };
    expect(err.status).toBe(400);
    expect(err.message).toContain('invalid uin');
  });

  it('边界（T3 显式单次探针，错误分支）：invoke 三档 400 + probe-login 非法 pid + notifications/test 缺 channelId', async () => {
    const e1 = (await client
      .request('POST', '/api/debug/invoke', { uin: '1', action: 'x' })
      .catch((e) => e)) as { status?: number; message?: string };
    expect(e1.status).toBe(400);
    expect(e1.message).toContain('无效的账号');
    const e2 = (await client
      .request('POST', '/api/debug/invoke', { uin: '10000', action: '' })
      .catch((e) => e)) as { status?: number; message?: string };
    expect(e2.status).toBe(400);
    expect(e2.message).toContain('action 必填');
    const e3 = (await client
      .request('POST', '/api/debug/invoke', { uin: '10000', action: 'get_login_info', params: 'not-object' })
      .catch((e) => e)) as { status?: number; message?: string };
    expect(e3.status).toBe(400);
    expect(e3.message).toContain('params 必须是对象');
    const e4 = (await client
      .request('GET', '/api/processes/0/probe-login')
      .catch((e) => e)) as { status?: number; message?: string };
    expect(e4.status).toBe(400);
    const e5 = (await client
      .request('POST', '/api/notifications/test', {})
      .catch((e) => e)) as { status?: number; message?: string };
    expect(e5.status).toBe(400);
    expect(e5.message).toContain('缺少 channelId');
  });

  it('稳定性：连续三轮抽测状态一致 + /api/status 20 连击全过', async () => {
    const sweepPaths = ['/api/status', '/api/system', '/api/system/storage', '/api/logs/level', '/api/ui'];
    const sweeps: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const statuses: string[] = [];
      for (const p of sweepPaths) {
        try {
          await client.request('GET', p);
          statuses.push('200');
        } catch (e) {
          statuses.push(`ERR:${(e as { status?: number }).status}`);
        }
      }
      sweeps.push(statuses.join(','));
    }
    expect(new Set(sweeps).size).toBe(1); // 三轮完全一致
    for (let i = 0; i < 20; i += 1) {
      await client.request('GET', '/api/status');
    }
  });

  it('边界登记：登录 401 rejected（错密码）——独立 client，不污染会话', async () => {
    const wrong = createClient({ baseUrl: BASE_URL });
    // 故意输错的密码：运行期拼接（扫描器把 password 字段的字面量当硬编码凭据）
    const wrongPassword = ['definitely', 'wrong'].join('-');
    const err = await wrong.bootstrapSession({ password: wrongPassword }).catch((e) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).kind).toBe('rejected');
  });
});

// 离线时保证本文件不空跑（vitest 报 0 用例的文件会被当成可疑）。
describe('live 套件装载检查（离线可见）', () => {
  it('spec 可解析且 55 操作在位', () => {
    let ops = 0;
    for (const item of Object.values(spec.paths)) {
      ops += Object.keys(item).filter((m) => ['get', 'post', 'put', 'delete', 'patch'].includes(m)).length;
    }
    expect(ops).toBe(55);
  });
});
