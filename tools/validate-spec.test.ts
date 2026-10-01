// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { validateSpecDoc } from './validate-spec.js';
import { SIDE_EFFECT_LABELS } from './lib/tiers.js';
import { localPathFor } from './lib/upstream.js';
import {
  deriveSpecGuards,
  loadSpecGuardsSync,
  SERVER_TS_REPO_PATH,
  type SpecGuards,
} from './lib/upstream-guards.js';

const load = (name: string) => readFile(`spec/fixtures/${name}.yaml`, 'utf8').then(parse);

// guards 缺省 = 从真实锚定缓存派生（validateSpecDoc 的默认值）；传入了就走注入的那套
// （突变副本），规则对两套值完全同构。
const codes = (doc: unknown, guards?: SpecGuards) => validateSpecDoc(doc, guards).map((i) => i.code);

const okOp = { operationId: 'l', 'x-replay-class': 't1', 'x-verification-status': 'verified', responses: {} };

// 设计口径的合规认证形状：全局 security + http/bearer scheme
const AUTH = {
  security: [{ bearer: [] }],
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
};

// 除被断言的那一处缺陷外，base() 生成的文档对全部规则合规，
// 于是"沉默"能直接写成 toEqual([]) 而不是排除个别码。
const base = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  openapi: '3.0.3',
  info: { title: 'fixture', version: '0.0.0' },
  paths,
  ...AUTH,
  ...extra,
});

const UIN_SCHEMA = {
  name: 'uin',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^[0-9]{5,10}$' },
};

describe('validateSpecDoc', () => {
  it('合规则本零 error', async () => {
    expect(validateSpecDoc(await load('minimal-valid')).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('openapi 版本必须是 3.0.3', () => {
    const doc = { openapi: '3.1.0', info: {}, paths: {} };
    expect(codes(doc)).toContain('VERSION_NOT_3_0_3');
  });

  it('缺 x-replay-class 报 MISSING_REPLAY_CLASS', async () => {
    expect(codes(await load('missing-tier'))).toContain('MISSING_REPLAY_CLASS');
    // 同一份夹具缺两轴标签：MISSING_VERIFICATION_STATUS 由它一起点亮，不再另造夹具。
    expect(codes(await load('missing-tier'))).toContain('MISSING_VERIFICATION_STATUS');
  });

  it('OpenAPI 3.0 内出现 const 报 CONST_IN_OPENAPI_3_0', async () => {
    expect(codes(await load('const-forbidden'))).toContain('CONST_IN_OPENAPI_3_0');
  });

  it('T3 的验证状态不得是 verified', () => {
    const doc = {
      openapi: '3.0.3',
      info: {},
      paths: {
        '/api/x': { post: { operationId: 'x', 'x-replay-class': 't3', 'x-verification-status': 'verified', responses: {} } },
      },
    };
    expect(codes(doc)).toContain('T3_STATUS_MUST_NOT_BE_VERIFIED');
  });

  it('未归类操作报 UNCLASSIFIED_OP（清单与 spec 分叉）', () => {
    const doc = {
      openapi: '3.0.3',
      info: {},
      paths: { '/api/nope': { get: { operationId: 'nope', 'x-replay-class': 't1', 'x-verification-status': 'verified', responses: {} } } },
    };
    expect(codes(doc)).toContain('UNCLASSIFIED_OP');
  });

  it('档级与 tiers.ts 真源不符时报 TIER_MISMATCH', () => {
    const doc = {
      openapi: '3.0.3',
      info: {},
      paths: { '/api/logs': { get: { operationId: 'l', 'x-replay-class': 't3', 'x-verification-status': 'static-only', responses: {} } } },
    };
    expect(codes(doc)).toContain('TIER_MISMATCH');
  });

  it('/api/debug/invoke* 必须标 x-snowluma-destructive', () => {
    const doc = {
      openapi: '3.0.3',
      info: {},
      paths: { '/api/debug/invoke': { post: { operationId: 'i', 'x-replay-class': 't3', 'x-verification-status': 'destructive-static-only', responses: {} } } },
    };
    expect(codes(doc)).toContain('MISSING_DESTRUCTIVE_FLAG');
  });

  it('仅 login 与 ui/public 可免 security', () => {
    const doc = {
      openapi: '3.0.3',
      info: {},
      paths: { '/api/system': { get: { operationId: 's', security: [], 'x-replay-class': 't1', 'x-verification-status': 'verified', responses: {} } } },
    };
    expect(codes(doc)).toContain('UNEXPECTED_ANONYMOUS_OP');
  });

  it('operationId 重复报 DUPLICATE_OPERATION_ID', () => {
    const op = { operationId: 'dup', 'x-replay-class': 't1', 'x-verification-status': 'verified', responses: {} };
    expect(codes({ openapi: '3.0.3', info: {}, paths: { '/api/logs': { get: op }, '/api/status': { get: { ...op } } } })).toContain(
      'DUPLICATE_OPERATION_ID',
    );
  });

  it('$ref 指向不存在的 schema 报 DANGLING_REF', () => {
    const doc = {
      openapi: '3.0.3',
      info: {},
      paths: { '/api/logs': { get: { operationId: 'l', 'x-replay-class': 't1', 'x-verification-status': 'verified', responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Nope' } } } } } } } },
      components: { schemas: {} },
    };
    expect(codes(doc)).toContain('DANGLING_REF');
  });
});

// —— 关卡清单补全（首轮评审抓出的"规则名存在、实现只做一半"）——

describe('结构底关 MISSING_PATHS / MISSING_INFO', () => {
  const info = { title: 'fixture', version: '0.0.0' };

  it('paths 缺失 / 非对象 / 为空都报 MISSING_PATHS', () => {
    expect(codes({ openapi: '3.0.3', info })).toContain('MISSING_PATHS');
    expect(codes({ openapi: '3.0.3', info, paths: {} })).toContain('MISSING_PATHS');
    expect(codes({ openapi: '3.0.3', info, paths: ['/api/logs'] })).toContain('MISSING_PATHS');
    // 顶层键名手误成 endpoints: 时 paths 仍缺失，不会带着零信号走到生成器
    expect(codes({ openapi: '3.0.3', info, endpoints: { '/api/logs': { get: okOp } } })).toContain('MISSING_PATHS');
  });

  it('info.title / info.version 缺失报 MISSING_INFO', () => {
    const doc = base({ '/api/logs': { get: { ...okOp } } }, { info: {} });
    expect(codes(doc)).toContain('MISSING_INFO');
    expect(codes(base({ '/api/logs': { get: { ...okOp } } }, { info: { title: 't' } }))).toContain('MISSING_INFO');
    expect(codes(base({ '/api/logs': { get: { ...okOp } } }, { info: { version: '1.0.0' } }))).toContain('MISSING_INFO');
  });

  it('合规范本（fixture）对全部规则沉默：零 issue 而非仅零 error', async () => {
    expect(validateSpecDoc(await load('minimal-valid'))).toEqual([]);
    expect(codes(base({ '/api/logs': { get: { ...okOp } } }))).toEqual([]);
  });
});

describe('裁定 R19：{uin} 与 :uin 的形式归一', () => {
  it('spec 用 OpenAPI 的 {uin} 且档级标错时报 TIER_MISMATCH 而不是 UNCLASSIFIED_OP', () => {
    const doc = base({
      '/api/config/{uin}': {
        parameters: [{ ...UIN_SCHEMA }],
        get: { operationId: 'getConfig', 'x-replay-class': 't3', 'x-verification-status': 'static-only', responses: {} },
      },
    });
    const got = codes(doc);
    expect(got).toContain('TIER_MISMATCH');
    expect(got).not.toContain('UNCLASSIFIED_OP');
  });

  it('spec 用 {uin} 且档级正确时沉默', () => {
    const doc = base({
      '/api/config/{uin}': {
        parameters: [{ ...UIN_SCHEMA }],
        get: { operationId: 'getConfig', 'x-replay-class': 't1', 'x-verification-status': 'unverified-requires-qq', responses: {} },
      },
    });
    expect(codes(doc)).toEqual([]);
  });
});

// 裁定 R19 的**执法点**（终审 I3a）。此前 R19 只落地了"比较前归一化"，而
// normalizeParamForm(':uin') 是**恒等映射**——于是一份全部用 Express 风格写的 55 操作 spec
// 会以 0 error 通过校验，而三家生成器都把 `:uin` 当字面量段（客户端批次会把整份 spec 喂给它们）。
// 更糟的推论见 tools/check-drift.test.ts：两种形式同时存在时会被折叠成同一个键，互相抵消成零漂移。
describe('裁定 R19 的书写关：paths 键不得用 Express 的 :x', () => {
  it('Express 风格的 :uin 键报 EXPRESS_PATH_PARAM，并指名是哪条路径', () => {
    const doc = base({ '/api/config/:uin': { get: { ...okOp, operationId: 'getConfig' } } });
    const issue = validateSpecDoc(doc).find((i) => i.code === 'EXPRESS_PATH_PARAM');
    expect(issue?.message).toContain('/api/config/:uin');
    expect(issue?.level).toBe('error');
  });

  it('多条 :x 键逐条报出（一份写歪的 spec 不能只提示一次就完）', () => {
    const doc = base({
      '/api/config/:uin': { get: { ...okOp, operationId: 'a' } },
      '/api/processes/:pid/load': { post: { ...okOp, operationId: 'b', 'x-replay-class': 't3', 'x-verification-status': 'static-only' } },
    });
    expect(codes(doc).filter((c) => c === 'EXPRESS_PATH_PARAM')).toHaveLength(2);
  });

  it('{uin} 形式与无参路径保持沉默（对正确书写开火的规则会被下一条计划忽略）', () => {
    expect(
      codes(base({ '/api/config/{uin}': { parameters: [{ ...UIN_SCHEMA }], get: { ...okOp, operationId: 'getConfig' } } })),
    ).toEqual([]);
    expect(codes(base({ '/api/logs': { get: { ...okOp } } }))).toEqual([]);
  });

  it('合规范本 fixture 不受该规则影响', async () => {
    expect(codes(await load('minimal-valid'))).not.toContain('EXPRESS_PATH_PARAM');
  });

  it('推论：{uin} 与 :uin 同时存在的 spec 由本规则判死，不再可能伪装成零漂移', () => {
    const doc = base({
      '/api/config/{uin}': { parameters: [{ ...UIN_SCHEMA }], get: { ...okOp, operationId: 'a' } },
      '/api/config/:uin': { get: { ...okOp, operationId: 'b' } },
    });
    expect(codes(doc)).toContain('EXPRESS_PATH_PARAM');
  });
});

describe('$ref 通用本地 JSON pointer 解析', () => {
  const docWith = (ref: string) =>
    base(
      { '/api/logs': { get: { ...okOp, responses: {
        '200': { description: 'ok', content: { 'application/json': { schema: { $ref: ref } } } },
        // 恒带一条真正引用 Ok 的 401：UNREFERENCED_SCHEMA（终审 W1）按"有没有人 $ref"定罪，
        // 本用例的被测点是 pointer 解析而不是引用图——不让无关的 200 目标把 Ok 变成孤儿。
        '401': { description: 'gate', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } } },
      } } } },
      { components: { ...AUTH.components, schemas: { Ok: { type: 'object' } }, parameters: { Uin: { ...UIN_SCHEMA } } } },
    );

  it('components/schemas 之外的本地形状同样解析：不可解析即 DANGLING_REF', () => {
    expect(codes(docWith('#/components/parameters/Nope'))).toContain('DANGLING_REF');
    expect(codes(docWith('#/components/responses/Nope'))).toContain('DANGLING_REF');
    expect(codes(docWith('#/paths/~1api~1nope'))).toContain('DANGLING_REF');
    expect(codes(docWith('#/components/schemas/Nope/properties/x'))).toContain('DANGLING_REF');
  });

  it('可解析的本地 pointer（含 ~1 转义与深层路径）保持沉默', () => {
    expect(codes(docWith('#/components/schemas/Ok'))).toEqual([]);
    expect(codes(docWith('#/components/parameters/Uin'))).toEqual([]);
    expect(codes(docWith('#/paths/~1api~1logs/get'))).toEqual([]);
  });

  it('discriminator.mapping 的字符串目标也是引用，一并解析', () => {
    const withMapping = (target: string) =>
      base({ '/api/logs': { get: { ...okOp } } }, {
        components: {
          ...AUTH.components,
          schemas: {
            Ok: { type: 'object' },
            LoginResult: {
              oneOf: [{ $ref: '#/components/schemas/Ok' }],
              discriminator: { propertyName: 'success', mapping: { 'true': target } },
            },
          },
        },
      });
    // 断言从 toEqual([]) 改为 not.toContain('DANGLING_REF')：裁定 R22 之后带 discriminator 的
    // 文档必然另有一条 DISCRIMINATOR_FORBIDDEN（下面单独钉），这里要钉的属性只是
    // "mapping 的字符串目标确实被当成引用解析了"。
    expect(codes(withMapping('#/components/schemas/Nope'))).toContain('DANGLING_REF');
    expect(codes(withMapping('#/components/schemas/Ok'))).not.toContain('DANGLING_REF');
  });

  it('非 # 开头的外部 $ref 跳过而非报错（不联网不读盘，真实性由生成器验证）', () => {
    const got = codes(docWith('https://example.com/other.yaml#/components/schemas/Foo'));
    expect(got).not.toContain('DANGLING_REF');
  });
});

describe('security 合法性而非仅存在性', () => {
  it('security 引用 components.securitySchemes 里不存在的键报 UNKNOWN_SECURITY_SCHEME', () => {
    expect(codes(base({ '/api/logs': { get: { ...okOp, security: [{ nope: [] }] } } }))).toContain('UNKNOWN_SECURITY_SCHEME');
    expect(codes(base({ '/api/logs': { get: { ...okOp } } }, { security: [{ nope: [] }] }))).toContain('UNKNOWN_SECURITY_SCHEME');
  });

  it('scheme 不是 http/bearer（如 apiKey）报 BAD_SECURITY_SCHEME_TYPE', () => {
    const doc = base({ '/api/logs': { get: { ...okOp } } }, {
      components: { securitySchemes: { keyAuth: { type: 'apiKey', in: 'header', name: 'X-Key' } } },
    });
    expect(codes(doc)).toContain('BAD_SECURITY_SCHEME_TYPE');
    // type 对了但 scheme 没钉 bearer 同样不合规
    expect(
      codes(base({ '/api/logs': { get: { ...okOp } } }, { components: { securitySchemes: { basic: { type: 'http', scheme: 'basic' } } } })),
    ).toContain('BAD_SECURITY_SCHEME_TYPE');
  });

  it('匿名白名单仍允许 security: []，且合规 scheme 不报错', () => {
    expect(
      codes(base({ '/api/login': { post: { ...okOp, operationId: 'login', 'x-replay-class': 't2', security: [] } } })),
    ).toEqual([]);
    expect(codes(base({ '/api/ui/public': { get: { ...okOp, operationId: 'getPublic', security: [] } } }))).toEqual([]);
    expect(codes(base({ '/api/logs': { get: { ...okOp, security: [{ bearer: [] }] } } }))).toEqual([]);
  });
});

describe('uin 参数模式（设计口径硬规则）', () => {
  const uinPath = (parameters: unknown[]) =>
    base({ '/api/config/{uin}': { parameters, get: { ...okOp, operationId: 'getConfig' } } });

  it('缺 uin path parameter 或 pattern 不符报 UIN_PATTERN', () => {
    expect(codes(uinPath([]))).toContain('UIN_PATTERN');
    expect(codes(uinPath([{ name: 'uin', in: 'path', schema: { type: 'string' } }]))).toContain('UIN_PATTERN');
    expect(codes(uinPath([{ ...UIN_SCHEMA, schema: { type: 'string', pattern: '^[0-9]+$' } }]))).toContain('UIN_PATTERN');
    expect(codes(uinPath([{ name: 'uin', in: 'query', schema: { type: 'string', pattern: '^[0-9]{5,10}$' } }]))).toContain('UIN_PATTERN');
  });

  it('operation 级与 $ref 引入的 parameter 都算声明了 pattern', () => {
    expect(codes(uinPath([{ ...UIN_SCHEMA }]))).toEqual([]);
    expect(
      codes(base({ '/api/config/{uin}': { get: { ...okOp, operationId: 'getConfig', parameters: [{ ...UIN_SCHEMA }] } } })),
    ).toEqual([]);
    expect(
      codes(
        base({ '/api/config/{uin}': { parameters: [{ $ref: '#/components/parameters/Uin' }], get: { ...okOp, operationId: 'getConfig' } } }, {
          components: { ...AUTH.components, parameters: { Uin: { ...UIN_SCHEMA } } },
        }),
      ),
    ).toEqual([]);
  });

  it('不含 uin 的路径不受该规则影响', () => {
    expect(codes(base({ '/api/logs': { get: { ...okOp } } }))).not.toContain('UIN_PATTERN');
  });

  // 终审 M2：OpenAPI 的参数优先级是 **operation 覆盖 path item**（同 name + 同 in 者胜）。
  // parametersOf 原先把 path-item 级排在前面而调用方用 .find() 取第一个 ⇒ 方向反了：
  // 路径级写对、操作级写错时规则**静默放行**，而这正是客户端批次会批量产出的形状
  // （spec/fixtures/minimal-valid.yaml 用的是路径级 $ref 形式，逐操作再挂覆盖参数）。
  const NO_PATTERN_UIN = { name: 'uin', in: 'path', required: true, schema: { type: 'string' } };

  it('路径级合规 + 操作级覆盖成无 pattern：必须报 UIN_PATTERN（旧顺序在此静默）', () => {
    const doc = base({
      '/api/config/{uin}': {
        parameters: [{ ...UIN_SCHEMA }],
        get: { ...okOp, operationId: 'getConfig', parameters: [NO_PATTERN_UIN] },
      },
    });
    expect(codes(doc)).toContain('UIN_PATTERN');
  });

  it('反方向：操作级合规 + 路径级无 pattern → 沉默（否则就是对合规 spec 开火）', () => {
    const doc = base({
      '/api/config/{uin}': {
        parameters: [NO_PATTERN_UIN],
        get: { ...okOp, operationId: 'getConfig', parameters: [{ ...UIN_SCHEMA }] },
      },
    });
    expect(codes(doc)).toEqual([]);
  });

  it('两侧都有 pattern 但只有路径级正确时仍沉默（覆盖项不存在才回落到 path item）', () => {
    const doc = base({
      '/api/config/{uin}': {
        parameters: [{ ...UIN_SCHEMA }],
        get: { ...okOp, operationId: 'getConfig', parameters: [{ name: 'limit', in: 'query', schema: { type: 'number' } }] },
      },
    });
    expect(codes(doc)).toEqual([]);
  });
});

describe('裁定 R20：x-snowluma-destructive 必标集', () => {
  it('其余 T3 操作不标也不报错，只有 invoke 与 invoke-stream 强制', () => {
    const doc = base({
      '/api/debug/upload': { post: { operationId: 'up', 'x-replay-class': 't3', 'x-verification-status': 'destructive-static-only', responses: {} } },
      '/api/system/backup/import': { post: { operationId: 'imp', 'x-replay-class': 't3', 'x-verification-status': 'destructive-static-only', responses: {} } },
    });
    expect(codes(doc)).toEqual([]);
  });
});

// 裁定 R22：留在 OpenAPI 3.0.3，且**全项目不写 discriminator**。
// spike 预研实测三家生成器对它的反应全部否定（spike/findings.md Q1：TS 把 tag 收成 never、
// Python 静默选错支、Go 产出字符串 tag）。规则此前只活在文档里——校验器扫到 discriminator
// 只为收 $ref，从不判错（终审 I3b）。退路是设计口径/设计口径的 `oneOf` + 各分支 `enum: [单值]`。
describe('裁定 R22：spec 内禁写 discriminator', () => {
  const withDisc = (where: Record<string, unknown>) =>
    base({ '/api/logs': { get: { ...okOp } } }, {
      components: { ...AUTH.components, schemas: { LoginResult: where } },
    });

  it('components.schemas 里出现 discriminator 对象 → DISCRIMINATOR_FORBIDDEN（error）', () => {
    const issue = validateSpecDoc(
      withDisc({ oneOf: [], discriminator: { propertyName: 'success' } }),
    ).find((i) => i.code === 'DISCRIMINATOR_FORBIDDEN');
    expect(issue?.level).toBe('error');
    expect(issue?.message).toContain('spec.components.schemas.LoginResult.discriminator');
  });

  it('嵌套在 operation 响应里同样报出（不只 components 一处）', () => {
    const doc = base({
      '/api/login': {
        post: {
          ...okOp,
          operationId: 'login',
          'x-replay-class': 't2',
          security: [],
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { oneOf: [], discriminator: { propertyName: 'ok' } } } },
            },
          },
        },
      },
    });
    const issue = validateSpecDoc(doc).find((i) => i.code === 'DISCRIMINATOR_FORBIDDEN');
    expect(issue?.message).toContain('discriminator');
  });

  it('带 mapping 的完整形态也判错，且仍照常解析 mapping 里的 $ref（两条规则同时命中是诚实的）', () => {
    const got = codes(
      withDisc({
        oneOf: [{ $ref: '#/components/schemas/Nope' }],
        discriminator: { propertyName: 'success', mapping: { 'true': '#/components/schemas/Nope' } },
      }),
    );
    expect(got).toContain('DISCRIMINATOR_FORBIDDEN');
    expect(got).toContain('DANGLING_REF');
  });

  it('名为 discriminator 的数据字段不是 Discriminator Object，不得误伤', () => {
    // 判据用 3.0.3 的必填属性 propertyName 区分：字段声明是 {type: …} 而没有 propertyName。
    // 不加这条例外的话，规则会对"上游真有一个叫 discriminator 的字段"这种合规 spec 开火，
    // 而一条会误伤的规则在下一条计划里就会被整个跳过。
    expect(
      codes(
        base({ '/api/logs': { get: { ...okOp, responses: {
          // 真引用一次 Row：终审 W1 后"components.schemas 里躺着没人 $ref"本身就是 error，
          // 本用例要测的是 discriminator **字段**不误伤，不是孤儿规则豁免。
          '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Row' } } } },
        } } } }, {
          components: {
            ...AUTH.components,
            schemas: { Row: { type: 'object', properties: { discriminator: { type: 'string' } } } },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('不写 discriminator 的文档保持沉默——含 R22 的退路形状（oneOf + enum:[单值]）', async () => {
    expect(codes(await load('minimal-valid'))).not.toContain('DISCRIMINATOR_FORBIDDEN');
    expect(
      codes(
        base({ '/api/logs': { get: { ...okOp, responses: {
          // 200 真引用 LoginResult：孤儿规则（终审 W1）之后"定义在 components 却没人 $ref"
          // 与 spec 撒谎同罪；R22 退路形状本来就是要作为**可发布的响应形状**过关。
          '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResult' } } } },
        } } } }, {
          components: {
            ...AUTH.components,
            schemas: {
              // required: [success] 不是装饰：两支都缺 required 时 {} 同时满足两支，
              // 会被裁定 R24 的 ONEOF_BRANCH_OVERLAP 正当报红（真实 LoginResult 两支都钉了
              // required tag，见 spec/fixtures/login-union.yaml）。退路形状要连 union 关一起过。
              LoginSuccess: { type: 'object', required: ['success'], properties: { success: { type: 'boolean', enum: [true] } } },
              LoginNeedsTotp: { type: 'object', required: ['success'], properties: { success: { type: 'boolean', enum: [false] } } },
              LoginResult: {
                oneOf: [{ $ref: '#/components/schemas/LoginSuccess' }, { $ref: '#/components/schemas/LoginNeedsTotp' }],
              },
            },
          },
        }),
      ),
    ).toEqual([]);
  });

  // spec/fixtures/login-union.yaml 此前没有任何执行入口：`npm run validate` 只加载
  // spec/openapi.yaml（package.json 的 validate 脚本），本文件的 load(...) 用例又各自只
  // 点名的三个 fixture 各验一次。fixture 若被改坏（union 形状或校验器一方变动）会全程
  // 绿灯——正是本项目点名的"存在但咬不动的守卫"。的 Go 包装按这份形状手写，
  // 所以这条把它钉进测试套件：全量 issue 为空（零 error 且零 warning），与上面
  // minimal-valid 的 toEqual([]) 同形——那是本文件可用的最强断言形式。
  // 不改成"遍历 spec/fixtures/ 全部文件"的通用用例：目录里还有两个**应当**报错的
  // 负面 fixture（missing-tier / const-forbidden），通用化要么豁免名单要么挪文件，
  // 属于为一条断言新建框架。
  it('R22 回归 fixture login-union.yaml 整体干净：零 error 且零 warning', async () => {
    expect(validateSpecDoc(await load('login-union'))).toEqual([]);
  });

  // 与 login-union 同一族：fixture 存在 ≠ 守卫咬得动。这条规则的执法对象恰好是
  // "看起来无害的两支都开放的 union"，最容易在后续任务里被无意识地写出来，
  // 所以负面 fixture 与它的红必须成对进仓库。
  it('ONEOF_BRANCH_OVERLAP 咬得住：两支都开放的负面 fixture 必须红，且报出带 rules 的 witness', async () => {
    const issues = validateSpecDoc(await load('overlapping-oneof'));
    const hit = issues.filter((i) => i.code === 'ONEOF_BRANCH_OVERLAP');
    expect(hit).toHaveLength(1);
    expect(hit[0].level).toBe('error');
    expect(hit[0].message).toContain('"rules"'); // witness 里带上 rules 才是那条真实响应
  });
});

// 设计口径把 x-snowluma-side-effects 的取值绑在扫描器的七个标签上（终审 I3c）。
// 词表真源搬到 tools/lib/tiers.ts 后，这里补上"声明侧"的执法点：安全后果是设计口径的
// "GET 携带 external-fetch 永不自动重放"骑在这个字符串上，拼错即静默失效。
describe('设计口径：x-snowluma-side-effects 取值必须落在扫描器词表内', () => {
  const opWith = (value: unknown) =>
    base({
      '/api/update/check': {
        get: { ...okOp, operationId: 'checkUpdate', 'x-snowluma-side-effects': value },
      },
    });

  it('词表外的标签（少一个连字符的 external_request）报 UNKNOWN_SIDE_EFFECT_LABEL 并指名位置', () => {
    const issue = validateSpecDoc(opWith(['external_request'])).find(
      (i) => i.code === 'UNKNOWN_SIDE_EFFECT_LABEL',
    );
    expect(issue?.level).toBe('error');
    expect(issue?.message).toContain('external_request');
    expect(issue?.message).toContain('/api/update/check');
  });

  it('非字符串元素同样判词表外；一个数组里的多个错值逐个报出', () => {
    const got = codes(opWith(['presist', 'cookie', 42, ['nested']]));
    expect(got.filter((c) => c === 'UNKNOWN_SIDE_EFFECT_LABEL')).toHaveLength(3);
  });

  it('写成裸字符串（不是数组）报 BAD_SIDE_EFFECT_DECL——设计口径那样的数组消费会静默漏掉它', () => {
    expect(codes(opWith('external-fetch'))).toContain('BAD_SIDE_EFFECT_DECL');
  });

  it('词表内取值与显式空数组保持沉默（合规 spec 不得被自己的安全标签规则咬）', () => {
    for (const label of SIDE_EFFECT_LABELS) expect(codes(opWith([label]))).toEqual([]);
    expect(codes(opWith([]))).toEqual([]);
  });

  it('不声明该扩展的文档完全不受影响；合规范本 fixture 仍零 issue', async () => {
    expect(codes(base({ '/api/logs': { get: { ...okOp } } }))).toEqual([]);
    expect(codes(await load('minimal-valid'))).not.toContain('UNKNOWN_SIDE_EFFECT_LABEL');
  });

  it('path item 级与 components 里的声明也在射程内（规则按文档全档扫描，不按 operation 位置）', () => {
    expect(
      codes(base({ '/api/logs': { parameters: [{ name: 'limit', in: 'query', 'x-snowluma-side-effects': ['send'] }], get: { ...okOp } } })),
    ).toContain('UNKNOWN_SIDE_EFFECT_LABEL');
  });
});

describe('校验器自身健壮性', () => {
  it('循环引用的 YAML 锚点产出一条 issue 而不是 RangeError', () => {
    const doc = parse(
      'openapi: 3.0.3\ninfo: { title: fixture, version: "0.0.0" }\npaths: {}\n' +
        'components:\n  securitySchemes:\n    bearer: { type: http, scheme: bearer }\n' +
        'x-cycle: &anc\n  self: *anc\n',
    );
    expect(() => validateSpecDoc(doc)).not.toThrow();
    expect(codes(doc)).toContain('CYCLIC_DOCUMENT');
    // 同一循环体被多处引用也只报一次
    expect(codes(doc).filter((c) => c === 'CYCLIC_DOCUMENT')).toHaveLength(1);
  });

  it('无循环的合规文档不会被该规则误伤', async () => {
    expect(codes(await load('minimal-valid'))).not.toContain('CYCLIC_DOCUMENT');
  });
});

// 终审 W1（修复波）：OperationError 是全档唯一零 $ref 的 components.schemas 条目，
// 却被三家生成器导出（generated/typescript/index.ts），而它的全部"证据"是
// client.ts:39 的防御性读取（设计口径禁止当契约证据）。当时的校验器对这种形状 0 error。
// 这条结构规则与 DANGLING_REF 成对：出边必须有目标，入边也不许为零。
describe('终审 W1：零 $ref 的 components.schemas 条目报 UNREFERENCED_SCHEMA', () => {
  const doc = (schemas: Record<string, unknown>, target: string) =>
    base({ '/api/logs': { get: { ...okOp, responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: target } } } } } } } },
      { components: { ...AUTH.components, schemas } });

  it('被引用的沉默、零引用的报错且消息点名两种修法', () => {
    const used = doc({ Ok: { type: 'object' } }, '#/components/schemas/Ok');
    expect(codes(used)).toEqual([]);
    const orphan = doc({ Ok: { type: 'object' }, Dead: { type: 'object' } }, '#/components/schemas/Ok');
    expect(codes(orphan)).toContain('UNREFERENCED_SCHEMA');
    const msg = validateSpecDoc(orphan).find((i) => i.code === 'UNREFERENCED_SCHEMA')!.message;
    expect(msg).toContain('Dead');
    expect(msg).toContain('删除'); // 修法①
    expect(msg).toContain('x-unreferenced-ok'); // 修法②
  });

  it('schema 引用自己不算被使用（自指的 union 外壳照样是孤儿）', () => {
    const d = doc(
      { Branch: { type: 'object' }, Wrapper: { oneOf: [{ $ref: '#/components/schemas/Branch' }, { $ref: '#/components/schemas/Wrapper' }] } },
      '#/components/schemas/Wrapper',
    );
    // Wrapper 被路径引用、Branch 被 Wrapper 引用 → 都沉默；反过来把引用摘掉就红：
    const orphanSelf = doc({ Wrapper: { oneOf: [{ $ref: '#/components/schemas/Wrapper' }] } }, '#/components/schemas/Branch');
    expect(codes(orphanSelf)).toContain('UNREFERENCED_SCHEMA');
    expect(codes(d)).not.toContain('UNREFERENCED_SCHEMA');
  });

  it('带非空字符串 x-unreferenced-ok 的前向声明豁免；空串/缺理由不豁免', () => {
    const both = doc(
      {
        Alive: { type: 'object' },
        Dead: { type: 'object', 'x-unreferenced-ok': '前向声明：理由' },
      },
      '#/components/schemas/Alive',
    );
    expect(codes(both)).toEqual([]);
    const noReason = doc(
      { Alive: { type: 'object' }, Dead: { type: 'object', 'x-unreferenced-ok': '   ' } },
      '#/components/schemas/Alive',
    );
    const hit = validateSpecDoc(noReason).find((i) => i.code === 'UNREFERENCED_SCHEMA');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('Dead');
  });
});

// 终审 W6：draft-4 三事实（const、discriminator、数组型 type）里只有第三条没有执法点。
// 数组型 type 还同时对 lib/oneof.ts 的重叠检测隐形（matches 只认字符串 type），
// 所以它必须像 CONST_IN_OPENAPI_3_0 一样在结构关就被判死，而不是留给求值。
describe('终审 W6：数组型 type 报 ARRAY_TYPE_IN_OPENAPI_3_0', () => {
  const withType = (type: unknown) =>
    base({ '/api/logs': { get: { ...okOp, responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } } } } } } },
      { components: { ...AUTH.components, schemas: { Ok: { type } } } });

  it('type: [number, null] 判错，消息给出 3.0.3 的正确写法', () => {
    const issues = validateSpecDoc(withType(['number', 'null']));
    const hit = issues.find((i) => i.code === 'ARRAY_TYPE_IN_OPENAPI_3_0');
    expect(hit).toBeDefined();
    expect(hit!.level).toBe('error');
    expect(hit!.message).toContain('nullable: true');
  });

  it('字符串型 type（含 nullable: true 配对）不受影响', () => {
    expect(codes(withType('number'))).toEqual([]);
  });
});

// 终审 W5：findings Q3 把"SSE 端点禁用 *WithResponse"派给了客户端批次，但当时只落在
// ui/background（一条 multipart 操作）的 description 上，SSE 那条反而没有。Go 批次还要
// 加三条流端点，所以这里钉的是**形状规则**而非文案点名：凡 200 是 text/event-stream
// 的操作，description 必须提到 WithResponse —— 它是三家生成物唯一都携带的警告通道。
describe('终审 W5：流端点的 description 必须警告 Go 的 *WithResponse', () => {
  it('spec/openapi.yaml 中 200 为 text/event-stream 的操作，description 均含 WithResponse', async () => {
    const doc = parse(await readFile('spec/openapi.yaml', 'utf8')) as {
      paths: Record<string, Record<string, { description?: string; responses?: Record<string, { content?: Record<string, unknown> }> }>>;
    };
    let streams = 0;
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!['get', 'post', 'put', 'delete', 'patch'].includes(method) || !op?.responses) continue;
        if (!op.responses['200']?.content?.['text/event-stream']) continue;
        streams++;
        expect(op.description ?? '', `${method.toUpperCase()} ${path} 是 SSE 操作却没警告 WithResponse`).toContain('WithResponse');
      }
    }
    expect(streams).toBeGreaterThan(0); // 一条流操作都没有时本用例不许空过（同 run.ts 的 scanned=0 判法）
  });
});

// 裁定 R2（设计口径缺口 16，Go 批次实现批次）：上面 W5 用例钉的是 spec/openapi.yaml 的
// 内联形状，但那条判断够不着"200 写成 components/responses 的 $ref"的操作 —— 它被静默跳过，
// 反真空 guard 仍被 /api/state/stream 满足，整条规则永不红。修法把判断收进 validateSpecDoc
// （CLI 对同一份 spec 同步发声）：恰好解一层 '#/components/responses/…' 再判，解不到就报
// SSE_200_REF_UNRESOLVED 而不是沉默。负面 fixture 与它的红成对进仓库（同 overlapping-oneof 的纪律）。
describe('裁定 R2：SSE 的 WithResponse 警告规则认 components/responses 的 $ref', () => {
  it('sse-ref.yaml：$ref 的 event-stream 200 报 SSE_WITHRESPONSE_UNWARNED 并指名 openDebugStream', async () => {
    const issues = validateSpecDoc(await load('sse-ref'));
    const hit = issues.find((i) => i.code === 'SSE_WITHRESPONSE_UNWARNED');
    expect(hit).toBeDefined();
    expect(hit!.level).toBe('warning');
    expect(hit!.message).toContain('openDebugStream');
    expect(hit!.message).toContain('WithResponse');
    // fixture 只命中这一条：除它之外零 issue（错误也不许混进来掩盖本规则的声张）
    expect(issues).toHaveLength(1);
  });

  it('解不到的那支报 SSE_200_REF_UNRESOLVED（warning，绝不静默跳过）；DANGLING_REF 并存是诚实的', () => {
    const doc = base({
      '/api/debug/stream': {
        get: { ...okOp, operationId: 'openDebugStream', responses: { '200': { $ref: '#/components/responses/Nope' } } },
      },
    });
    const issues = validateSpecDoc(doc);
    const hit = issues.find((i) => i.code === 'SSE_200_REF_UNRESOLVED');
    expect(hit).toBeDefined();
    expect(hit!.level).toBe('warning');
    expect(hit!.message).toContain('#/components/responses/Nope');
    expect(issues.map((i) => i.code)).toContain('DANGLING_REF');
  });

  it('description 已写 WithResponse 的 $ref 流操作保持沉默（合规模板即 /api/state/stream 那段）', () => {
    const doc = base(
      {
        '/api/debug/stream': {
          get: {
            ...okOp,
            operationId: 'openDebugStream',
            description: 'Go 侧禁用 *WithResponse 便捷路径：io.ReadAll+Close 会缓冲杀死活流，流消费走裸响应。',
            responses: { '200': { $ref: '#/components/responses/DebugStreamOK' } },
          },
        },
      },
      {
        components: {
          ...AUTH.components,
          responses: {
            DebugStreamOK: { description: 'SSE 流', content: { 'text/event-stream': { schema: { type: 'string' } } } },
          },
        },
      },
    );
    expect(codes(doc)).toEqual([]);
  });

  it('非 components/responses 的 200 $ref 不在本规则射程：不解析、不判 SSE、也不报 UNRESOLVED', () => {
    const doc = base(
      {
        '/api/debug/stream': {
          get: { ...okOp, operationId: 'openDebugStream', responses: { '200': { $ref: '#/components/schemas/NotAResponse' } } },
        },
      },
      {
        components: {
          ...AUTH.components,
          schemas: { NotAResponse: { type: 'object', 'x-unreferenced-ok': 'fixture：本用例只测非 responses 引用不在射程内' } },
        },
      },
    );
    const got = codes(doc);
    expect(got).not.toContain('SSE_200_REF_UNRESOLVED');
    expect(got).not.toContain('SSE_WITHRESPONSE_UNWARNED');
  });
});

// 裁定 R18（Go 批次实现批次）：匿名白名单 / 必标集 / uin 模式三处手抄集合抽成从锚定
// server.ts 派生的单源（tools/lib/upstream-guards.ts）。这组用例是突变证据：把上游文本
// 改坏，派生值必须跟着变、校验器随之变红——哪条突变没咬住，就说明派生层还在读硬编码。
describe('R18 单源派生：上游突变 ⇒ 校验器变红', () => {
  const anchoredServerText = () => readFile(localPathFor(SERVER_TS_REPO_PATH), 'utf8');

  // 把（突变过的）server.ts 写进临时锚定目录（localPathFor 同款布局），走 loadSpecGuardsSync
  // 的真实装配路径——不是把文本直接喂给 deriveSpecGuards 的捷径。
  const tempAnchorWith = async (mutate: (text: string) => string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'slu-guards-'));
    const target = localPathFor(SERVER_TS_REPO_PATH, dir);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, mutate(await anchoredServerText()), 'utf8');
    return dir;
  };

  // 映射钉住（GREEN 侧）：真实锚定文本派生出今天的三样值。上游合法演进（豁免加路径、
  // 新增破坏性端点、改 uin 位数）会先在这里变红，要求人工同步 spec —— 这正是单源的意义。
  it('真实锚定文本派生出 login+ui/public、两道 invoke 闸门、^[0-9]{5,10}$', async () => {
    const guards = deriveSpecGuards(await anchoredServerText());
    expect([...guards.anonymousAllowed].sort()).toEqual(['/api/login', '/api/ui/public']);
    expect(guards.destructiveRequired).toEqual(['/api/debug/invoke', '/api/debug/invoke-stream']);
    expect(guards.uinParamPattern).toBe('^[0-9]{5,10}$');
  });

  // UIN 突变走完整链路：临时锚定目录 → loadSpecGuardsSync → validateSpecDoc 验一份
  // 「按旧真源写对、按新真源写错」的 spec。旧 spec 红、改记法后转绿，两边各断言一次，
  // 防止"恒红"或"恒绿"的假证据。
  it('UIN 突变 end-to-end：上游 UIN_REGEX 改 {6,12}，旧 spec 报 UIN_PATTERN、改记法后转绿', async () => {
    const dir = await tempAnchorWith((t) => t.replace('/^\\d{5,10}$/', '/^\\d{6,12}$/'));
    try {
      const guards = loadSpecGuardsSync(dir);
      expect(guards.uinParamPattern).toBe('^[0-9]{6,12}$'); // 记法差异已规范化成 spec 侧 [0-9] 形
      const oldSpec = base({
        '/api/config/{uin}': { parameters: [{ ...UIN_SCHEMA }], get: { ...okOp, operationId: 'getConfig' } },
      });
      expect(validateSpecDoc(oldSpec)).toEqual([]); // 真实锚定下这份 spec 确实零 issue
      expect(codes(oldSpec, guards)).toContain('UIN_PATTERN'); // 上游一伸手就红
      const newSpec = base({
        '/api/config/{uin}': {
          parameters: [{ ...UIN_SCHEMA, schema: { type: 'string', pattern: '^[0-9]{6,12}$' } }],
          get: { ...okOp, operationId: 'getConfig' },
        },
      });
      expect(codes(newSpec, guards)).toEqual([]); // 且校验器真的在吃派生值，不是只会恒红
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('匿名集突变：豁免 if 的 /api/ui/public 换成 /api/ui/internal，旧豁免立即失效', async () => {
    const dir = await tempAnchorWith((t) => t.replace("reqPath === '/api/ui/public'", "reqPath === '/api/ui/internal'"));
    try {
      const guards = loadSpecGuardsSync(dir);
      expect([...guards.anonymousAllowed].sort()).toEqual(['/api/login', '/api/ui/internal']);
      const doc = base({ '/api/ui/public': { get: { ...okOp, operationId: 'getPublic', security: [] } } });
      expect(validateSpecDoc(doc)).toEqual([]); // 真实锚定下 security: [] 合规（上面 security 用例钉过）
      expect(codes(doc, guards)).toContain('UNEXPECTED_ANONYMOUS_OP'); // 上游改豁免 ⇒ 红
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('必标集突变：上游给 upload 处理器加 invokeAction 调用，未标 flag 的 upload 立即红', async () => {
    const dir = await tempAnchorWith((t) =>
      t.replace(
        'const result = await streamUploadToDisk(',
        "oneBotManager.getInstance('12345')?.invokeAction('send_private_msg', {});\n      const result = await streamUploadToDisk(",
      ),
    );
    try {
      const guards = loadSpecGuardsSync(dir);
      expect(guards.destructiveRequired).toContain('/api/debug/upload');
      const doc = base({
        '/api/debug/upload': { post: { operationId: 'up', 'x-replay-class': 't3', 'x-verification-status': 'destructive-static-only', responses: {} } },
      });
      expect(validateSpecDoc(doc)).toEqual([]); // 真实锚定下 upload 不强制（裁定 R20 用例钉过）
      expect(codes(doc, guards)).toContain('MISSING_DESTRUCTIVE_FLAG'); // 上游把它变成动作调用端点 ⇒ 红
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // 抽取失败的三个方向各自挖掉：派生层必须抛错，绝不回退到任何硬编码副本——
  // 静默回退正是本任务要消灭的"装饰性守卫"。
  it('抽取失败必须抛错：匿名 if / UIN_REGEX 声明 / invoke 调用各自被挖掉时都 throw', async () => {
    const cases: Array<[string, (t: string) => string, RegExp]> = [
      [
        '匿名豁免 if',
        (t) => t.replace("if (reqPath === '/api/login' || reqPath === '/api/ui/public') return next();", 'if (false) return next();'),
        /匿名/,
      ],
      ['UIN_REGEX 声明', (t) => t.replace('const UIN_REGEX = /^\\d{5,10}$/;', ''), /uin/i],
      ['invoke 调用', (t) => t.replace(/\.invokeAction\(|\.invokeStream\(/g, '.call('), /destructive|invoke/i],
    ];
    for (const [label, mutate, pattern] of cases) {
      const dir = await tempAnchorWith(mutate);
      try {
        expect(() => loadSpecGuardsSync(dir), label).toThrow(pattern);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('锚定文件位置上是一个目录（EISDIR）⇒ 缓存不可读抛错并保留方向，不静默当守卫缺失', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slu-guards-'));
    const target = localPathFor(SERVER_TS_REPO_PATH, dir);
    await mkdir(dirname(target), { recursive: true });
    await mkdir(target); // 目录顶替文件：读缓存必 EISDIR
    try {
      expect(() => loadSpecGuardsSync(dir)).toThrow(/缓存不可读/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('X1：allowlist 内路径禁挂 AuthGate403（N6，两张闸门表派生）', () => {
  const resp403 = (ref: string) => ({
    '200': { description: 'ok' },
    '403': { $ref: ref },
  });
  const t1op = (ref: string, id: string) => ({
    operationId: id,
    'x-replay-class': 't1',
    'x-verification-status': 'static-only',
    responses: resp403(ref),
  });
  const withResponsesComponents = {
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      responses: {
        AuthGate403: { description: 'gate' },
        ConsentGate403: { description: 'consent gate' },
      },
    },
  };
  it('check-strength 挂 AuthGate403 即红（它在 MUST_CHANGE_ALLOWLIST 里）', () => {
    const doc = base(
      { '/api/auth/check-strength': { post: t1op('#/components/responses/AuthGate403', 'x1a') } },
      withResponsesComponents,
    );
    expect(codes(doc)).toContain('ALLOWLISTED_AUTHGATE403');
  });
  it('同路径挂 ConsentGate403 保持绿（consent 支可达，N6）', () => {
    const doc = base(
      { '/api/auth/check-strength': { post: t1op('#/components/responses/ConsentGate403', 'x1b') } },
      withResponsesComponents,
    );
    expect(codes(doc)).not.toContain('ALLOWLISTED_AUTHGATE403');
  });
  it('非 allowlist 路径挂 AuthGate403 不触发本规则', () => {
    const doc = base(
      {
        '/api/debug/upload': {
          post: {
            operationId: 'x1c',
            'x-replay-class': 't3',
            'x-verification-status': 'destructive-static-only',
            responses: resp403('#/components/responses/AuthGate403'),
          },
        },
      },
      withResponsesComponents,
    );
    expect(codes(doc)).not.toContain('ALLOWLISTED_AUTHGATE403');
  });
});

/**
 * 孤儿规则负例：这几条分支此前"规则存在、夹具缺位、单测缺位"三缺——
 * 一次重构把它们删掉时全套件照样绿，"合规"与"没检"不可分辨。各补一条能红的输入。
 */
describe('规则分支的可红性（孤儿规则）', () => {
  const bare = { 'x-replay-class': 't1', 'x-verification-status': 'verified', responses: {} } as Record<string, unknown>;

  it('缺 operationId 报 MISSING_OPERATION_ID', () => {
    expect(codes(base({ '/api/x': { post: { ...bare } } }))).toContain('MISSING_OPERATION_ID');
  });

  it('x-replay-class 是非法值（不是缺标）报 BAD_REPLAY_CLASS', () => {
    expect(codes(base({ '/api/x': { post: { ...bare, operationId: 'x', 'x-replay-class': 't9' } } }))).toContain(
      'BAD_REPLAY_CLASS',
    );
  });

  it('x-verification-status 是非法值（不是缺标）报 BAD_VERIFICATION_STATUS', () => {
    expect(codes(base({ '/api/x': { post: { ...bare, operationId: 'x', 'x-verification-status': 'vibes' } } }))).toContain(
      'BAD_VERIFICATION_STATUS',
    );
  });

  it('操作级与全局 security 双缺 ⇒ warning 级 NO_SECURITY_DECLARED', () => {
    const doc = base({ '/api/x': { post: { ...bare, operationId: 'x' } } }, { security: undefined });
    const warning = validateSpecDoc(doc).find((i) => i.code === 'NO_SECURITY_DECLARED');
    expect(warning?.level).toBe('warning');
  });
});
