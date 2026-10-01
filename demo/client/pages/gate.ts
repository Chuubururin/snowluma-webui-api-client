// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
/**
 * 门禁屏（设计口径）：登录 → 同意闸 → 改密闸 → 主界面。
 * 客户端只做两件事：按 `step` 画对应那一屏，把写操作交给服务端路由。凭据只单向离开浏览器
 * （改密要的 oldPassword 由服务端从登录时留存的口令注入，浏览器永远拿不回去）。
 * `gateStep` 与服务端 `demo/server/routes/gates.ts` 的 `stepOf` 同形不是重复实现：
 * 浏览器包不能 import 服务端模块，两者之间的契约是响应体里的布尔键。
 */
import { ApiError, call, post } from '../api.js';
import { esc } from '../ui.js';

export type GateStep = 'login' | 'totp' | 'consent' | 'password' | 'relogin' | 'app' | 'unknown';

/** spec 的 AgreementDoc 五键恒 required（consent.ts:170），此处按可缺键渲染：线上一旦缺键要看得见而不是崩。 */
export interface AgreementDoc {
  id?: string;
  title?: string;
  declaredVersion?: string;
  effectiveDate?: string;
  text?: string;
}

/** 实码形状 `{ id, label, ok }`（webui/src/components/pages/change-password-form.tsx:15-18）。 */
export interface PasswordRule {
  id?: string;
  label?: string;
  ok?: boolean;
}

export interface GateModel {
  step?: string;
  message?: string;
  version?: string;
  currentVersion?: string;
  documents?: AgreementDoc[];
  rules?: PasswordRule[];
  requireRelogin?: boolean;
  status?: unknown;
}

export interface GateActions {
  login?(v: { password: string; totp?: string }): void;
  consent?(): void;
  password?(newPassword: string): void;
  strength?(password: string): void;
  retry?(): void;
  /** 显式知悉"门禁读不出来"并继续 —— 由服务端记账（`POST /gate/acknowledge`），不是本地遮羞。 */
  ack?(): void;
  relogin?(): void;
}

/**
 * 优先级：同意 > 改密 > 进主界面。两键任一不是布尔就落 'unknown'——上游 `mustChangePassword()`
 * 出错时静默返回 false（client.ts:547-549），demo 有意不学（declination must-change-password-silent-false）：
 * 缺键既不放行也不拦死，交给操作者自己决定。
 */
export function gateStep(g: { consentRequired?: boolean; mustChangePassword?: boolean }): GateStep {
  if (typeof g.consentRequired !== 'boolean' || typeof g.mustChangePassword !== 'boolean') return 'unknown';
  if (g.consentRequired) return 'consent';
  if (g.mustChangePassword) return 'password';
  return 'app';
}

const TITLES: Record<GateStep, string> = {
  login: '登录实例',
  totp: '第二因子',
  consent: '请先阅读并同意协议',
  password: '请先修改密码',
  relogin: '密码已修改',
  app: '门禁已通过',
  unknown: '无法确认门禁状态',
};

export function renderGate(el: HTMLElement, model: GateModel, actions: GateActions = {}): void {
  const step = normalize(model);
  const html: string[] = ['<h2 id="gateTitle">' + esc(TITLES[step]) + '</h2>'];
  if (model.message) html.push('<div class="err" id="gateError">' + esc(model.message) + '</div>');
  if (step === 'login' || step === 'totp') html.push(loginForm(step));
  else if (step === 'consent') html.push(consentForm(model));
  else if (step === 'password') html.push(passwordForm(model));
  else if (step === 'relogin') {
    html.push('<p>上游要求用新密码重新登录（旧会话已作废）。</p><button id="reloginButton" type="button">返回登录</button>');
  } else if (step === 'unknown') {
    // 设计口径的"允许继续"：读不到闸状态时不像上游那样当作放行，而是把决定权交回操作者，
    // 且由服务端记账（POST /gate/acknowledge）—— 本地遮羞不算继续。
    html.push(
      '<p>上游没有给出 <code>consentRequired</code> / <code>mustChangePassword</code>，' +
        '无法确认两道闸是否已通过。上游把这种情形静默当作"不需改密"放行，demo 不学它。</p>' +
        '<button id="gateRetry" type="button">重新读取门禁状态</button>' +
        '<button id="gateAck" type="button">我已知道，显式继续进入主界面</button>',
    );
  } else {
    html.push('<p id="gatePassed">两道闸都已通过。</p>');
  }
  el.innerHTML = html.join('');
  wire(el, step, actions);
}

/** 服务端把 step 一起回；只有 login/totp 两屏允许从"有口令"这一事实推断。 */
function normalize(model: GateModel): GateStep {
  const known: GateStep[] = ['login', 'totp', 'consent', 'password', 'relogin', 'app', 'unknown'];
  return known.includes(model.step as GateStep) ? (model.step as GateStep) : 'unknown';
}

function loginForm(step: GateStep): string {
  const totpField =
    step === 'totp'
      ? '<div class="row"><label for="totp">认证器上的 6 位验证码</label>' +
        '<input id="totp" name="totp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" />' +
        '<p class="hint">上游对验证码严格比较"新于上次用掉的那一步"：没通过时请等认证器生成新码，不是口令错了。</p></div>'
      : '';
  return (
    '<form id="loginForm">' +
    '<div class="row"><label for="password">管理口令</label>' +
    '<input id="password" name="password" type="password" autocomplete="current-password" required /></div>' +
    totpField +
    '<button id="loginSubmit" type="submit">登录</button>' +
    '</form>'
  );
}

function consentForm(model: GateModel): string {
  const docs = model.documents ?? [];
  // 版本不符（409）时**只留重取**这一条路：勾选框与提交按钮一并撤掉，
  // 否则人可以拿手里那份旧 version 反复撞 409，而设计口径要的是"先重读再同意"。
  if (model.currentVersion && model.currentVersion !== model.version) {
    return (
      '<div class="err">条款已更新到 <code>' +
      esc(model.currentVersion) +
      '</code>（手里这份是 <code>' +
      esc(model.version ?? '') +
      '</code>），必须重读后再同意。</div>' +
      '<button id="consentReload" type="button">重新读取条款</button>'
    );
  }
  const list = docs.length
    ? docs
        .map(
          (d) =>
            '<section class="doc"><h3>' +
            esc(d.title || d.id || '(未命名条款)') +
            '</h3><p class="meta">版本 <code>' +
            esc(d.declaredVersion ?? '') +
            '</code> · 生效 ' +
            esc(d.effectiveDate ?? '') +
            '</p><pre class="body">' +
            esc(d.text ?? '(条款正文为空)') +
            '</pre></section>',
        )
        .join('')
    : '<p class="err">上游没有给出任何条款文档。</p>';
  return (
    '<div id="agreementDoc">' +
    list +
    '</div>' +
    // 同意绝不代做：勾选框在浏览器里没被点过，提交按钮就一直是 disabled（设计口径）
    '<label class="agree" for="agreeCheckbox"><input type="checkbox" id="agreeCheckbox" /> 我已阅读并同意上述条款</label>' +
    '<button id="consentSubmit" type="button" disabled>我已阅读并同意，提交</button>'
  );
}

function passwordForm(model: GateModel): string {
  return (
    '<form id="passwordForm">' +
    '<div class="row"><label for="newPassword">新密码</label>' +
    '<input id="newPassword" name="newPassword" type="password" autocomplete="new-password" required /></div>' +
    '<div class="row"><label for="confirmPassword">确认新密码</label>' +
    '<input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required /></div>' +
    // 规则清单按 spec 的 rules 数组逐条画；上游没有 score 字段，所以这里也没有进度条（设计口径）
    '<ul id="strengthRules">' +
    (model.rules ?? []).map((r) => ruleItem(r)).join('') +
    '</ul>' +
    '<div id="strengthValid" class="hint"></div>' +
    '<button id="passwordSubmit" type="submit" disabled>修改密码</button>' +
    '</form>'
  );
}

function ruleItem(r: PasswordRule): string {
  const text = r.label ?? r.id ?? JSON.stringify(r);
  // 状态不能只靠 CSS 类表达：本 demo 不引主题/样式表（视觉系统整块不在目标里），
  // 只挂 class 的话清单在浏览器里是平的，"哪条没满足"根本读不出来。
  const state = r.ok ? '已满足' : '未满足';
  return (
    '<li data-rule="' + esc(r.id ?? '') + '" class="' + (r.ok ? 'ok' : 'no') + '">' +
    (r.ok ? '✓ ' : '✗ ') + esc(text) + '（' + state + '）</li>'
  );
}

/** 只重画规则清单：整屏重绘会把用户正在敲的口令抹掉。 */
export function renderRules(el: HTMLElement, rules: PasswordRule[], valid?: boolean): void {
  el.innerHTML = rules.map((r) => ruleItem(r)).join('');
  const flag = document.getElementById('strengthValid');
  if (flag) flag.textContent = valid === true ? '满足全部规则' : '仍有规则未满足';
}

function wire(el: HTMLElement, step: GateStep, actions: GateActions): void {
  const on = (id: string, type: string, fn: () => void) => {
    const node = el.ownerDocument.getElementById(id);
    if (node) node.addEventListener(type, (e) => { e.preventDefault(); fn(); });
  };
  if (step === 'login' || step === 'totp') {
    on('loginForm', 'submit', () => {
      const value = (id: string) => String((document.getElementById(id) as HTMLInputElement | null)?.value ?? '');
      const v: { password: string; totp?: string } = { password: value('password') };
      // spec 的 login requestBody（生成类型 LoginData）只有 password 与可选 totp：
      // 空串不上行 —— 上游会把它当成一次错误的第二因子（server.ts:689 的 bad-second-factor 支）
      if (value('totp')) v.totp = value('totp');
      actions.login?.(v);
    });
    return;
  }
  if (step === 'consent') {
    const box = document.getElementById('agreeCheckbox') as HTMLInputElement | null;
    const submit = document.getElementById('consentSubmit') as HTMLButtonElement | null;
    if (box && submit) {
      box.addEventListener('change', () => {
        submit.disabled = !box.checked;
      });
    }
    on('consentSubmit', 'click', () => {
      // 上行的 version 由挂载处持有：它必须是本会话 getAgreements 给的那一份，客户端不自拼
      actions.consent?.();
    });
    on('consentReload', 'click', () => actions.retry?.());
    return;
  }
  if (step === 'password') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    on('passwordForm', 'submit', () => {
      const np = String((document.getElementById('newPassword') as HTMLInputElement | null)?.value ?? '');
      actions.password?.(np);
    });
    const newInput = document.getElementById('newPassword');
    const confirmInput = document.getElementById('confirmPassword') as HTMLInputElement | null;
    const submit = document.getElementById('passwordSubmit') as HTMLButtonElement | null;
    const checkMatch = () => {
      if (!submit || !confirmInput || !newInput) return;
      const a = (newInput as HTMLInputElement).value;
      submit.disabled = a.length === 0 || a !== confirmInput.value;
    };
    newInput?.addEventListener('input', () => {
      checkMatch();
      const pw = (newInput as HTMLInputElement).value;
      if (timer) clearTimeout(timer);
      if (!pw) return;
      // 强度要问上游（规则在上游代码里，客户端抄一份就成了两套真相），故去抖后发一次
      timer = setTimeout(() => actions.strength?.(pw), 250);
    });
    confirmInput?.addEventListener('input', checkMatch);
    return;
  }
  if (step === 'relogin') {
    on('reloginButton', 'click', () => actions.relogin?.());
    return;
  }
  if (step === 'unknown') {
    on('gateRetry', 'click', () => actions.retry?.());
    on('gateAck', 'click', () => actions.ack?.());
    return;
  }
}

/**
 * 挂载门禁屏：先问一次门禁状态（会话还活着就能直接落到该去的那一屏），
 * 401/403 的错误体里也带 step，与 2xx 走同一条渲染路径。
 */
export function mountGate(host: HTMLElement, onPass: (model: GateModel) => void): { refresh(): void } {
  let model: GateModel = { step: 'login' };
  let version = '';

  // 重绘保留已敲入口令：上游登录页也是这么做的（LoginPage 的 initialPassword 入参），
  // 否则一次"验证码不正确"就把人刚打的那串抹了。改密屏同理——提交失败（如强度不足回 400）
  // 也走 paint()，只保 #password 的话 newPassword/confirm 照样被抹。
  const paint = () => {
    const preserve = ['password', 'newPassword', 'confirmPassword']
      .map((id) => ({ id, value: String((document.getElementById(id) as HTMLInputElement | null)?.value ?? '') }))
      .filter((f) => f.value !== '');
    renderGate(host, model, actions);
    for (const f of preserve) {
      const field = document.getElementById(f.id) as HTMLInputElement | null;
      if (field) field.value = f.value;
    }
  };
  const apply = (next: GateModel) => {
    // 错误体只带"决定这一步的那几个键"（409 就只有 step/message/currentVersion），
    // 条款文档与手里那份 version 必须留着 —— 整份替换会让屏上刚读到的条款突然消失。
    const merged: GateModel = { documents: model.documents, version: model.version, status: model.status, ...next };
    if (typeof merged.version === 'string' && merged.version) version = merged.version;
    model = merged;
    // 两键齐全且都为 false 才算过闸；'app' 只在服务端也判 'app' 时才交出主界面
    if (merged.step === 'app') {
      onPass(merged);
      return;
    }
    paint();
  };
  // 成功与失败都要过 apply：只挂 .catch 的话，2xx 的响应体会被丢掉、门禁屏永远停在"加载中…"
  // （浏览器实测踩过这一条，故 tools/demo-gate-machine.test.ts 用 mountGate + fetch 桩把它钉住）
  const guarded = (fn: () => Promise<GateModel>) =>
    fn().then(apply, (e: unknown) => {
      if (e instanceof ApiError && e.body && typeof e.body === 'object') {
        apply({ ...(e.body as GateModel), message: (e.body as GateModel).message ?? e.message });
        return;
      }
      apply({ step: 'unknown', message: String(e) });
    });

  const actions: GateActions = {
    login: (v) => guarded(() => post<GateModel>('/gate/login', v)),
    // 勾选框只决定按钮可否点；真正上行的版本是本会话读到的那一份（同意绝不代做）
    consent: () => guarded(() => post<GateModel>('/gate/consent', { version })),
    password: (np) => guarded(() => post<GateModel>('/gate/password', { newPassword: np })),
    // 强度只重画规则清单：整屏重绘会抹掉用户正在敲的口令。问不出强度也只落在强度位——
    // 这里曾走 apply，gateReject 的 {step:'password'} 回来就是一次 paint()，
    // 把正在敲的 newPassword/confirm 整个抹掉（同一防线的错误腿漏防）。
    strength: (pw) => {
      post<{ rules?: PasswordRule[]; valid?: boolean }>('/gate/strength', { password: pw })
        .then((r) => {
          const list = document.getElementById('strengthRules');
          if (list) renderRules(list, r.rules ?? [], r.valid);
        })
        .catch((e: unknown) => {
          const flag = document.getElementById('strengthValid');
          if (flag) flag.textContent = e instanceof Error ? `强度查询失败：${e.message}` : String(e);
        });
    },
    retry: () => guarded(() => call<GateModel>('/gate/state')),
    ack: () => guarded(() => post<GateModel>('/gate/acknowledge', {})),
    relogin: () => {
      model = { step: 'login' };
      version = '';
      paint();
    },
  };

  guarded(() => call<GateModel>('/gate/state'));
  return { refresh: paint };
}
