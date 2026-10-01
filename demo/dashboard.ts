// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/** 入口 shim：端口与启动在此，实现全在 demo/server/。`npm run demo` 与 6097 不变。 */
import { startDemoServer } from './server/start.js';

const PORT = Number(process.env.SNOWLUMA_DEMO_PORT ?? 6097);
startDemoServer(PORT);
