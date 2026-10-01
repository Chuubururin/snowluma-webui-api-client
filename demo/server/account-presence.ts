// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 账号存在性判据：uin 必须是上游 `listQq` 里的在线实例。
 *
 * 为什么单独成文件、且不放进 `demo/server/routes/`：
 * · `tools/check-ui-coverage.ts` 的断言 4 沿"路由块 → 同文件辅助函数"的调用图归并整份合并标记，
 *   `config.ts` 的 POST 那条块里 `saveOneBotPatched` 带 `deepMerge`，于是这里对 `listQq` 的
 *   **只读咨询**会被算成"listQq 承载了整份合并"，进而要求它在 PARITY 里声明 `merge` ——
 *   那是个假声明（`listQq` 是 T1 读，永远不会被覆盖写）。放在本文件后调用图在这里断开。
 * · `tools/demo-lists.test.ts` 钉住"`routes/` 下每个 `.ts` 都是带 `gateGuard` 的路由表"，
 *   非路由的判据模块放进去会让那条扫描形状失真。
 * **不要**为了"顺手少一个文件"把它挪回 config.ts 或 routes/。
 *
 * 判据为什么取 `listQq`：它与账号选择器（`GET /config/accounts`）同源，
 * 所以"会被这道核拒掉的 uin"恰好就是"面板上选不到的 uin"，不存在拦了一个选得出的账号。
 * 上游 `server.ts:1511` 的 GET 没有这一步，对格式合法但不存在的 uin 一样回 200，
 * body 是 `makeDefaultOneBotConfig()`（`onebot/src/config.ts:43-73`）那份全局默认配置，
 * 其中 `accessToken: generateAccessToken()` 是真实的 32 字节随机 token。
 * 已登记 declination `unknown-uin-config`：离线账号即便有落盘配置，demo 也读不到 ——
 * "该 uin 有 `onebot_<uin>.json`"这件事没有任何 spec 操作能读出来。
 */
import * as sdk from '../../generated/typescript/sdk.gen.js';
import { fail, type ApiResult } from './http.js';
import { gateDispatch } from './routes/gates.js';
import { unwrap, type Upstream } from './upstream.js';

/**
 * 返回 null 表示可以上行；返回 ApiResult 表示就地拒绝。
 * 拒绝必须发生在发请求之前：token 进了本进程再折掉，只是让它少出现在响应里，不是没被取出来。
 */
export async function unknownUin(u: Upstream, uin: string): Promise<ApiResult | null> {
  let list: unknown[];
  try {
    list = ((unwrap(await sdk.listQq({ client: u.client })) as any)?.list ?? []) as unknown[];
  } catch (e) {
    // 读不到证据既不能当作"存在"（那等于这道核不存在），也不能当作"不存在"（那会 404 掉一个在线账号）。
    return gateDispatch(e, fail(502, `无法确认账号 ${uin} 是否存在：qq-list 读取失败，demo 不替上游猜`));
  }
  return list.some((a: any) => a?.uin === uin)
    ? null
    : fail(
        404,
        `账号 ${uin} 不在上游 qq-list（在线实例）里，它的 OneBot 配置既不读也不写：` +
          '上游对未知 uin 会返回全局默认配置，其中 accessToken 是一个真实随机 token，demo 不呈现那份东西',
      );
}
