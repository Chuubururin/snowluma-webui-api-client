// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import { extractRoutesFromSource, isApiOp, NonLiteralRouteError } from './extract-routes.js';

describe('extractRoutesFromSource：正常字面量', () => {
  it('抽取 GET/POST/DELETE 并记录方法、路径、行号', () => {
    const src = [
      "app.get('/api/status', (c) => c.json({}));",
      "app.post('/api/login', async (c) => {",
      '  return c.json({});',
      '});',
      "app.delete('/api/system/tls/cert', (c) => c.json({}));",
    ].join('\n');
    expect(extractRoutesFromSource(src, 'server.ts')).toEqual([
      { method: 'GET', path: '/api/status', file: 'server.ts', line: 1 },
      { method: 'POST', path: '/api/login', file: 'server.ts', line: 2 },
      { method: 'DELETE', path: '/api/system/tls/cert', file: 'server.ts', line: 5 },
    ]);
  });

  it('双引号同样可抽取', () => {
    expect(extractRoutesFromSource('app.get("/api/ui", h)', 'x')).toEqual([
      { method: 'GET', path: '/api/ui', file: 'x', line: 1 },
    ]);
  });

  it('跳过 app.use，不误收中间件', () => {
    const src = "app.use('*', mw);\napp.use('/api/*', guard);\napp.get('/api/logs', h);";
    expect(extractRoutesFromSource(src, 'x').map((r) => r.path)).toEqual(['/api/logs']);
  });

  it('前缀是别的单词时不匹配 app.', () => {
    expect(extractRoutesFromSource("someApp.get('/api/x', h)", 'x')).toEqual([]);
    expect(extractRoutesFromSource("mockApp.post('/api/y', h)", 'x')).toEqual([]);
  });
});

describe('extractRoutesFromSource：守卫必须触发', () => {
  it('模板字符串路径 → 抛 NonLiteralRouteError', () => {
    const src = 'app.get(`/api/x`, h);';
    expect(() => extractRoutesFromSource(src, 'x')).toThrow(NonLiteralRouteError);
  });

  it('路径拼接 → 抛 NonLiteralRouteError', () => {
    expect(() => extractRoutesFromSource("app.get('/api/' + name, h);", 'x')).toThrow(
      NonLiteralRouteError,
    );
  });

  it('变量路径 → 抛 NonLiteralRouteError', () => {
    expect(() => extractRoutesFromSource('app.get(basePath, h);', 'x')).toThrow(
      NonLiteralRouteError,
    );
  });

  // 设计口径列的第三种破坏正则的形态：Hono 的 app.route(挂载点, 子应用)。
  // 前两种（反引号、拼接）已实现，这一条在落地时被计划的全局约束悄悄丢掉。
  it('app.route( 挂载 → 抛 NonLiteralRouteError（被挂载的操作正则看不见）', () => {
    expect(() => extractRoutesFromSource("app.route('/api/admin', adminApp);", 'x')).toThrow(
      NonLiteralRouteError,
    );
    // 挂载形态与首参写法无关：带引号的挂载点同样是挂载，也必须抛
    expect(() => extractRoutesFromSource("app.route('/sub', sub);", 'x')).toThrow(
      /app\.route\(/,
    );
  });

  it('app.route( 的报错指名文件与行号，便于定位挂载点', () => {
    const src = "app.get('/api/a', h);\napp.route('/sub', sub);";
    expect(() => extractRoutesFromSource(src, 'server.ts')).toThrow(/server\.ts:2/);
  });

  it('前缀是别的单词时 app.route( 守卫也不触发（与 \\bapp\\. 一致）', () => {
    expect(() => extractRoutesFromSource("router.route('/api/x', h)", 'x')).not.toThrow();
    expect(() => extractRoutesFromSource("someApp.route('/api/x', h)", 'x')).not.toThrow();
    expect(extractRoutesFromSource("someApp.route('/api/x', h)", 'x')).toEqual([]);
  });
});

// 明确不做什么（已在此处踩过一次假阳性）：守卫**不分类 app.use( 的第二个实参**。
// 想抓 "app.use('/api/x', subApp)" 这种挂载形态，只能看第二实参是不是标识符，
// 而真实上游 vendor/upstream/core/src/webui/server.ts:581 就是
// `app.use('*', webuiSecurityHeaders)` —— 以裸标识符传入的真中间件，与子应用在形状上不可区分。
// 判定它 = 在正确输入上中止抽取，等同于把设计口径的"大声失败"变成"随机失败"。
describe('extractRoutesFromSource：四类真实 app.use( 形态必须保持沉默', () => {
  const REAL_USE_SHAPES: { label: string; src: string }[] = [
    { label: 'server.ts:581 裸标识符中间件', src: "app.use('*', webuiSecurityHeaders);" },
    {
      label: 'server.ts:612 async (c, next) 处理器',
      src: "app.use('*', async (c, next) => {\n  await next();\n});",
    },
    {
      label: 'server.ts:626 带 API 前缀的 async (c, next)',
      src: "app.use('/api/*', async (c, next) => {\n  await next();\n});",
    },
    {
      label: 'server.ts:1777 调用表达式（serveStatic）',
      src: "app.use('/*', serveStatic({ root: staticRoot }));",
    },
  ];

  for (const { label, src } of REAL_USE_SHAPES) {
    it(`${label} → 不抛，且不产出任何操作`, () => {
      expect(() => extractRoutesFromSource(src, 'server.ts')).not.toThrow();
      expect(extractRoutesFromSource(src, 'server.ts')).toEqual([]);
    });
  }
});

// 设计口径记录的实测回归：初版守卫用 /\+\s*\w+\s*\)/ 整文件扫描，
// 在两个真实文件上都假阳性，会让抽取器在正确输入上直接中止。
describe('extractRoutesFromSource：守卫不得假阳性', () => {
  it('无关代码里的 + 拼接不触发守卫', () => {
    const src = [
      'const total = a + b;',
      'const msg = `x`;',
      "log.info('ok %s', e instanceof Error ? e.message : String(e));",
      "app.get('/api/logs', (c) => c.json({ list: getRecentLogs(n + 1) }));",
    ].join('\n');
    expect(extractRoutesFromSource(src, 'x').map((r) => r.path)).toEqual(['/api/logs']);
  });

  it('处理函数体内含引号、括号、模板串不干扰', () => {
    const src = "app.post('/api/x', (c) => {\n  const s = `t${a + b}`;\n  return c.json({ s });\n});";
    expect(extractRoutesFromSource(src, 'x').map((r) => r.path)).toEqual(['/api/x']);
  });
});

describe('isApiOp', () => {
  it('只有 /api/ 前缀算 API 操作', () => {
    expect(isApiOp('/api/logs')).toBe(true);
    expect(isApiOp('/robots.txt')).toBe(false);
    expect(isApiOp('*')).toBe(false);
    expect(isApiOp('/avatar/:uin')).toBe(false);
    expect(isApiOp('/ui-asset/background')).toBe(false);
  });
});
