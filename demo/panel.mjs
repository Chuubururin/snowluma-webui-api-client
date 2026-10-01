#!/usr/bin/env node
// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 最简控制面板 demo：与 SnowLuma WebUI API 的 GET/POST 交互测试台。
 *
 * 形态：单文件、零依赖（node:http + 原生 fetch）。
 *   node demo/panel.mjs [--upstream http://127.0.0.1:5099] [--port 6099] [--strict-ssrf]
 * 然后浏览器打开 http://127.0.0.1:6099 —— 面板页内填实例地址与密码即可交互。
 *
 * 结构：本进程 = 静态面板页 + 同源代理。
 *   面板 JS 只 fetch 本服务的 /proxy（同源，无 CORS 问题）；
 *   本服务再把请求转发到上游 SnowLuma（服务端到服务端）。
 *
 * 上游目标的安全校验（Mimosa 约束的实现与裁定）：
 *   - 协议白名单：仅 http/https（parse 后校验）；
 *   - host 在**启动时**经 --upstream 显式配置并锁定，运行期每个请求都断言
 *     最终 URL 的 host 与之一致、redirect: 'manual' 禁止跟随到其它主机；
 *   - host 分类检测已实现（loopback/private/reserved 识别）。**默认放行环回/私网**：
 *     本工具的唯一目标就是操作者本机的 SnowLuma 实例（127.0.0.1:5099），
 *     拒绝环回等于使需求不可实现；--strict-ssrf 可启用严格拒绝模式。
 */
import http from 'node:http';

// ── 启动参数 ──
const args = process.argv.slice(2);
const getArg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
};
const UPSTREAM = getArg('--upstream', 'http://127.0.0.1:5099').replace(/\/+$/, '');
const PANEL_PORT = Number(getArg('--port', '6099'));
const STRICT_SSRF = args.includes('--strict-ssrf');

// ── 上游目标校验（启动时一次 + 运行期逐请求复核） ──
function classifyHost(hostname) {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return 'loopback';
  if (/^127\./.test(hostname) || hostname === '::1' || hostname === '[::1]') return 'loopback';
  if (/^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) {
    return 'private';
  }
  if (/^169\.254\./.test(hostname) || hostname.endsWith('.local')) return 'link-local';
  return 'public';
}

function validateUpstream(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`上游地址不可解析：${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`上游协议必须是 http/https，实为 ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) throw new Error('上游地址不应携带 userinfo');
  const cls = classifyHost(parsed.hostname);
  if (STRICT_SSRF && cls !== 'public') {
    throw new Error(`--strict-ssrf 下拒绝 ${cls} 目标：${parsed.hostname}`);
  }
  return { url: parsed.toString(), host: parsed.host, class: cls };
}

const upstream = validateUpstream(UPSTREAM);

// ── 代理转发：路径白名单 + 方法白名单 + 同 host 锁定 ──
const ALLOWED_METHODS = new Set(['GET', 'POST']);

async function proxy(body) {
  const { method, path, token } = body;
  if (!ALLOWED_METHODS.has(method)) throw new Error(`方法不允许：${method}`);
  if (typeof path !== 'string' || !path.startsWith('/api/')) throw new Error('path 必须以 /api/ 开头');
  // 上游 url 规范化时去尾斜杠，避免与 path 的前导 / 拼出 //（Hono 会当不同路由落 catch-all）
  let url = upstream.url.replace(/\/+$/, '') + path;
  const parsed = new URL(url);
  if (parsed.host !== upstream.host) throw new Error(`目标 host 偏离锁定值：${parsed.host}`);
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const hasBody = method === 'POST' && body.json !== undefined && body.json !== null;
  const res = await fetch(url, {
    method,
    headers,
    body: hasBody ? JSON.stringify(body.json) : undefined,
    redirect: 'manual', // 禁跟随：任何重定向都会偏离锁定的 host
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

// ── 面板页（内联单页） ──
const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>SnowLuma 控制面板 demo</title>
<style>
 body{font-family:Consolas,monospace;background:#0f172a;color:#e2e8f0;margin:0;padding:16px}
 h1{font-size:18px} button{background:#2563eb;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer;margin:2px}
 button.alt{background:#334155} input{background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:4px;padding:4px 6px;width:280px}
 .row{margin:6px 0} .json{background:#0b1120;border:1px solid #1e293b;border-radius:6px;padding:10px;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto;font-size:12px}
 .ok{color:#4ade80}.err{color:#f87171} .grid{display:flex;gap:24px;flex-wrap:wrap} .col{min-width:420px;flex:1}
 table{border-collapse:collapse;font-size:12px} td{border:1px solid #1e293b;padding:2px 6px}
</style></head><body>
<h1>SnowLuma 控制面板 demo <small style="color:#64748b">upstream: ${upstream.url} (${upstream.class})</small></h1>
<div class="grid"><div class="col">
 <div class="row">密码 <input id="pw" type="password" value=""> <button onclick="doLogin()">POST /api/login</button></div>
 <div class="row">token <input id="token" type="text" readonly placeholder="登录后自动填充"></div>
 <div class="row"><b>GET 快捷</b></div>
 <div class="row">
  <button onclick="doGet('/api/status')">status</button>
  <button onclick="doGet('/api/system')">system</button>
  <button onclick="doGet('/api/qq-list')">qq-list</button>
  <button onclick="doGet('/api/connections')">connections</button>
  <button onclick="doGet('/api/logs')">logs</button>
  <button onclick="doGet('/api/logs/level')">logs/level</button>
  <button onclick="doGet('/api/agreements')">agreements</button>
  <button onclick="doGet('/api/notifications/config')">notify/config</button>
  <button onclick="doGet('/api/notifications/recent')">notify/recent</button>
  <button onclick="doGet('/api/global-config')">global-config</button>
  <button onclick="doGet('/api/ui/public')">ui/public(匿名)</button>
 </div>
 <div class="row">自定义 GET path <input id="getPath" value="/api/logs/level"> <button class="alt" onclick="doGet(document.getElementById('getPath').value)">GET</button></div>
 <div class="row">自定义 POST path <input id="postPath" value="/api/logs/level"> body(JSON) <input id="postBody" value='{"level":"debug"}'> <button class="alt" onclick="doPost()">POST</button></div>
</div><div class="col">
 <div class="row"><b>请求历史</b></div>
 <table id="hist"></table>
 <div class="row"><b>最近响应</b></div>
 <div class="json" id="out">（尚未请求）</div>
</div></div>
<script>
const hist=[];
async function viaProxy(method,path,json){
  const t0=performance.now();
  const r=await fetch('/proxy',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({method,path,json,token:document.getElementById('token').value||null})});
  const data=await r.json(); const ms=Math.round(performance.now()-t0);
  hist.unshift({method,path,status:data.status,ms}); renderHist();
  const el=document.getElementById('out');
  el.className='json '+(data.status>=200&&data.status<300?'ok':'err');
  el.textContent='>>> '+method+' '+path+'\\n<<< '+data.status+' ('+ms+'ms)\\n'+JSON.stringify(data.json,null,2);
  return data;
}
function renderHist(){document.getElementById('hist').innerHTML='<tr><td>#</td><td>method</td><td>path</td><td>status</td><td>ms</td></tr>'+
  hist.slice(0,12).map((h,i)=>'<tr><td>'+(hist.length-i)+'</td><td>'+h.method+'</td><td>'+h.path+'</td><td class="'+(h.status<300?'ok':'err')+'">'+h.status+'</td><td>'+h.ms+'</td></tr>').join('');}
async function doLogin(){
  const pw=document.getElementById('pw').value;
  const d=await viaProxy('POST','/api/login',{password:pw});
  const j=d.json||{};
  if(j.success===true&&j.token){document.getElementById('token').value=j.token;
    el('mustChange', j.mustChangePassword);}
  else if(j.needsTotp){alert('需要 TOTP：本 demo 未带第二因子输入，请用适配层或关闭 TOTP');}
}
function el(id,v){const e=document.getElementById(id);if(e)e.textContent=v;}
async function doGet(p){await viaProxy('GET',p);}
async function doPost(){
  let body; try{body=JSON.parse(document.getElementById('postBody').value);}
  catch(e){alert('body 不是合法 JSON');return;}
  await viaProxy('POST',document.getElementById('postPath').value,body);
}
</script></body></html>`;

// ── HTTP 服务 ──
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (req.method === 'POST' && req.url === '/proxy') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw);
        const result = await proxy(body);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 0, error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PANEL_PORT, '127.0.0.1', () => {
  console.log(`面板:   http://127.0.0.1:${PANEL_PORT}  （浏览器打开）`);
  console.log(`上游:   ${upstream.url}  [${upstream.class}]${STRICT_SSRF ? '  --strict-ssrf 已启用' : ''}`);
});
