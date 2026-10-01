// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 夹具的两条常跑安全闸（不依赖 `SNOWLUMA_FIXTURE`，因为它们在起进程之前就该咬）。
 *
 * 为什么这两条必须常跑，而 L4 其余部分可以按需：它们拦的不是"测试写得对不对"，
 * 而是"这条 npm script 会不会把一次 t3 写到一个真实例上 / 会不会在闸根本没触发的情况下全绿"。
 *  · `bootPastGates` 会对目标发 recordConsent + changePassword —— 两条 t3、都不可逆。
 *    如果 5299 上站着的是别人在跑的 dev 实例（本仓的开发机上就有），而夹具没验过端口所有权，
 *    L4 会全绿地改掉那台机器的密码。
 *  · `SNOWLUMA_DEV_MODE=1` 会禁用改密与 2FA（`webui/auth.ts:289`、`:335`），
 *    `SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD` 会把 `mustChangePassword` 直接写成 false
 *    （`webui/auth.ts` 的 bootstrap 分支）⇒ 两个闸永远验不到，五条 L4 却照样能过。
 *
 * 一道没人验过的闸不等于一道闸：本文件的每一条都对应一次变异检验（见 task-14 报告的电池输出）。
 */
import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { assertPortFree, fixtureEnv, startFixture } from './fixture.js';

function occupy(port: number): Promise<{ close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen({ port, host: '127.0.0.1' }, () =>
      resolve({ close: () => new Promise<void>((r) => s.close(() => r())) }),
    );
  });
}

describe('夹具端口所有权闸', () => {
  it('空闲端口放行', async () => {
    // 用一个高位奇数口而不是 `listen(0)` 让内核挑：后者拿到的口与随后要验的口不是同一个，
    // 那条断言就成了"验了一个没人用的号"。真被占了这条会红得可读，不是假绿。
    await expect(assertPortFree(46517)).resolves.toBeUndefined();
  });

  it('端口上已有进程 ⇒ 抛"已被占用"，且不许退化成一句泛错', async () => {
    const port = 46519;
    const holder = await occupy(port);
    try {
      // 断到具体文案：EADDRINUSE 分支若漂到泛错分支，安全语义就丢了
      // ——泛错会让人以为"换个端口试试"，而这里的正确答案是"先停掉那个实例"。
      await expect(assertPortFree(port)).rejects.toThrow(/已被占用/);
      await expect(assertPortFree(port)).rejects.toThrow(String(port));
    } finally {
      await holder.close();
    }
  });

  it('释放之后同一个端口重新可用（闸不许记住上一次失败）', async () => {
    const port = 46521;
    const holder = await occupy(port);
    await holder.close();
    await expect(assertPortFree(port)).resolves.toBeUndefined();
  });

  it('端口能被 bind 但被 fetch 拦 ⇒ 一样拒绝，且点名"能被 bind"', async () => {
    // 6667 在 WHATWG 的 bad-port 表上：bind 会成功，夹具能起起来，然后每一次上游调用都只报
    // "fetch failed" —— L4 会把它读成"实例没答话"。这道闸必须把这种端口也拦下，
    // 判据是问当前运行时的真 fetch（不抄表），出处见 tools/lib/port-probe.ts。
    await expect(assertPortFree(6667)).rejects.toThrow(/bad port/);
    await expect(assertPortFree(6667)).rejects.toThrow(/能被 bind/);
  });

  it('startFixture 自己调用这道闸：忙端口下不 spawn、不建临时目录', async () => {
    // 接线用例：上一组测的是函数，这里测的是"startFixture 里那一行还在"。
    // 删掉 `await assertPortFree(port)` 之后，其余三条全绿而这条红 —— 那正是要区分的东西。
    const port = 46523;
    const holder = await occupy(port);
    try {
      await expect(startFixture({ port })).rejects.toThrow(/已被占用/);
    } finally {
      await holder.close();
    }
  });
});

describe('夹具环境净化', () => {
  it('两个会把门禁写成 false 的变量被删掉，而不是"提醒别设"', () => {
    const out = fixtureEnv(
      { SNOWLUMA_DEV_MODE: '1', SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD: 'hunter2', PATH: '/bin' },
      5299,
    );
    expect('SNOWLUMA_DEV_MODE' in out).toBe(false);
    expect('SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD' in out).toBe(false);
    // 净化不许顺手改掉别的：继承其余环境是夹具能跑起来的前提（node_modules 解析要用 PATH）。
    expect(out.PATH).toBe('/bin');
  });

  it('三个必需变量按设计口径的配方给全（dev webui 开、绑环回、端口传对）', () => {
    const out = fixtureEnv({}, 5299);
    expect(out.SNOWLUMA_DEV_WEBUI).toBe('1');
    expect(out.SNOWLUMA_WEBUI_HOST).toBe('127.0.0.1');
    expect(out.SNOWLUMA_WEBUI_PORT).toBe('5299');
  });

  it('入参对象不被改写（夹具复用同一个 process.env，删键删到原对象上会污染整个测试进程）', () => {
    const base: NodeJS.ProcessEnv = { SNOWLUMA_DEV_MODE: '1' };
    fixtureEnv(base, 5299);
    expect(base.SNOWLUMA_DEV_MODE).toBe('1');
  });
});

/**
 * `SNOWLUMA_FIXTURE_PORT` 的入口校验。放在常跑面（不是 L4 里）的理由：L4 在没设
 * `SNOWLUMA_FIXTURE=1` 时整块 skip，而这道闸要在"还没起进程"之前就能咬。
 */
describe('夹具端口环境变量的入口校验', () => {
  const readDefault = async (): Promise<number> => {
    vi.resetModules();
    const mod = await import('./fixture.js');
    return mod.DEFAULT_FIXTURE_PORT;
  };
  const withEnv = async (raw: string | undefined): Promise<number> => {
    const had = Object.prototype.hasOwnProperty.call(process.env, 'SNOWLUMA_FIXTURE_PORT');
    const prev = process.env.SNOWLUMA_FIXTURE_PORT;
    if (raw === undefined) delete process.env.SNOWLUMA_FIXTURE_PORT;
    else process.env.SNOWLUMA_FIXTURE_PORT = raw;
    try {
      return await readDefault();
    } finally {
      if (had) process.env.SNOWLUMA_FIXTURE_PORT = prev;
      else delete process.env.SNOWLUMA_FIXTURE_PORT;
    }
  };

  // 这两条要显式给 timeout：`withEnv` 每次都是 `resetModules()` + 重新 import `fixture.js`，
  // 而那条 import 会把生成 SDK 的整张图重拉一遍（这是"import 期就抛"这条执法的唯一取证形状）。
  // 实测同一条用例：单跑 1059/1813ms ⇒ 全套并行 3626ms ⇒ 本机稍忙时 4833ms/5133ms。
  // 默认 5000ms 的预算撞过两次（一次红、一次只剩 167ms 余量），所以这不是"要不要放宽断言"，
  // 是给一条按构造就慢的用例一条真实的钟。断言本身一条没动。
  it('未设与空串都落回 5299（空串若走 Number() 会变成 0，即"随机端口"语义）', { timeout: 20000 }, async () => {
    expect(await withEnv(undefined)).toBe(5299);
    expect(await withEnv('')).toBe(5299);
    expect(await withEnv('   ')).toBe(5299);
    expect(await withEnv('5399')).toBe(5399);
  });

  it('设成非端口值就地报错，不把 NaN 交给 bind 去报 ERR_SOCKET_BAD_PORT', { timeout: 20000 }, async () => {
    for (const bad of ['abc', '0', '80', '1023', '65536', '70000', '5299.5']) {
      await expect(withEnv(bad), bad).rejects.toThrow(/SNOWLUMA_FIXTURE_PORT/);
    }
  });
});
