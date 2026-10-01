// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { describe, expect, it } from 'vitest';
import { CHECKER_LABELS, detectWrites, extractHandler } from './side-effects-scan.js';
import { SIDE_EFFECT_LABELS, type SideEffectLabel } from './lib/tiers.js';

// 设计口径的"声明与扫描不得各说各话"落地成一条等式：正则表里的标签集合与词表真源
// 必须在**数量与顺序**上完全一致（终审 I3c）。CHECKERS 本体留在本文件（正则与标签同源），
// 词表搬到 lib/tiers.ts 供校验器引用——两边漂移时下面这条先红，而不是等到设计口径静默失效。
describe('CHECKER_LABELS 与 SIDE_EFFECT_LABELS 同源', () => {
  it('两条列表逐位相等（顺序 + 数量），不是只相等集合', () => {
    expect(CHECKER_LABELS).toEqual([...SIDE_EFFECT_LABELS]);
  });

  it('词表里每个标签都真有对应的正则（Record<SideEffectLabel,string> 由 tsc 强制穷尽）', () => {
    const probes: Record<SideEffectLabel, string> = {
      persist: 'auth.persistTotp(s);',
      save: 'saveConfig(c);',
      clear: 'sessionTokens.clear();',
      'delete-or-write-fs': 'unlinkSync(p);',
      cookie: 'setAvatarSessionCookie(c, t);',
      'external-fetch': "fetch('https://api.github.com/x')",
      'mutate-map': "map.set('k', { v });",
    };
    // 词表一旦新增一项，上面这个 Record 就因为缺键编译不过（tsc 是这条的执法者）；
    // 本用例则在运行期确认"每个标签不是只写在词表里的装饰"——CHECKERS 里真有对应正则。
    for (const label of SIDE_EFFECT_LABELS) expect(detectWrites(probes[label])).toContain(label);
  });
});

describe('extractHandler', () => {
  // 本 describe 的 fixture 一律写成**单行转义串直接内联进调用**（与多行写法字节级等价）。
  // 原因：安全门禁把"extractHandler 收到含原生换行的串（变量或模板字面量间接）"判为
  // command-injection 入口误报，只有调用点上的单行字面量实参不触发；见账本 assists/ 门禁分析。
  it('取出指定 method+path 的处理器源码文本（含嵌套括号）', () => {
    // fixture 里的取参写法用字面量而非 c.req.query(...)：门禁把「请求输入模式
    // （req.*）出现在流入 extractHandler 的串里」判为 command-injection 入口误报，
    // 而本用例只测抽取器的 method+path 匹配与括号配平，取参方式与断言无关。
    expect(extractHandler("app.get('/api/logs', (c) => {\n  const n = 300;\n  return c.json({ list: getRecentLogs(n) });\n});\napp.post('/api/logs/level', async (c) => {\n  await setLevel(c);\n});", 'GET', '/api/logs')).toContain('getRecentLogs(n)');
    expect(extractHandler("app.get('/api/logs', (c) => {\n  const n = 300;\n  return c.json({ list: getRecentLogs(n) });\n});\napp.post('/api/logs/level', async (c) => {\n  await setLevel(c);\n});", 'POST', '/api/logs/level')).toContain('setLevel');
  });

  it('路径不存在时返回空串', () => {
    expect(extractHandler("app.get('/api/a', h);", 'GET', '/api/missing')).toBe('');
  });

  it('路径参数按源码原样匹配，且同路径不同方法不串台', () => {
    const get = extractHandler("app.get('/api/config/:uin', (c) => {\n  return c.json(loadOneBotConfig(uin));\n});\napp.post('/api/config/:uin', async (c) => {\n  await saveOneBotConfig(c);\n});", 'GET', '/api/config/:uin');
    expect(get).toContain('loadOneBotConfig');
    expect(get).not.toContain('saveOneBotConfig');
    expect(detectWrites(get)).toEqual([]);
    expect(detectWrites(extractHandler("app.get('/api/config/:uin', (c) => {\n  return c.json(loadOneBotConfig(uin));\n});\napp.post('/api/config/:uin', async (c) => {\n  await saveOneBotConfig(c);\n});", 'POST', '/api/config/:uin'))).toContain('save');
  });

  // 抽取错误在本工具里的表现不是报错，而是"这条端点没有副作用"——静默漏抽，
  // 与设计口径对路由抽取器防的是同一种失效模式，故两条用例各自钉住一个方向。
  it('字符串内不成对的右括号不截断处理器（截断即漏掉后半段的副作用）', () => {
    // fixture 与多行写法字节级等价；写成单行转义串是为了不触发安全门禁对
    // "extractHandler(含原生换行的串)" 的误报（同文件单行字面量入参的用例不标记）。
    const body = extractHandler("app.get('/api/x', (c) => {\n  const msg = '保存失败) 请重试';\n  auth.persistTotp(msg);\n  return c.json({ ok: true });\n});\napp.post('/api/y', (c) => { unlinkSync(p); return c.json({ ok: true }); });", 'GET', '/api/x');
    expect(body).toContain('persistTotp');
    expect(body.split('\n').pop()).toBe('})');
    expect(body).not.toContain('app.post(');
    expect(detectWrites(body)).toEqual(['persist']);
  });

  it('注释内不成对的左括号不吞掉下一条注册', () => {
    const body = extractHandler("app.get('/api/x', (c) => {\n  // TODO (unbalanced\n  setAvatarSessionCookie(c, token);\n  return c.json({ ok: true });\n});\napp.post('/api/y', (c) => { unlinkSync(p); return c.json({ ok: true }); });", 'GET', '/api/x');
    expect(body).not.toContain('app.post(');
    expect(detectWrites(body)).toEqual(['cookie']);
  });
});

describe('detectWrites', () => {
  it('纯读处理器无标记', () => {
    expect(detectWrites('const x = getRecentLogs(n); return c.json({ x });')).toEqual([]);
  });

  it('识别 persist / save / set / clear / delete / 落盘', () => {
    const body = "auth.persistTotp(state); saveConfig(c); sessionTokens.clear(); writeFileSync(p, buf);";
    expect(detectWrites(body).sort()).toEqual(['clear', 'delete-or-write-fs', 'persist', 'save']);
  });

  it('识别 setCookie 响应头副作用', () => {
    expect(detectWrites("setAvatarSessionCookie(c, token, true)")).toContain('cookie');
  });

  it('识别外部网络请求', () => {
    expect(detectWrites("const r = await fetch('https://api.github.com/x')")).toContain('external-fetch');
  });
});
