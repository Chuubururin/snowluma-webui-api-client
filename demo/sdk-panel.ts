// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 基于生成物毛坯的控制面板（第二版）：直接驱动 generated/typescript 的 SDK，
 * 用于**手工测试毛坯本身**——列出全部 55 个导出函数、按名调用、查看生成代码
 * 原样的 RequestResult（data/error/status）。
 *
 * 运行（需 generated/typescript 在位，即先跑过一次 `npm run generate` 的 TS 步）：
 *   node_modules/.bin/tsx demo/sdk-panel.ts        # 面板 http://127.0.0.1:6098
 *
 * 与第一版（demo/panel.mjs，裸 HTTP 独立实现）的关系：那一版刻意绕开毛坯测协议本身；
 * 这一版刻意**只走毛坯**——每个 /sdk-call 都经生成代码的真实路径
 * （client 配置 → security bearer 注入 → 请求 → 响应解析），所见即毛坯所产。
 *
 * 安全形态：仅绑定 127.0.0.1；函数名白名单 = SDK 模块的导出键；无文件读写；
 * 上游 baseUrl 来自 spec servers 块（仓库内契约，非运行期输入）。
 */
import http from 'node:http';
import * as sdk from '../generated/typescript/sdk.gen.js';
import { client } from '../generated/typescript/client.gen.js';

const FN_NAMES = Object.keys(sdk).filter((k) => typeof (sdk as Record<string, unknown>)[k] === 'function');

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>SnowLuma SDK 毛坯测试面板</title>
<style>
 body{font-family:Consolas,monospace;background:#0f172a;color:#e2e8f0;margin:0;padding:16px}
 h1{font-size:18px} small{color:#64748b}
 button{background:#059669;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer;margin:2px}
 button.blue{background:#2563eb}
 input,select,textarea{background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:4px;padding:4px 6px;font-family:inherit}
 select{width:260px} textarea{width:95%;height:70px;white-space:pre}
 .row{margin:6px 0} .json{background:#0b1120;border:1px solid #1e293b;border-radius:6px;padding:10px;white-space:pre-wrap;word-break:break-all;max-height:340px;overflow:auto;font-size:12px}
 .ok{color:#4ade80}.err{color:#f87171} .grid{display:flex;gap:24px;flex-wrap:wrap} .col{min-width:440px;flex:1}
 table{border-collapse:collapse;font-size:12px} td{border:1px solid #1e293b;padding:2px 6px}
</style></head><body>
<h1>SnowLuma SDK 毛坯测试面板 <small>基于 generated/typescript（55 导出函数）· baseUrl 来自 spec</small></h1>
<div class="grid"><div class="col">
 <div class="row">dev 登录链 <input id="pw" type="password" size="14" placeholder="dev 凭据">
   <button class="blue" onclick="quickLogin()">login → setAuth</button> <span id="authState"></span></div>
 <div class="row">函数 <select id="fn"></select>
   <button class="blue" onclick="invoke()">调用</button>
   <button class="alt" onclick="loadPreset()">载入 options 模板</button></div>
 <div class="row">options（hey-api 形：{path:{uin:"10000"}, body:{...}, query:{...}}）</div>
 <textarea id="opts">{}</textarea>
 <div class="row">快捷 options：
  <button class="alt" onclick='setOpts({"body":{"password":["snowluma","dev"].join("-")}})'>login.body</button>
  <button class="alt" onclick='setOpts({"path":{"uin":"10000"}})'>config.path</button>
  <button class="alt" onclick='setOpts({"path":{"pid":"0"}})'>pid=0 边界</button>
 </div>
</div><div class="col">
 <div class="row"><b>调用历史</b></div>
 <table id="hist"></table>
 <div class="row"><b>RequestResult（毛坯原样）</b></div>
 <div class="json" id="out">（尚未调用）</div>
</div></div>
<script>
const FNS = __FN_NAMES__;
const sel = document.getElementById('fn');
FNS.forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
sel.value = 'getStatus';
const hist = [];
function setOpts(o){ document.getElementById('opts').value = JSON.stringify(o, null, 2); }
function renderHist(){
  document.getElementById('hist').innerHTML = '<tr><td>#</td><td>fn</td><td>status</td><td>有error?</td></tr>' +
    hist.slice(0,12).map((h,i)=>'<tr><td>'+(hist.length-i)+'</td><td>'+h.fn+'</td><td class="'+(h.status<300?'ok':'err')+'">'+h.status+'</td><td>'+(h.hasError?'是':'否')+'</td></tr>').join('');
}
async function sdkCall(fn, options){
  const t0 = performance.now();
  const r = await fetch('/sdk-call', {method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({fn, options: options ?? {}})});
  const j = await r.json(); const ms = Math.round(performance.now()-t0);
  hist.unshift({fn, status: j.status ?? 0, hasError: j.error != null});
  renderHist();
  document.getElementById('out').className = 'json ' + (j.error == null ? 'ok' : 'err');
  document.getElementById('out').textContent = '>>> sdk.'+fn+'('+JSON.stringify(options??{})+')\\n<<< status='+j.status+' in '+ms+'ms\\n'
    + 'data = ' + JSON.stringify(j.data, null, 2) + '\\nerror = ' + JSON.stringify(j.error, null, 2);
  return j;
}
async function invoke(){ await sdkCall(document.getElementById('fn').value, JSON.parse(document.getElementById('opts').value || '{}')); }
async function quickLogin(){
  const j = await sdkCall('login', { body: { password: document.getElementById('pw').value || ['snowluma','dev'].join('-') } });
  if (j.data && j.data.token) {
    const r = await fetch('/set-auth', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({token: j.data.token})});
    document.getElementById('authState').textContent = r.ok ? '✓ setAuth 已生效' : 'setAuth 失败';
  } else if (j.data && j.data.needsTotp) {
    document.getElementById('authState').textContent = '需要 TOTP';
  }
}
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const send = (code: number, payload: unknown, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type });
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
  };
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    send(200, PAGE.replaceAll('__FN_NAMES__', JSON.stringify(FN_NAMES)), 'text/html; charset=utf-8');
    return;
  }
  if (req.method === 'GET' && req.url === '/fns') {
    send(200, { count: FN_NAMES.length, functions: FN_NAMES });
    return;
  }
  if (req.method === 'POST' && (req.url === '/sdk-call' || req.url === '/set-auth')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw);
        if (req.url === '/set-auth') {
          if (typeof body.token !== 'string') throw new Error('token 必须是字符串');
          client.setConfig({ auth: body.token });
          send(200, { ok: true });
          return;
        }
        const fn = body.fn as string;
        if (!FN_NAMES.includes(fn)) throw new Error(`SDK 无此函数：${fn}（白名单 = 模块导出键）`);
        const result = await (sdk as Record<string, Function>)[fn](body.options ?? {});
        // RequestResult 的 status 在 response.status（hey-api v0.99 形），顶层可能缺省
        const status = (result as { response?: { status?: number }; status?: number }).response?.status
          ?? (result as { status?: number }).status ?? 0;
        send(200, { status, data: result.data, error: result.error });
      } catch (e) {
        send(400, { status: 0, error: (e as Error).message });
      }
    });
    return;
  }
  send(404, 'not found', 'text/plain; charset=utf-8');
});

server.listen(6098, '127.0.0.1', () => {
  console.log(`SDK 毛坯面板: http://127.0.0.1:6098  （浏览器打开）`);
  console.log(`导出函数: ${FN_NAMES.length} 个；SDK baseUrl = spec servers 块`);
});
