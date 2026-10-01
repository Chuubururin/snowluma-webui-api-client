// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 这条测试同时是三件事的钉子：
 *  ① `demo-stream-live` 偶发红的根因判据（bad-port 拦在连接之前，与"没人监听"是两种错）；
 *  ② 判据用的是**当前运行时的真 fetch**，不是抄下来的端口表 —— 所以它也是那句
 *     `cause.message === 'bad port'` 的哨兵：哪天 Node 改了措辞，这里先红，
 *     而不是让 `listen()` 的守卫悄悄失效、偶发红重新变成"来路不明"。
 *  ③ 两个端口都在测试里**不需要有人监听**：6667 被拦、7000 不被拦，这个差就是全部主张。
 */
import { describe, expect, it } from 'vitest';
import { blockedPortHint, isFetchBlockedPort } from './port-probe.js';

describe('fetch 的 bad-port 拦截面', () => {
  it('6667 在表上：fetch 直接拒，而不是连不上', async () => {
    expect(await isFetchBlockedPort(6667)).toBe(true);
  });

  it('7000 不在表上：连接被拒不等于被拦（两者必须分得开，否则守卫会误杀一切端口）', async () => {
    expect(await isFetchBlockedPort(7000)).toBe(false);
  });

  it('提示文案点名"能 bind 但 fetch 拦"与出处，别让人去查上游', () => {
    const hint = blockedPortHint(6667);
    expect(hint).toContain('能被 bind');
    expect(hint).toContain('bad port');
    expect(hint).toContain('6667');
  });
});
