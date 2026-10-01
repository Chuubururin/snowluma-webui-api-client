// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { isCliEntry } from './lib/cli.js';
import { findUnionOverlaps } from './lib/oneof.js';
import { resolveLocalPointer } from './lib/pointer.js';
import { loadSpecGuardsSync, type SpecGuards } from './lib/upstream-guards.js';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import {
  normalizeParamForm,
  replayClassOf,
  SIDE_EFFECT_LABELS,
  VERIFICATION_STATUSES,
  type ReplayClass,
  type VerificationStatus,
} from './lib/tiers.js';

export interface SpecIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
}

const METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;

// 裁定 R18（实现批次）：匿名白名单 / 必标集 / uin 模式三样事实不再手抄，全部由
// tools/lib/upstream-guards.ts 从锚定的 server.ts 文本派生——匿名集 ← auth 中间件的豁免 if，
// 必标集 ← 处理器调用 invokeAction/invokeStream 的 POST 注册（裁定 R20：恰为设计口径的
// 两道闸门，不含 /api/debug/upload；其它 T3 缺标不报错、多标也不报错，故无反向规则），
// uin 模式 ← UIN_REGEX 正则字面量（记法差异在派生层显式规范化）。上游改动或抽取失败
// 一律抛错（绝不回退硬编码），校验器随之变红。validateSpecDoc 的第二个参数是测试缝：
// 突变副本经 deriveSpecGuards 从这里注入，规则对两套值完全同构。
let anchoredSpecGuards: SpecGuards | undefined;
const specGuards = (): SpecGuards => (anchoredSpecGuards ??= loadSpecGuardsSync());

// 裁定 R18：取值真源在 tiers.ts，这里只带类型引用，不再抄无类型的字面量副本
const REPLAY_CLASSES: readonly ReplayClass[] = ['t1', 't2', 't3'];
const STATIC_STATUSES: ReadonlySet<VerificationStatus> = new Set<VerificationStatus>([
  'static-only',
  'destructive-static-only',
]);

const err = (code: string, message: string): SpecIssue => ({ level: 'error', code, message });

const isRecord = (v: unknown): v is Record<string, any> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface ScanResult {
  refs: string[];
  /** 每条 $ref 出现位置的遍历路径 ——"谁引用了谁"要能回答，UNREFERENCED_SCHEMA 才不自指豁免 */
  refSites: { ref: string; path: string }[];
  constPaths: string[];
  arrayTypePaths: string[];
  cyclicPaths: string[];
  discriminatorPaths: string[];
  sideEffectDecls: { path: string; value: unknown }[];
}

// 一次遍历收齐六样全档扫描项：$ref（含引用位置）、const 命中路径、数组型 type 命中路径、
// 循环引用位置、discriminator 出现位置、x-snowluma-side-effects 声明。
// 循环防护用"当前递归栈"而非"已访问集"：YAML 锚点造成的共享子图（DAG）要照常扫描，
// 只有真正回到栈上的节点才判为循环——否则首轮评审实测的 RangeError 会把校验器换成核心转储。
function scanDocument(root: unknown): ScanResult {
  const refs: string[] = [];
  const refSites: { ref: string; path: string }[] = [];
  const constPaths: string[] = [];
  const arrayTypePaths: string[] = [];
  const cyclicPaths: string[] = [];
  const discriminatorPaths: string[] = [];
  const sideEffectDecls: { path: string; value: unknown }[] = [];
  const stack = new WeakSet<object>();
  const reported = new WeakSet<object>();

  // mode 描述"当前节点的身份"：mapping 表示该节点是某个 discriminator.mapping
  const walk = (node: unknown, path: string, mode: 'normal' | 'discriminator' | 'mapping'): void => {
    if (!Array.isArray(node) && !isRecord(node)) return; // 标量的引用语义在父层处理
    if (stack.has(node)) {
      if (!reported.has(node)) {
        reported.add(node);
        cyclicPaths.push(path);
      }
      return;
    }
    stack.add(node);
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${path}[${i}]`, 'normal'));
    } else {
      for (const [k, v] of Object.entries(node)) {
        // discriminator.mapping 的值在 3.0.3 里既可是 Ref Object 也可是"指向 schema 的字符串"，
        // 本计划（的 spike/minimal-spec.yaml）用的是后者，故这些字符串同样是引用目标，须并入解析
        if (mode === 'mapping' && typeof v === 'string') {
          if (v.startsWith('#')) {
            refs.push(v);
            refSites.push({ ref: v, path: `${path}.${k}` });
          }
          continue;
        }
        if (k === '$ref') {
          if (typeof v === 'string') {
            refs.push(v);
            refSites.push({ ref: v, path });
          }
          continue;
        }
        if (k === 'const') {
          constPaths.push(`${path}.${k}`);
          continue;
        }
        // 裁定 W6（终审修复波）：数组型 type（如 `type: [number, 'null']`）是 JSON Schema /
        // OpenAPI 3.1 的写法，3.0.3 的 Schema Object.type 只有字符串一形。它与 const、
        // discriminator 同属"3.0 词法表外"，此前只有 const 有执法点。不 continue：子树照走。
        if (k === 'type' && Array.isArray(v)) {
          arrayTypePaths.push(`${path}.${k}`);
        }
        if (k === 'x-snowluma-side-effects') {
          // 设计口径：声明位置不预设（operation 级是常态，path item / components 也收），
          // 值本身不参与 $ref 解析——词表标签是纯字符串，故在此截断递归。
          sideEffectDecls.push({ path: `${path}.${k}`, value: v });
          continue;
        }
        // 裁定 R22（终审 I3b）：全项目不写 discriminator——spike 预研实测三家生成器对它全部否定
        // （spike/findings.md Q1）。这里**不 continue**：子树仍要走，mapping 的字符串目标照旧进
        // refs——"这条不合法"与"它引用的东西存不存在"是两件事，同时报出才是诚实的诊断。
        // 反向不误伤：名为 discriminator 的**数据字段**（`properties.discriminator: {type: string}`）
        // 不是 Discriminator Object——3.0.3 里后者必带 propertyName，故带 type 而缺 propertyName 的
        // 视为字段声明放行；`{}` 与 `{mapping:…}` 这类写歪的仍判错。
        if (
          k === 'discriminator' &&
          isRecord(v) &&
          !('type' in v && !('propertyName' in v))
        ) {
          discriminatorPaths.push(`${path}.${k}`);
        }
        const childMode = k === 'discriminator' ? 'discriminator' : mode === 'discriminator' && k === 'mapping' ? 'mapping' : 'normal';
        walk(v, `${path}.${k}`, childMode);
      }
    }
    stack.delete(node);
  };

  walk(root, 'spec', 'normal');
  return { refs, refSites, constPaths, arrayTypePaths, cyclicPaths, discriminatorPaths, sideEffectDecls };
}

function referencedSchemes(security: unknown): string[] {
  const names: string[] = [];
  if (!Array.isArray(security)) return names;
  for (const requirement of security) {
    if (isRecord(requirement)) names.push(...Object.keys(requirement));
  }
  return names;
}

function parametersOf(pathItem: unknown, op: unknown, doc: unknown): unknown[] {
  const out: unknown[] = [];
  // 顺序即语义（终审 M2）：OpenAPI 规定 operation 级参数**覆盖**同 name + 同 in 的 path item 级
  // 参数，而唯一的调用方用 .find() 取第一个匹配项 ⇒ 先放的才是生效的那个。
  // 旧实现把 path item 排在前，于是"路径级写对 + 操作级写错"会静默放行——恰好漏掉
  // 客户端批次会批量写出的那种形状（路径级 $ref 打底、逐操作覆盖）。
  for (const holder of [op, pathItem]) {
    const list = isRecord(holder) ? holder.parameters : undefined;
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      // path item / operation 级 parameter 常写成 $ref；不可解析的引用在此视作"未声明"，
      // 由 DANGLING_REF 另行报告——两条规则同时命中是诚实的，spec 确实坏了两处
      if (isRecord(p) && typeof p.$ref === 'string' && p.$ref.startsWith('#')) {
        const target = resolveLocalPointer(doc, p.$ref);
        out.push(target.found ? target.value : undefined);
      } else {
        out.push(p);
      }
    }
  }
  return out;
}

export function validateSpecDoc(doc: unknown, guards: SpecGuards = specGuards()): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const d = (doc ?? {}) as Record<string, any>;
  // 三样 R18 派生集合在函数头解构一次，规则体照旧按原局部名消费（ANONYMOUS_ALLOWED 等），
  // 规则 ID / 消息形状 / 级别对相同输入保持不变。
      const { anonymousAllowed: ANONYMOUS_ALLOWED, destructiveRequired: DESTRUCTIVE_REQUIRED, uinParamPattern: UIN_PARAM_PATTERN, mustChangeAllowlist: MUST_CHANGE_ALLOWLIST, consentAllowlist: CONSENT_ALLOWLIST } = guards;

  if (d.openapi !== '3.0.3') issues.push(err('VERSION_NOT_3_0_3', `openapi 必须为 3.0.3，实际 ${d.openapi}`));

  // 结构底关：退化文档 / 顶层键名手误（如写成 endpoints:）不得带着零信号走到生成器
  if (!isRecord(d.paths) || Object.keys(d.paths).length === 0) {
    issues.push(err('MISSING_PATHS', '缺 paths 或其非对象/为空：spec 必须至少声明一条路径'));
  }
  if (!isRecord(d.info) || typeof d.info.title !== 'string' || d.info.title === '') {
    issues.push(err('MISSING_INFO', '缺 info.title（或不是非空字符串）'));
  }
  if (!isRecord(d.info) || typeof d.info.version !== 'string' || d.info.version === '') {
    issues.push(err('MISSING_INFO', '缺 info.version（或不是非空字符串）'));
  }

  const scan = scanDocument(d);

  for (const p of scan.constPaths) {
    issues.push(err('CONST_IN_OPENAPI_3_0', `OpenAPI 3.0 无 const 关键字（${p}），单值请用 enum: [值]`));
  }

  // 裁定 W6（终审修复波）：与 CONST_IN_OPENAPI_3_0 同一族的第三条 draft-4 事实。
  // 3.0.3 里 `number | null` 的写法是 type: number + nullable: true；
  // `type: [number, 'null']` 是 3.1 的词法。它此前对校验器与 lib/oneof.ts 的重叠检测双向隐形
  // （oneof.ts 的 matches 只认 typeof node.type === 'string'），等于把第三种"spec 撒谎"放行。
  for (const p of scan.arrayTypePaths) {
    issues.push(
      err(
        'ARRAY_TYPE_IN_OPENAPI_3_0',
        `OpenAPI 3.0.3 的 Schema Object.type 只接受字符串（${p} 写成了数组）。` +
          '可空数值请写 type: number 加 nullable: true（那是 3.1 数组型 type 的 3.0 对应物，设计口径）',
      ),
    );
  }

  for (const p of scan.cyclicPaths) {
    issues.push(err('CYCLIC_DOCUMENT', `文档在 ${p} 处循环引用（YAML 锚点自指），无法序列化为 JSON，也无法安全遍历`));
  }

  // 裁定 R22（终审 I3b 补上执法点）：位置逐条报出，消息给出退路形状，避免"报错但没说不许怎么办"。
  for (const p of scan.discriminatorPaths) {
    issues.push(
      err(
        'DISCRIMINATOR_FORBIDDEN',
        `裁定 R22：本项目不写 discriminator（${p}）。留在 OpenAPI 3.0.3 的退路是 oneOf + 各分支声明` +
          ` enum: [单值] 的 tag（设计口径/设计口径）；spike 预研实测三家生成器对 discriminator 全部否定` +
          `（spike/findings.md Q1）。`,
      ),
    );
  }

  // 设计口径的副作用词表关（终审 I3c）：真源是 lib/tiers.ts 的 SIDE_EFFECT_LABELS，
  // 与扫描器 CHECKERS 同源（side-effects-scan.test.ts 钉住两者逐位相等）。
  // 后果不是"少一条装饰"：设计口径的"GET 携带 external-fetch 永不自动重放"就骑在这个字符串上，
  // 拼错一个连字符（external_request）会让那道闸门静默失效，所以必须是 error。
  for (const { path, value } of scan.sideEffectDecls) {
    if (!Array.isArray(value)) {
      issues.push(
        err(
          'BAD_SIDE_EFFECT_DECL',
          `${path} 必须是标签数组（设计口径），实际是 ${JSON.stringify(value)}；` +
            '非数组形状会让按数组消费它的闸门（设计口径）静默漏判',
        ),
      );
      continue;
    }
    value.forEach((label, i) => {
      if (typeof label !== 'string' || !(SIDE_EFFECT_LABELS as readonly string[]).includes(label)) {
        issues.push(
          err(
            'UNKNOWN_SIDE_EFFECT_LABEL',
            `${path}[${i}] = ${JSON.stringify(label)} 不在扫描器词表内（可选值：${SIDE_EFFECT_LABELS.join(' | ')}）；` +
              '词表表达不了的效果写进该端点的说明文字，新增标签必须同步改 tools/side-effects-scan.ts 的 CHECKERS',
          ),
        );
      }
    });
  }

  // security 合法性（不只是"有没有"）：认证被设计钉死为 http/bearer，形状错了的后果是三家生成客户端同时坏
  const schemes = isRecord(d.components?.securitySchemes) ? d.components.securitySchemes : {};
  const schemeNames = new Set(Object.keys(schemes));
  for (const [name, raw] of Object.entries(schemes)) {
    const scheme = raw as Record<string, unknown> | undefined;
    if (!isRecord(scheme) || scheme.type !== 'http' || scheme.scheme !== 'bearer') {
      issues.push(
        err(
          'BAD_SECURITY_SCHEME_TYPE',
          `components.securitySchemes.${name} 必须 type: http 且 scheme: bearer（设计口径），实际 type=${String(scheme?.type)} / scheme=${String(scheme?.scheme)}`,
        ),
      );
    }
  }
  for (const name of referencedSchemes(d.security)) {
    if (!schemeNames.has(name)) issues.push(err('UNKNOWN_SECURITY_SCHEME', `全局 security 引用了未声明的 scheme：${name}`));
  }

  const seenIds = new Map<string, string>();
  const paths = isRecord(d.paths) ? (d.paths as Record<string, Record<string, any>>) : {};

  // 裁定 R19 的书写关（终审 I3a）：paths 键必须用 OpenAPI 的 {x} 模板，不接受 Express 的 :x。
  // 归一化（normalizeParamForm）只解决"两侧书写不同时怎么比"，它对 :uin 是**恒等映射**，
  // 所以光有归一化时，一整份用 :uin 写的 spec 会 0 error 通过，而三家生成器都把 :uin 当字面量段。
  // 推论（tools/check-drift.test.ts 已钉住）：两种形式在同一份 spec 里共存时会折叠成同一个键，
  // 互相抵消成零漂移——本规则让那种 spec 不可表示，代价是不区分"参数"与"字面量里真出现冒号"，
  // 本项目 55 条路径无后者，且冒号进路径对生成器同样是 hazard，故一律判错。
  for (const path of Object.keys(paths)) {
    const express = path.match(/:[A-Za-z_][A-Za-z0-9_]*/);
    if (express) {
      issues.push(
        err(
          'EXPRESS_PATH_PARAM',
          `paths 键 ${path} 用了 Express 风格的 ${express[0]}（裁定 R19）：OpenAPI 3.0 路径模板必须写成 {name}，` +
            '否则生成器把它当字面量段，且漂移检查会把它与 {name} 形式折叠成同一个键',
        ),
      );
    }
  }

  for (const [path, ops] of Object.entries(paths)) {
    for (const method of METHODS) {
      const op = ops?.[method];
      if (!op || !isRecord(op)) continue;
      const where = `${method.toUpperCase()} ${path}`;
      // 裁定 R19：spec 按 OpenAPI path templating 写 {uin}，tiers.ts 的键是 Express 的 :uin，
      // 比较前必须过唯一真源归一化——否则恰恰是最需要交叉核对的那几条端点静默退化成 UNCLASSIFIED_OP
      const specPath = normalizeParamForm(path);

      if (typeof op.operationId !== 'string' || !op.operationId) {
        issues.push(err('MISSING_OPERATION_ID', `${where} 缺 operationId`));
      } else {
        const prior = seenIds.get(op.operationId);
        if (prior) issues.push(err('DUPLICATE_OPERATION_ID', `${op.operationId} 同时用于 ${prior} 与 ${where}`));
        else seenIds.set(op.operationId, where);
      }

      const declared = op['x-replay-class'] as ReplayClass | undefined;
      if (!declared) issues.push(err('MISSING_REPLAY_CLASS', `${where} 缺 x-replay-class`));
      else if (!REPLAY_CLASSES.includes(declared)) {
        issues.push(err('BAD_REPLAY_CLASS', `${where} x-replay-class 非法：${declared}`));
      } else {
        let truth: ReplayClass | null = null;
        try {
          truth = replayClassOf({ method: method.toUpperCase(), path: specPath, file: '', line: 0 });
        } catch {
          issues.push(err('UNCLASSIFIED_OP', `${where} 不在 tools/lib/tiers.ts 清单内`));
        }
        if (truth && truth !== declared) {
          issues.push(err('TIER_MISMATCH', `${where} 标为 ${declared}，真源为 ${truth}`));
        }
      }

      const vs = op['x-verification-status'];
      if (!vs) issues.push(err('MISSING_VERIFICATION_STATUS', `${where} 缺 x-verification-status`));
      else if (!VERIFICATION_STATUSES.includes(vs as VerificationStatus)) {
        issues.push(err('BAD_VERIFICATION_STATUS', `${where} x-verification-status 非法：${vs}`));
      } else if (declared === 't3' && !STATIC_STATUSES.has(vs)) {
        issues.push(err('T3_STATUS_MUST_NOT_BE_VERIFIED', `${where} 属 T3 却标 ${vs}；T3 只能静态验证`));
      }

      const isDestructiveRequired = DESTRUCTIVE_REQUIRED.some((p) => specPath === p || specPath.startsWith(`${p}/`));
      if (isDestructiveRequired && op['x-snowluma-destructive'] !== true) {
        issues.push(err('MISSING_DESTRUCTIVE_FLAG', `${where} 必须标 x-snowluma-destructive: true`));
      }

      const anonymous = Array.isArray(op.security) && op.security.length === 0;
      if (anonymous && !ANONYMOUS_ALLOWED.has(specPath)) {
        issues.push(err('UNEXPECTED_ANONYMOUS_OP', `${where} 显式 security: [] 但不在匿名白名单内`));
      }

      if (!ANONYMOUS_ALLOWED.has(specPath) && !anonymous && !op.security && !d.security) {
        issues.push({
          level: 'warning',
          code: 'NO_SECURITY_DECLARED',
          message: `${where} 既无 operation 级也无全局 security`,
        });
      }

      for (const name of referencedSchemes(op.security)) {
        if (!schemeNames.has(name)) {
          issues.push(err('UNKNOWN_SECURITY_SCHEME', `${where} 的 security 引用了未声明的 scheme：${name}`));
        }
      }

      // X1（P3-4 句尾）：allowlist 命中即中间件 403 该分支永久不可达（N6），故在表路径
      // 声明 AuthGate403 必错。只认状态码下直挂 `$ref: '#/components/responses/AuthGate403'`
      // 这一形；ConsentGate403（consent 支对 allowlist 内路径可达）不在射程。
      // 两张表来自派生守卫（upstream-guards.ts），此处不抄第二份。
      if (MUST_CHANGE_ALLOWLIST.includes(specPath) || CONSENT_ALLOWLIST.includes(specPath)) {
        const responses = isRecord(op.responses) ? Object.values(op.responses) : [];
        if (responses.some((r) => isRecord(r) && r.$ref === '#/components/responses/AuthGate403')) {
          issues.push(
            err(
              'ALLOWLISTED_AUTHGATE403',
              `${where} 在 allowlist 内，中间件 403（双闸）对其永久不可达（N6），不得引用 AuthGate403；consent 闸可达的用 ConsentGate403`,
            ),
          );
        }
      }

      // 设计口径硬规则：凡路径含 uin 参数，必须声明该参数并带精确 pattern（非法值要在发出前失败）。
      // 归属校验器而非漂移检查：这是"spec 写错了"，不是"spec 与上游不一致"。
      if (/\/:uin(?:\/|$)/.test(specPath)) {
        const uinParam = parametersOf(ops, op, d)
          .filter(isRecord)
          .find((p) => p.name === 'uin' && p.in === 'path');
        const actual = uinParam?.schema?.pattern;
        if (!uinParam || actual !== UIN_PARAM_PATTERN) {
          issues.push(
            err(
              'UIN_PATTERN',
              `${where} 的 uin path parameter 必须声明 pattern: '${UIN_PARAM_PATTERN}'（设计口径），实际 ${uinParam ? `pattern=${JSON.stringify(actual)}` : '未声明 name: uin / in: path 的参数'}`,
            ),
          );
        }
      }

      // 裁定 R2（设计口径缺口 16）：流端点的 WithResponse 警告规则此前只认内联
      // responses['200'].content —— 200 写成 components/responses 的 $ref 时该操作被静默
      // 跳过，而反真空 guard 仍被其它内联流（/api/state/stream）满足，整条规则永不红。
      // 这里恰好解一层 '#/components/responses/…' 再判（不建通用 $ref 解析，其它规则的
      // 引用语义一律不动）；解不到 = 本规则对 200 内容"看不见"，报 warning 而非沉默 ——
      // 沉默跳过正是这条缺陷的原形。执法曾只活在测试层（validate-spec.test.ts 的 W5 用例），
      // 收进校验器后 CLI 对同一份 spec 同步发声。
      const resp200 = isRecord(op.responses) ? op.responses['200'] : undefined;
      let effResp200: unknown = resp200;
      if (isRecord(resp200) && typeof resp200.$ref === 'string' && resp200.$ref.startsWith('#/components/responses/')) {
        const target = resolveLocalPointer(d, resp200.$ref);
        if (target.found) {
          effResp200 = target.value;
        } else {
          issues.push({
            level: 'warning',
            code: 'SSE_200_REF_UNRESOLVED',
            message:
              `${where} 的 200 走了 ${resp200.$ref}，本规则解不到它、对 200 内容"看不见"：` +
              'text/event-stream 与否判不了，WithResponse 警告要求可能被静默绕过。修法二选一：' +
              '①把该响应补进 components.responses；②把 200 内联写出。',
          });
        }
      }
      if (isRecord(effResp200) && isRecord(effResp200.content) && 'text/event-stream' in effResp200.content) {
        const desc = typeof op.description === 'string' ? op.description : '';
        if (!desc.includes('WithResponse')) {
          issues.push({
            level: 'warning',
            code: 'SSE_WITHRESPONSE_UNWARNED',
            message:
              `${where}（${String(op.operationId ?? '无 operationId')}）的 200 是 text/event-stream，` +
              'description 却没警告 WithResponse：oapi-codegen 的 *WithResponse 便捷路径实测是 ' +
              'io.ReadAll(rsp.Body) + Close（StreamStateWithResponse 的 ParseStreamStateResponse），' +
              '对长连接等于缓冲完整条流再关闭 —— 流当场死亡；且裸 Response 结构里没有 200 字段，' +
              '缓冲"成功"也拿不到帧。description 是三家生成物唯一都携带的警告通道（终审 W5）：' +
              '照 /api/state/stream 的 description 补一段，再谈别的。',
          });
        }
      }
    }
  }

  for (const ref of scan.refs) {
    // 外部 $ref（http(s):// 或相对文件路径）显式跳过：校验器不联网、不读盘，也不引入外部校验库；
    // 本计划的 spec 全档只用本地引用，真要到外部资源时由的三家生成器负责取并报错。
    // 同理跳过的还有非 '#' 开头的 discriminator.mapping 裸名（3.0.3 允许写 schema 名而非引用）
    if (!ref.startsWith('#')) continue;
    if (!resolveLocalPointer(d, ref).found) issues.push(err('DANGLING_REF', `$ref 目标不存在：${ref}`));
  }

  // 裁定 W1（终审修复波）：DANGLING_REF 的反方向。出边全部有目标 ≠ 每个 schema 都有人用——
  // 零 $ref 的 components.schemas 条目会被三家生成器原样导出（OperationError 当时就在
  // generated/typescript/index.ts 的导出清单里），而 Go 批次要照着设计口径的词表再写 43 条操作：
  // 一份"已发布但没人引用"的信封一定会被 imitation 复用，这正是当初 OperationError 的成名路径。
  // 修法两选一（错误消息里写明）：删除，或带非空字符串 `x-unreferenced-ok: '理由+取证计划'`
  // 显式声明为有意的前向引用。自引用不算被使用（LoginResult 里指自己不证明外面有人消费它）。
  const schemaDefs = isRecord(d.components?.schemas) ? d.components.schemas : {};
  for (const [name, def] of Object.entries(schemaDefs)) {
    // JSON pointer 转义（~→~0、/→~1）：$ref 里写的是转义形，schema 键名是原始形，不转义会误判孤儿
    const pointer = `#/components/schemas/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    const selfPrefix = `spec.components.schemas.${name}`;
    const used = scan.refSites.some(
      ({ ref, path }) =>
        ref === pointer && !(path === selfPrefix || path.startsWith(`${selfPrefix}.`) || path.startsWith(`${selfPrefix}[`)),
    );
    if (used) continue;
    const exempt = isRecord(def) ? (def as Record<string, unknown>)['x-unreferenced-ok'] : undefined;
    if (typeof exempt !== 'string' || exempt.trim() === '') {
      issues.push(
        err(
          'UNREFERENCED_SCHEMA',
          `components.schemas.${name} 全档零 $ref —— 已发布却无人引用的契约会被生成器导出、被后续操作模仿引用` +
            `（终审 W1 的 OperationError 即此形状，其证据只有 client.ts:39 的防御性读取，设计口径禁止当契约证据）。` +
            `二选一：①删除该条目；②确属有意的前向声明，则加非空字符串 x-unreferenced-ok: '理由 + 何时以何锚点转 $ref 消费'`,
        ),
      );
    }
  }

  // 裁定 R24（评审 R1）：oneOf 的语义是"恰好一支"。分支没关死时，服务端真实的
  // 超集响应会同时命中两支 ⇒ 合规客户端拒收自家服务的正常回复，而本校验器在此之前
  // 对这种 spec 报 0 error / 0 warning。执法点必须是"举得出实例"才报，见 lib/oneof.ts 的注释。
  for (const o of findUnionOverlaps(d)) {
    issues.push(
      err(
        'ONEOF_BRANCH_OVERLAP',
        `${o.at} 声明了 oneOf，但实例 ${o.witness} 同时满足 ${o.a} 与 ${o.b} 两支；` +
          `oneOf 要求恰好一支，这条真实响应会被合规客户端拒收。收口办法二选一：` +
          `①给其中一支加 additionalProperties: false；②两支都把 tag 键写进 required 且该键的 enum 单值互斥` +
          `（设计口径）。注意 ②里漏掉 required 不算关死 —— tag 键可选时 \`{}\` 照样同时命中两支，` +
          `本仓库 tools/validate-spec.test.ts 的 R22 内联用例就是这么红的`,
      ),
    );
  }

  return issues;
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  const target = process.argv[2];
  if (!target) {
    console.error('用法：tsx tools/validate-spec.ts <spec.yaml>');
    process.exit(2);
  }
  let doc: unknown;
  try {
    doc = parse(await readFile(target, 'utf8'));
  } catch (e) {
    console.error(`无法读取或解析 ${target}：${(e as Error).message}`);
    process.exit(2);
  }
  const issues = validateSpecDoc(doc);
  for (const i of issues) console.log(`${i.level.toUpperCase()} [${i.code}] ${i.message}`);
  const errors = issues.filter((i) => i.level === 'error').length;
  console.log(`${target}: ${errors} error / ${issues.length - errors} warning`);
  if (errors > 0) process.exit(1);
}
