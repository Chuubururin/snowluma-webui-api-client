// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * "这个端口能不能被**当前这个 Node** 的 `fetch` 打出去" —— 与"能不能 bind"是两件事。
 *
 * 存在的理由（实测）：undici 按 WHATWG fetch 的 bad-port 表在**发起连接之前**就拒掉
 * 一批端口，报 `TypeError: fetch failed` + `cause: Error: bad port`。从当前 `node.exe`（v22.23.1）
 * 的快照里读出那张表共 82 条，其中 19 条在 1024 以上（1719、2049、5060、6000、6665-6669、6679、
 * 6697、10080……），而 Windows 的 TCP 动态端口段本机实测从 **1024** 起
 * （`netsh int ipv4 show dynamicport tcp` ⇒ 1024–65534），且实测 600 次 `listen(0)` 发的是
 * **连续走位**的一段（15340–15939），所以它爬到那一带时，一次 bind 成功、随后每个 fetch 全灭。
 * 这就是 `tools/demo-stream-live.test.ts` 偶发红的根因：两种签名（`expected 500 to be 200` 与
 * `fetch failed / bad port`）是同一条原因的两个观测点 —— 上游那条口被拦时路由里折成 500。
 *
 * 判据刻意**不抄端口表**：真发一次 fetch 问当前运行时。表换了、Node 换了、以后加了例外，
 * 这里都不需要同步修改；抄表的那份会在某一天悄悄腐掉（而这道检查腐掉的方式是"又开始偶发红"）。
 *
 * 三语不等价（同一端口 6667，实测）：`python urllib` 200、`go net/http` 200、只有 fetch 这条路被拦。
 * 所以这条不是"上游地址不合法"，是客户端栈的分叉 —— 见 demo/declinations.ts 的登记。
 */

/** 往这个端口发一次探测请求，并把"被拦"翻译成布尔。 */
async function probeFetch(port: number, host: string): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('probe-timeout')), 1500);
  try {
    // 探测路径不需要有人监听：被拦的端口在连接前就报错，没被拦的会给出 ECONNREFUSED 或真响应。
    await fetch(`http://${host}:${String(port)}/__port-probe`, { signal: ac.signal });
    return false;
  } catch (e) {
    const cause = (e as { cause?: { message?: string } })?.cause;
    return cause?.message === 'bad port';
  } finally {
    clearTimeout(timer);
  }
}

/** 端口是否被当前运行时的 fetch 拦成 bad port。拦不住的那些（能连、被拒、超时）一律 false。 */
export async function isFetchBlockedPort(port: number, host = '127.0.0.1'): Promise<boolean> {
  return probeFetch(port, host);
}

/**
 * 守卫：被拦 ⇒ 抛带出处的错；能连（哪怕立刻被拒、哪怕响应 404）⇒ 原样返回端口。
 * "有任何 HTTP 响应"也判可达是故意的松：真响应的端口绝不可能同时被拦，而误报一个不可达
 * 会让夹具拒绝一个本来好用的端口 —— 那比漏报更糟。
 */
export async function assertPortFetchable(port: number, host = '127.0.0.1'): Promise<void> {
  if (await probeFetch(port, host)) throw new Error(blockedPortHint(port));
}

/** 拦得住的端口给出可执行的说明；调用方拿它拼自己的前缀。 */
export function blockedPortHint(port: number): string {
  return (
    `端口 ${String(port)} 能被 bind，但当前 Node 的 fetch 按 WHATWG 的 bad-port 表在连接之前就拒掉它` +
    '（`TypeError: fetch failed` / `cause: Error: bad port`）。它落在 1024 以上的保留服务端口带里' +
    '（如 6665-6669、10080），而 Windows 的 TCP 动态端口段实测从 1024 起、连续走位，' +
    '所以 `listen(0)` 也可能正好发到它。换一个端口，别把它当成"上游没答话"。'
  );
}
