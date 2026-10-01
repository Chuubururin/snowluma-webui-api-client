// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 一次性可牺牲夹具（设计口径配方）。
 *
 * 隔离机制：`CONFIG_DIR = 'config'` 是**相对 cwd** 的字面量（`packages/common/src/runtime.ts:27`，
 * 落盘点 `:115`/`:144` 都直接 mkdirSync 这个相对路径）⇒ 拿一个空临时目录当 cwd 起进程，
 * 它的 config/ 天然落在临时目录里，不碰任何既有实例的 config/。
 *
 * 为什么必须"非 dev"：`SNOWLUMA_DEV_MODE=1` 会让改密与 2FA 直接抛错禁用
 * （`packages/core/src/webui/auth.ts:289`、`:335`），两个闸就永远验不到。
 * 为什么必须不设 `SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD`：它把口令写死成配置值，
 * `mustChangePassword` 直接是 false ⇒ 闸不触发，L4 会在"什么都没检查"的情况下全绿。
 * 这两条不是"建议不设"，是本模块**主动从 env 里删掉**——操作者的 shell 里带着它们时，
 * 夹具照样是全新非 dev 实例。删没删成功由 `bootPastGates` 的两条真断言反证。
 *
 * 随机初始口令只存在于返回值：不打印、不写盘（`packages/common/src/logger.ts:371-383` 的
 * `logInitialWebuiCredentials` 是唯一来源，它只写进程 stdout，刻意不进应用日志——
 * 注释原话是首启凭据"must only cross the process terminal boundary"）。
 *
 * 安全侧：只允许环回地址；端口必须在本函数开始前是空闲的——否则 5299 上站着的是别人的实例，
 * 而 `bootPastGates` 会对它做 recordConsent + changePassword（两条 t3 写）。
 * 生产实例 `:5099` 因此也被同一道闸挡住（它要么占用端口、要么被端口闸拒绝）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPortFetchable } from './lib/port-probe.js';
import { createUpstream, unwrap, type Upstream } from '../demo/server/upstream.js';
import * as sdk from '../generated/typescript/sdk.gen.js';

export interface Fixture {
  baseUrl: string;
  password: string;
  token: string;
  bootPastGates(): Promise<Upstream>;
  stop(): Promise<void>;
}

/** 环回一次性实例的轮换口令：不是秘密，是脚本常量——秘密只有那个随机初始口令。 */
const ROTATED = 'Fixture!Rotate2026x';
const HOST = '127.0.0.1';

function liveRoot(): string {
  // 用 fileURLToPath 而不是 import.meta.dirname：后者在 vitest 的模块转换下不保证有值，
  // 而本模块既直接被 `tsx` 跑、也被测试进程 import，两条路都得指到同一个仓根。
  const here = fileURLToPath(new URL('.', import.meta.url)); // <repo>/tools/
  return process.env.SNOWLUMA_LIVE_ROOT ?? join(here, '..', '..', 'snowluma-live');
}

/** 端口空闲**且真的能用**才继续：EADDRINUSE 意味着那上面已经有一个真实例，写它就等于写别人的机器。 */
export async function assertPortFree(port: number): Promise<void> {
  await bindProbe(port);
  // bind 得成不等于 fetch 打得出去。落在 WHATWG bad-port 表上的端口（6665-6669、10080……）会让
  // 夹具顺利起起来，然后每一次上游调用都只报 "fetch failed" —— L4 看上去像"实例没答话"，
  // 而真原因是这个端口压根不能被 fetch 使用。判据与实测出处见 tools/lib/port-probe.ts。
  //
  // 顺序是刻意的：先 bind。反过来（先 fetch）会让"端口已被占用"这条最常见的失败多付一次
  // 探测等待，而且占用者是一个不回头的裸 TCP 监听时，那次探测只能靠超时收场。
  try {
    await assertPortFetchable(port, HOST);
  } catch (e) {
    throw new Error(`夹具拒绝使用端口 ${String(port)}：${(e as Error).message}`);
  }
}

function bindProbe(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (e: NodeJS.ErrnoException) => {
      reject(
        new Error(
          e.code === 'EADDRINUSE'
            ? `端口 ${port} 已被占用：夹具拒绝向一个不是自己起的实例写 t3（同意/改密）。换端口或先停掉它。`
            : e.code === 'EACCES'
              ? `端口 ${port} 被系统拒绝绑定（EACCES）：它落在操作系统的保留段里（Windows 用 ` +
                '`netsh int ipv4 show excludedportrange protocol=tcp` 看，Hyper-V/WinNAT 会在运行中重新划段，' +
                `同一个端口可能昨天能用今天不能用）。用 SNOWLUMA_FIXTURE_PORT=<空闲端口> 换一个再跑；` +
                '不要改成"探测失败就当作空闲"，那会让夹具向别人的实例写 t3。'
              : `夹具探测端口 ${port} 失败：${e.message}`,
        ),
      );
    });
    probe.listen({ port, host: HOST }, () => probe.close(() => resolve()));
  });
}

/**
 * 夹具进程的环境变量。抽成纯函数是为了能被一条常跑的测试钉住：
 * 那两个"删掉"的动作若只写在 `startFixture` 里，就没有任何用例能为它作证
 * （测试跑起来时操作者的 shell 里本来就没有它们 ⇒ 删与不删同样绿）。
 */
export function fixtureEnv(base: NodeJS.ProcessEnv, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    SNOWLUMA_DEV_WEBUI: '1',
    SNOWLUMA_WEBUI_HOST: HOST,
    SNOWLUMA_WEBUI_PORT: String(port),
  };
  // 见文件头：这两个变量若存在会把两闸直接写成 false，必须删而不是"提醒别设"。
  delete env.SNOWLUMA_DEV_MODE;
  delete env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD;
  return env;
}

/**
 * 夹具默认端口。5299 会失效：Windows 的 TCP 保留段由 Hyper-V/WinNAT 在运行中重划，
 * 本机实测 `netsh int ipv4 show excludedportrange protocol=tcp` 一度把 5238–5337 整段划走，
 * 于是 bind 5299 直接 EACCES、L4 起不来。留一个环境变量出口，而不是每次去改源码里的数字。
 *
 * 出口在系统边界上，所以这里自己校验而不外抛 bind 的错：`Number('')` 是 0（"随机端口"语义，
 * 夹具会静默换口，而证据与并发控制都假设一个已知端口），`Number('abc')` 是 NaN（bind 报
 * ERR_SOCKET_BAD_PORT）。操作者设错时该看到的是"你设的值不对"，不是操作系统 internals。
 */
function fixturePortFromEnv(): number {
  const raw = process.env.SNOWLUMA_FIXTURE_PORT;
  if (raw === undefined || raw.trim() === '') return 5299;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `SNOWLUMA_FIXTURE_PORT=${JSON.stringify(raw)} 不是 1024-65535 的整数端口。` +
        '留空或撤掉该变量会落回默认 5299；端口落在系统保留段时请换一个再试（见 EACCES 提示）。',
    );
  }
  return port;
}

export const DEFAULT_FIXTURE_PORT: number = fixturePortFromEnv();

export async function startFixture(opts: { port?: number } = {}): Promise<Fixture> {
  const port = opts.port ?? DEFAULT_FIXTURE_PORT;
  await assertPortFree(port);

  const root = liveRoot();
  const tsxCli = join(root, 'packages', 'core', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const entry = join(root, 'packages', 'core', 'src', 'index.ts');

  const cwd = await mkdtemp(join(tmpdir(), 'snowluma-fixture-'));
  const env = fixtureEnv(process.env, port);

  const child: ChildProcess = spawn(process.execPath, [tsxCli, entry], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (b: string) => { log += b; });
  child.stderr?.on('data', (b: string) => { log += b; });
  let exitInfo: string | null = null;
  child.once('exit', (code, signal) => { exitInfo = `code=${code} signal=${signal}`; });
  const killChild = makeKiller(child);

  const baseUrl = `http://${HOST}:${port}`;
  let password = '';
  for (let i = 0; i < 240; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (exitInfo) throw new Error(`夹具进程提前退出（${exitInfo}）：\n${log.slice(-2000)}`);
    if (!password) {
      // logger.ts:378 的格式串逐字对应：`initial credentials: user=admin password=%s`
      const m = /initial credentials: user=admin password=(\S+)/.exec(log);
      if (m) password = m[1];
    }
    if (password) {
      try {
        // /api/status 需要 bearer ⇒ 未登录必然 401；这里只要"有响应"就是起来了。
        const r = await fetch(`${baseUrl}/api/status`);
        if (r.status < 500) break;
      } catch {
        /* 还没起 */
      }
    }
  }
  if (!password) {
    await killChild();
    await removeDir(cwd);
    throw new Error(`夹具未在超时内打印一次性口令（日志尾）：\n${log.slice(-2000)}`);
  }

  // ── 新鲜度自证（必须在这里，且必须在任何测试动手之前）────────────────────
  // 两闸的 true 是"这真的是台全新、非 dev、没被 bootstrap 口令配置过的实例"的唯一机器证据。
  // 放在测试里会出另一件事：第一条测试跑到一半失败后，第二闸已经被前一跳翻成 false，
  // 于是"闸没触发"和"闸已经过了"两种原因在报错里长得一模一样（实测踩过）。
  // login 自身在免 bearer 短路里（server.ts:631），所以这一步不消耗任何一次性状态。
  // unwrap 真抛（上游 5xx/网络抖动）也是失败出口：先拆子进程与临时目录再抛，
  // 否则夹具进程占着端口、临时目录遗留，异常直接冒给 afterAll 掩盖根因。
  const probe = createUpstream(baseUrl);
  let firstLogin: any;
  try {
    firstLogin = unwrap(await sdk.login({ client: probe.client, body: { password } }));
  } catch (e) {
    await killChild();
    await removeDir(cwd);
    throw e;
  }
  if (firstLogin.mustChangePassword !== true) {
    await killChild();
    await removeDir(cwd);
    throw new Error(`夹具的改密闸没有触发（LoginSuccess.mustChangePassword 实为 ${firstLogin.mustChangePassword}）⇒ 不是全新非 dev 实例，L4 不能拿它当证据`);
  }
  probe.authenticate(firstLogin.token);
  let firstAgreements: any;
  try {
    firstAgreements = unwrap(await sdk.getAgreements({ client: probe.client }));
  } catch (e) {
    await killChild();
    await removeDir(cwd);
    throw e;
  }
  if (firstAgreements.consentRequired !== true) {
    await killChild();
    await removeDir(cwd);
    throw new Error(`夹具的同意闸没有触发（AgreementsPayload.consentRequired 实为 ${firstAgreements.consentRequired}）⇒ 不是全新实例`);
  }

  let session: Upstream | null = null;
  const self: Fixture = {
    baseUrl,
    password,
    token: firstLogin.token,
    async bootPastGates() {
      if (session) return session;
      const u = createUpstream(baseUrl);
      const login: any = unwrap(await sdk.login({ client: u.client, body: { password: self.password } }));
      u.authenticate(login.token);
      self.token = login.token;

      // 同意闸：先读再签，version 原样回传（这是显式脚本行为，不是替操作者点同意——
      // 它只可能发生在 startFixture 刚刚自证过"全新"的那台可牺牲实例上）。
      const ag: any = unwrap(await sdk.getAgreements({ client: u.client }));
      if (ag.consentRequired) unwrap(await sdk.recordConsent({ client: u.client, body: { version: ag.version } }));

      const st: any = unwrap(await sdk.getAuthState({ client: u.client }));
      if (st.mustChangePassword) {
        // 顺序要紧：changePassword 要带着旧 token 发（`server.ts:631` 的短路里没有它），
        // 上游改成功后才清空全部会话并回 `requireRelogin: true` ⇒ 作废本地 token 在这之后。
        // 先 signOut 会当场 401（实测：UpstreamError: Unauthorized）。
        unwrap(await sdk.changePassword({ client: u.client, body: { oldPassword: self.password, newPassword: ROTATED } }));
        u.signOut();
        const re: any = unwrap(await sdk.login({ client: u.client, body: { password: ROTATED } }));
        u.authenticate(re.token);
        self.token = re.token;
        self.password = ROTATED;
      }
      session = u;
      return u;
    },
    async stop() {
      await killChild();
      await removeDir(cwd);
    },
  };
  return self;
}

/**
 * SIGKILL 之后 Windows 释放进程对 cwd 的锁是异步的：立刻 rmdir 会 EBUSY，
 * 而 EBUSY 会让 afterAll 抛错、把一次本来通过的 L4 记成红。等退出、再带退避重试。
 */
async function removeDir(target: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === 19) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

function makeKiller(child: ChildProcess): () => Promise<void> {
  return async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill('SIGKILL');
    // 兜底：kill 失败或上游进程树里还有子进程抓着句柄时，等满 5s 也要还。
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 5000).unref?.())]);
  };
}

/**
 * `--down`：清扫**本工具自己**在临时目录里留下的夹具目录（前缀 `snowluma-fixture-`）。
 * 它有意不去杀进程：按端口找人再 kill 是"把可牺牲实例的清理扩成一次任意外部动作"，
 * 一次误判能杀掉别人在跑的 dev 实例。遗留进程请操作者按 `netstat` 自己认。
 */
async function sweepStaleFixtures(): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  const base = tmpdir();
  let removed = 0;
  for (const name of await readdir(base)) {
    if (!name.startsWith('snowluma-fixture-')) continue;
    await rm(join(base, name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

if (process.argv[2] === '--down') {
  console.log(`已清扫 ${await sweepStaleFixtures()} 个遗留夹具目录（只删 ${tmpdir()} 下 snowluma-fixture-* 前缀的目录）`);
} else if (process.argv[1]?.includes(join('tools', 'fixture'))) {
  const fx = await startFixture();
  // 只出地址，不出凭据：口令要由操作者从夹具自己的日志里取。
  console.log(`夹具就绪：${fx.baseUrl}（口令已省略，需要请从它自己的日志取）`);
  process.on('SIGINT', () => void fx.stop().then(() => process.exit(0)));
}
