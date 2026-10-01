// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

export interface SpecIR {
  operations: OperationIR[];
  schemas: Record<string, SchemaIR>;
}

export interface OperationIR {
  operationId: string;
  method: 'get' | 'post' | 'put' | 'delete';
  path: string;
  tags: string[];
  summary: string;
  isSSE: boolean;
  requestBody?: SchemaIR;
  responseSchema?: SchemaIR;
  queryParams: ParamIR[];
  pathParams: ParamIR[];
  isGate: boolean;
  securityOptional: boolean;
}

export interface SchemaIR {
  type?: string;
  format?: string;
  properties?: Record<string, SchemaIR>;
  items?: SchemaIR;
  enum?: string[];
  required?: string[];
  $ref?: string;
  description?: string;
  oneOf?: SchemaIR[];
  additionalProperties?: boolean | SchemaIR;
  maxLength?: number;
}

export interface ParamIR {
  name: string;
  schema: SchemaIR;
  required: boolean;
}

const GATE_OPERATION_IDS = new Set([
  'login', 'logout', 'getAuthState', 'changePassword',
  'checkPasswordStrength', 'getAgreements', 'recordConsent',
  'getPublicUiAppearance',
]);

export function parseSpec(specPath: string): SpecIR {
  const raw = readFileSync(specPath, 'utf-8');
  const doc = parseYaml(raw) as Record<string, unknown>;
  const schemas = extractSchemas(doc);
  const operations = extractOperations(doc);
  return { operations, schemas };
}

function extractSchemas(doc: Record<string, unknown>): Record<string, SchemaIR> {
  const components = doc.components as Record<string, unknown> | undefined;
  const raw = (components?.schemas ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, SchemaIR> = {};
  for (const [name, schema] of Object.entries(raw)) {
    out[name] = normalizeSchema(schema);
  }
  return out;
}

export function normalizeSchema(raw: Record<string, unknown>): SchemaIR {
  const s: SchemaIR = {};
  if (typeof raw.type === 'string') s.type = raw.type;
  if (typeof raw.format === 'string') s.format = raw.format;
  if (Array.isArray(raw.enum)) s.enum = raw.enum as string[];
  if (Array.isArray(raw.required)) s.required = raw.required as string[];
  if (typeof raw.description === 'string') s.description = raw.description;
  if (typeof raw.maxLength === 'number') s.maxLength = raw.maxLength;
  if (raw.additionalProperties !== undefined) {
    s.additionalProperties = typeof raw.additionalProperties === 'boolean'
      ? raw.additionalProperties
      : normalizeSchema(raw.additionalProperties as Record<string, unknown>);
  }
  if (typeof raw.$ref === 'string') {
    s.$ref = raw.$ref;
    return s;
  }
  if (Array.isArray(raw.oneOf)) {
    s.oneOf = (raw.oneOf as Record<string, unknown>[]).map(normalizeSchema);
  }
  if (raw.properties && typeof raw.properties === 'object') {
    s.properties = {};
    for (const [k, v] of Object.entries(raw.properties as Record<string, unknown>)) {
      s.properties[k] = normalizeSchema(v as Record<string, unknown>);
    }
  }
  if (raw.items && typeof raw.items === 'object') {
    s.items = normalizeSchema(raw.items as Record<string, unknown>);
  }
  return s;
}

function extractOperations(doc: Record<string, unknown>): OperationIR[] {
  const ops: OperationIR[] = [];
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, raw] of Object.entries(methods)) {
      if (['get', 'post', 'put', 'delete'].indexOf(method) === -1) continue;
      const spec = raw as Record<string, unknown>;
      if (typeof spec.operationId !== 'string') continue;
      ops.push({
        operationId: spec.operationId,
        method: method as OperationIR['method'],
        path,
        tags: Array.isArray(spec.tags) ? spec.tags as string[] : [],
        summary: typeof spec.summary === 'string' ? spec.summary : '',
        isSSE: hasSseResponse(spec, doc),
        requestBody: extractRequestBody(spec),
        responseSchema: extractResponseSchema(spec),
        queryParams: extractParams(spec, 'query'),
        pathParams: extractParams(spec, 'path'),
        isGate: GATE_OPERATION_IDS.has(spec.operationId),
        securityOptional: Array.isArray(spec.security) && (spec.security as unknown[]).length === 0,
      });
    }
  }
  return ops;
}

function hasSseResponse(spec: Record<string, unknown>, doc: Record<string, unknown>): boolean {
  // 200 写成 $ref（spec/fixtures/sse-ref.yaml 的形状）时解一层再判，与 validate-spec 的
  // R2 同一裁定：不解的话流操作会被词表标成非流，ui-coverage 反过来要求 unwrap——
  // 同一份 spec，两条链路各说各话，且只在"有人改了写法"那天才会暴露。
  const components = doc.components as Record<string, unknown> | undefined;
  const namedResponses = (components?.responses ?? {}) as Record<string, Record<string, unknown>>;
  const responses = (spec.responses ?? {}) as Record<string, Record<string, unknown>>;
  for (const resp of Object.values(responses)) {
    const target =
      typeof resp?.$ref === 'string'
        ? namedResponses[resp.$ref.replace(/^#\/components\/responses\//, '')] ?? resp
        : resp;
    const content = (target?.content ?? {}) as Record<string, unknown>;
    if ('text/event-stream' in content) return true;
  }
  return false;
}

function extractRequestBody(spec: Record<string, unknown>): SchemaIR | undefined {
  const rb = spec.requestBody as Record<string, unknown> | undefined;
  if (!rb) return undefined;
  const content = (rb.content ?? {}) as Record<string, Record<string, unknown>>;
  const json = content['application/json'];
  if (!json?.schema) return undefined;
  return normalizeSchema(json.schema as Record<string, unknown>);
}

function extractResponseSchema(spec: Record<string, unknown>): SchemaIR | undefined {
  const responses = (spec.responses ?? {}) as Record<string, Record<string, unknown>>;
  const ok = responses['200'];
  if (!ok) return undefined;
  const content = (ok.content ?? {}) as Record<string, Record<string, unknown>>;
  const json = content['application/json'];
  if (!json?.schema) return undefined;
  return normalizeSchema(json.schema as Record<string, unknown>);
}

function extractParams(spec: Record<string, unknown>, location: 'query' | 'path'): ParamIR[] {
  const params = (spec.parameters ?? []) as Record<string, unknown>[];
  return params
    .filter(p => p.in === location)
    .map(p => ({
      name: p.name as string,
      schema: normalizeSchema((p.schema ?? {}) as Record<string, unknown>),
      required: !!p.required,
    }));
}
