/**
 * **宿主载荷的唯一收窄点** —— 把「HTTP 信封说 ok」与「`value` 形状真的是我们声明的那个」
 * 这两件事分开。
 *
 * ## 为什么需要它(这是一天内发生两次的同一类故障)
 *
 * `api.ts` 的 `call<T>()` 只保证**信封**(`{ok:true,value}`)合法;`value` 的形状来自
 * 我们的**静态声明**,没有任何运行时保证。版本偏斜(host 半要重启才更新)、路由改名、
 * 桩/代理回了 `{}`,都会让 `value.x` 变成 `undefined`,然后在下游**渲染期**炸掉:
 *
 * | # | 现场 | 症状 |
 * |---|---|---|
 * | 1 | `auth/emails` 少了 `emails` | `emails.map(...)` 抛 TypeError ⇒ **整个偏好设置弹窗被卸载** |
 * | 2 | `system/apps` 少了 `apps` | `snap.externalApps.filter` 抛 ⇒ **整个 Changes 面板不渲染** |
 *
 * 两次都被**偶遇**才发现,而且当时的现状是「静默的空」——那是最坏的形态。
 * ⇒ 这里给出**一个**实现,`api.ts` 的每条路由在**同一个边界**上复用它。
 *
 * ## 判据(为什么是「形状说明」而不是「重建对象」)
 *
 * 说明只回答「**必须成立什么**」,**不重建**返回的对象:
 *  - 不会因为漏列一个字段而**静默丢掉数据**(重建式校验最危险的失败形态);
 *  - 校验是**加性**的:没写进说明的字段一律放行(前向兼容,宿主加字段不需要改这里);
 *  - 失败时说的话**指名道姓**:`字段 apps[2].id 期望 string,实到 undefined`,
 *    并附上**顶层实到形状**(`对象{键=[…]}`)—— 这正是 §「两次故障」里最缺的那句话。
 *
 * ## 诚实的边界
 *
 * 它**不**证明宿主语义正确(字段类型对、值是假的照样通过);它只防住
 * 「形状不对 ⇒ 下游渲染期崩溃 / 静默说谎」这一族。真值校验属于探针与真实 host。
 *
 * @see src/client/api.ts —— 唯一的调用边界(`callShaped`)
 * @see src/client/error-boundary.tsx —— 兜住「说明没覆盖到」的那部分(渲染期抛错)
 * @module dsh-git/client/payload
 */

import type { GitError } from '../core/types.ts';

/** 收窄结果:失败也**带话**(绝不只是 `false`)。 */
export type Narrowed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/**
 * 一段载荷的**形状说明**。
 *
 * - 标量:`'string'` / `'boolean'` / `'number'`;
 * - 后缀 `?` = **可以缺省**(`'string?'`);缺省时通过(消费方自己有兜底);
 * - `|null`:允许 `null`(宿主把「没有」表达成 null 的那些字段);
 * - `{literal: [...]}`:值必须属于给定的字面量集合(状态机字段);
 * - `{array: S}`:必须是数组,且**每个元素**满足 `S`;
 * - `{record: {...}}`:必须是非数组对象,且列出的字段各自满足;
 * - `{optional: S}`:`S` 成立、或字段整个缺省;
 * - `{anyOf: [...]}`:任一分支成立即可(可判别联合,如 `auth/device-poll`)。
 *
 * 说明里**没写的字段一律放行** —— 这是刻意的:说明是「下游会解引用什么」的清单,
 * 不是宿主载荷的完整 schema(写全会变成第二份真源,改一处漏一处)。
 */
export type Shape =
  | 'string'
  | 'string?'
  | 'string|null'
  | 'string|null?'
  | 'boolean'
  | 'boolean?'
  | 'boolean|null'
  | 'number'
  | 'number?'
  | 'number|null'
  | 'number|null?'
  | { readonly literal: readonly (string | number | boolean | null)[] }
  | { readonly array: Shape }
  | { readonly record: Readonly<Record<string, Shape>> }
  | { readonly optional: Shape }
  | { readonly anyOf: readonly Shape[] };

// ---------------------------------------------------------------------------
// 诊断
// ---------------------------------------------------------------------------

/**
 * 一条载荷诊断。
 *
 * `count` 让「每 5 秒轮询一次、每次都畸形」不会把环形缓冲冲掉别的现场:
 * 同一条消息只占一格,只 `console` 一次。
 */
export interface IPayloadDiagnostic {
  readonly kind: '载荷被拒' | '载荷被兜底' | '渲染抛错';
  /** 路由名(渲染抛错时是面板名)。 */
  readonly source: string;
  readonly message: string;
  /** 组件栈等附加信息(渲染抛错才有)。 */
  readonly detail?: string;
  readonly count: number;
  readonly firstAt: number;
}

/** 环形缓冲上限(只为取现场,不做长期统计)。 */
const MAX_DIAGNOSTICS = 200;
const diagnostics: IPayloadDiagnostic[] = [];

/**
 * 记一条诊断,并**同时**打到 console。
 *
 * 为什么两者都做:console 是开发/探针现场,环形缓冲是**机器可读**的那一份
 * (探针据此断言「错误被上报了」,而不用去 spy `console.error`)。
 * 同 `source+kind+message` 只 console 一次(计数在缓冲里涨)。
 *
 * **绝不吞**:这里没有 `catch {}`,也不返回可被忽略的布尔值 —— 调用方拿到的
 * 是 `GitError` 或异常,必须自己处理。
 */
export function reportDiagnostic(
  kind: IPayloadDiagnostic['kind'],
  source: string,
  message: string,
  detail?: string,
): void {
  const existing = diagnostics.find(
    (one) => one.kind === kind && one.source === source && one.message === message,
  );
  if (existing !== undefined) {
    // readonly 字段只是为了「读的人别改」;这里是本模块自己的计数。
    (existing as { count: number }).count += 1;
    return;
  }
  const entry: IPayloadDiagnostic = {
    kind,
    source,
    message,
    ...(detail === undefined ? {} : { detail }),
    count: 1,
    firstAt: Date.now(),
  };
  if (diagnostics.length >= MAX_DIAGNOSTICS) {
    diagnostics.shift();
  }
  diagnostics.push(entry);
  const text = `[dsh-git ${kind}] ${source}:${message}`;
  if (detail !== undefined) {
    // 组件栈单独一行:**必须**打出来,否则「哪个组件抛的」只能靠猜。
    console.error(`${text}\n${detail}`);
  } else if (kind === '载荷被兜底') {
    console.warn(text);
  } else {
    console.error(text);
  }
}

/** 当前诊断快照(探针与错误边界读它)。 */
export function payloadDiagnostics(): readonly IPayloadDiagnostic[] {
  return diagnostics.map((one) => ({ ...one }));
}

/** 清空诊断(探针在每个用例之间调它,避免互相干扰)。 */
export function clearPayloadDiagnostics(): void {
  diagnostics.length = 0;
}

/*
 * 机器可读入口。
 *
 * 探针在 **jsdom** 里跑打包后的真实产品代码,拿不到本模块的 ESM 导出
 * (bundle 是 CJS/IIFE),所以把只读视图挂到全局。挂的名字带项目前缀,不与宿主冲突。
 * **只暴露读与清空**,不能从外部伪造诊断(否则探针的断言可以被骗过)。
 */
const globalScope = globalThis as unknown as Record<string, unknown>;
globalScope.__dshGitDiagnostics = {
  payload: payloadDiagnostics,
  clear: clearPayloadDiagnostics,
};

/** 形状描述(诊断用;**自身永不抛**,所以它可以安全地用在失败路径上)。 */
export function shapeOf(value: unknown): string {
  if (value === null) { return 'null'; }
  if (value === undefined) { return 'undefined'; }
  if (Array.isArray(value)) { return `数组(${value.length})`; }
  const type = typeof value;
  if (type !== 'object') { return `${type}(${String(value)})`; }
  let keys: string[];
  try {
    keys = Object.keys(value as Record<string, unknown>);
  } catch {
    // Proxy 的 ownKeys 陷阱可以抛 —— 诊断本身不该变成第二个失败点。
    return '对象(键读不出来)';
  }
  return `对象{键=[${keys.join(',')}]}`;
}

// ---------------------------------------------------------------------------
// 形状校验
// ---------------------------------------------------------------------------

/** `'string?'` ⇒ `['string', true]`。 */
function splitOptional(shape: string): { base: string; optional: boolean } {
  return shape.endsWith('?')
    ? { base: shape.slice(0, -1), optional: true }
    : { base: shape, optional: false };
}

/** 一个标量说明是否成立;返回 `null` = 成立,否则是**原因**。 */
function whyNotScalar(base: string, value: unknown): string | null {
  switch (base) {
    case 'string':
      return typeof value === 'string' ? null : `期望 string,实到 ${shapeOf(value)}`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `期望 boolean,实到 ${shapeOf(value)}`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `期望有限数字,实到 ${shapeOf(value)}`;
    case 'string|null':
      return value === null || typeof value === 'string'
        ? null
        : `期望 string 或 null,实到 ${shapeOf(value)}`;
    case 'boolean|null':
      return value === null || typeof value === 'boolean'
        ? null
        : `期望 boolean 或 null,实到 ${shapeOf(value)}`;
    case 'number|null':
      return value === null || (typeof value === 'number' && Number.isFinite(value))
        ? null
        : `期望数字或 null,实到 ${shapeOf(value)}`;
    default:
      // 说明写错了(不是载荷错)—— 必须响亮,否则会静默放行一切。
      return `形状说明写错了:未知标量 ${base}`;
  }
}

/** 逐层校验;**返回 `null` = 成立**。`path` 用于指名道姓。 */
function whyNotShape(shape: Shape, value: unknown, path: string): string | null {
  if (typeof shape === 'string') {
    const { base, optional } = splitOptional(shape);
    if (optional && value === undefined) { return null; }
    const why = whyNotScalar(base, value);
    return why === null ? null : `${path} ${why}`;
  }
  if ('literal' in shape) {
    return shape.literal.includes(value as string | number | boolean | null)
      ? null
      : `${path} 期望 ${shape.literal.map((one) => JSON.stringify(one)).join(' / ')},实到 ${shapeOf(value)}`;
  }
  if ('optional' in shape) {
    return value === undefined ? null : whyNotShape(shape.optional, value, path);
  }
  if ('array' in shape) {
    if (!Array.isArray(value)) {
      return `${path} 期望数组,实到 ${shapeOf(value)}`;
    }
    for (let index = 0; index < value.length; index += 1) {
      const why = whyNotShape(shape.array, value[index], `${path}[${index}]`);
      if (why !== null) { return why; }
    }
    return null;
  }
  if ('record' in shape) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return `${path} 期望对象,实到 ${shapeOf(value)}`;
    }
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(shape.record)) {
      const why = whyNotShape(child, record[key], path === 'value' ? key : `${path}.${key}`);
      if (why !== null) { return why; }
    }
    return null;
  }
  const reasons: string[] = [];
  for (let index = 0; index < shape.anyOf.length; index += 1) {
    const why = whyNotShape(shape.anyOf[index] as Shape, value, path);
    if (why === null) { return null; }
    // 每一支都保留原因:只说「不匹配」会让人只能靠读代码猜。
    reasons.push(`${index + 1}) ${why}`);
  }
  return `${path} 不匹配任何一支(${reasons.join(';')})`;
}

/**
 * 按说明收窄一段载荷。**唯一**的校验实现。
 *
 * 不带路由名:路由只在**上报**时才有意义(`payloadError`),把它塞进消息里
 * 会与调用方的前缀重复一次。
 *
 * @param value - 信封里的 `value`(**当 unknown 收窄**,不要先 cast)。
 * @param shape - 形状说明。
 */
export function checkShape(value: unknown, shape: Shape): Narrowed<unknown> {
  const why = whyNotShape(shape, value, 'value');
  if (why === null) {
    return { ok: true, value };
  }
  return { ok: false, message: `载荷形状不对:${why}(实到 ${shapeOf(value)})` };
}

/**
 * 同 {@link checkShape},但把通过的值**断言**成调用方声明的类型。
 *
 * 那一次 cast 就是原来就存在的那次「静态声明」,只是现在它前面多了一道
 * **运行时**检查 —— message 里已经说清失败原因,所以这个 cast 不隐藏任何东西。
 */
export function narrowed<T>(value: unknown, shape: Shape): Narrowed<T> {
  const checked = checkShape(value, shape);
  return checked.ok ? { ok: true, value: checked.value as T } : checked;
}

/**
 * 把一次形状失败翻成 `GitError`(**同时**上报诊断)。
 *
 * 用 `'internal'` 而不是新造错误码:错误码是 host/client 的共享契约
 * (`core/types.ts` 的 `GitErrorCode`),为「客户端自己的校验」加一个码会让
 * 所有按码分派的地方多一条永远不会从 host 来的分支。文案才是要读的东西。
 *
 * @param route - 路由名。
 * @param message - `checkShape` 给的话。
 */
export function payloadError(route: string, message: string): GitError {
  reportDiagnostic('载荷被拒', route, message);
  return { code: 'internal', message: `宿主 ${route} 的${message}` };
}
/**
 * 记一条「缺字段但可安全兜底」。
 *
 * 与 {@link payloadError} 的区别是**不失败**:例如老 host 不返回某个新字段,
 * 消费方本来就有默认值。兜底不是静默 —— 它进诊断环并打一次 `console.warn`。
 */
export function noteNormalized(route: string, message: string): void {
  reportDiagnostic('载荷被兜底', route, message);
}
