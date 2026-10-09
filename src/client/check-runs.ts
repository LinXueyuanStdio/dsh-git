/**
 * **CI 检查(commit status + check run)的判断层** —— 抄上游的**判断**,不抄它的架构。
 *
 * ## 这个文件是什么、不是什么(先读这一段)
 *
 * 上游这件事分成三层:`lib/stores/commit-status-store.ts`(593,订阅/缓存/后台刷新)
 * + `lib/ci-checks/ci-checks.ts`(722,纯判断)+ `ui/check-runs/**`(1,442,浮层)。
 * 本仓**已经有**一条自己的机制:`src/client/gh-api.ts`(经宿主代理打 GitHub REST)
 * + `src/client/pulls-view.tsx`(PR 详情抽屉里已经画 check 明细)。
 *
 * ⇒ 所以本文件**只做一件事**:把上游那些**纯判断**(有哪些状态、结论怎么映射成
 * 图标/颜色/形容词、多个 run 怎么合成一个总状态、怎么分组、摘要句子怎么写)
 * 逐条抄成函数。它**不是** `commit-status-store` 的等价物:
 *
 *   · 没有订阅系统(没有 `alive-store`、没有 Disposable、没有 dispatcher);
 *   · 没有后台定时器 —— 刷新是**拉取式**的,靠下面那个 60 秒 TTL;
 *   · 没有 workflow/job/step 的**加取**(那要按 check suite 逐个再打一次网络,
 *     见 `参考资料` 里 `getCheckRunActionsWorkflowRuns`)。
 *
 * 换句话说:**判断照抄,机制用自己的**。上层(视图)不知道上游那 593 行存在。
 *
 * ## 抄了什么(逐条给上游 file:line)
 *
 * | 本文件 | 上游 | 抄的是 |
 * |---|---|---|
 * | `getCheckRunConclusionAdjective` | `lib/ci-checks/ci-checks.ts:85-110` | 结论 → 面向用户的形容词(含 `null` ⇒ `In progress`) |
 * | `getCheckRunShortDescription` | `lib/ci-checks/ci-checks.ts:126-156` | 形容词 + 时长(`in`/`after` 的介词规则、三种结论不加时长) |
 * | `isIncomplete` / `isFailure` / `isSuccess` | `lib/ci-checks/ci-checks.ts:240-278` | 三个谓词(**只在 `status === 'completed'` 时看结论**) |
 * | `createCombinedCheck` | `lib/ci-checks/ci-checks.ts:190-222` | 0 条 ⇒ `null`;1 条 ⇒ 原样镜像;有「未完成或失败」⇒ Failure;全成功 ⇒ Success;否则 InProgress |
 * | `getFailingCheckConclusions` | `lib/ci-checks/ci-checks.ts:717-722` | 四个算失败的结论 |
 * | `getCombinedStatusSummary` | `ui/check-runs/ci-check-run-popover.tsx:43-56` | `"2 successful, 1 failed and 1 skipped checks"` 那句 |
 * | `getCheckTitle` | `ui/check-runs/ci-check-run-popover.tsx:274-331` | 四个标题态(含各自的**优先级**) |
 * | `getCheckAppearance` | `ui/branches/ci-status.tsx:124-169` | 结论 → octicon 符号 + `ci-status-*` 类名;颜色按 `styles/ui/_ci-status.scss` 的四组 |
 * | `getCheckRunGroups` / `getCheckRunGroupNames` | `lib/ci-checks/ci-checks.ts:598-669` | 按 workflow 名分组、`Other` **永远最后**、`GitHub Code Scanning` ⇒ `Code scanning results` |
 * | `getCheckStatusCountMap` | `lib/ci-checks/ci-checks.ts:703-712` | 按 结论??状态 计数(给「完整性指示器」的 aria 文案) |
 * | `getLatestCheckRunsByName` | `lib/ci-checks/ci-checks.ts:289-318` | 同名 run 只留**最新**的一份 |
 * | `apiStatusToRefCheck` | `lib/ci-checks/ci-checks.ts:56-80` | 老式 commit status ⇒ 伪 check run |
 * | `formatPreciseDuration` / `toSentence` | `lib/format-duration.ts:22-35` / `lib/to_sentence.ts:12-31` | 这两个上游文件本仓**没有镜像** ⇒ 逐字抄进来(纯函数) |
 *
 * ## 与上游**逐字**不同的三处(每一处都写明理由,不是疏忽)
 *
 * 1. **`getLatestCheckRunsByName` 的键**。上游 `:303-307` 的注释说键是
 *    「check run 的名字 + 是不是 PR 触发的」,但代码里写的是
 *    `checkRun.id + (…)` —— `id` 唯一 ⇒ 这个 Map 永远一个 id 一项 ⇒
 *    同名去重**从不发生**(上游缺陷)。这里按**注释声明的意图**实现(键 = 名字 + 来源),
 *    因为 GitHub 自己的合并框就只认「每个名字的最新一次」(`:281-288` 的注释原文),
 *    而这一条会**改变总状态**(失败的旧 run + 成功的新 run:不去重 ⇒ 总状态 Failure)。
 * 2. **颜色值**:上游是 `$yellow-700` / `$red-500` / `$gray-400` / `$green-500`
 *    (`_ci-status.scss:6-25`)。本仓的规矩是绑宿主主题令牌(不写死十六进制)⇒
 *    四组分别取与既有 `CheckDot`/`StateIcon` **同一个**令牌,不新造名字。
 * 3. **`Other` 组里的 workflow 名**:上游会为每个 check suite 再打一次
 *    `/actions/runs`(按 suite id 或按分支名)拿 workflow 名。我们不付这笔网络开销
 *    (每个 check suite 一次),所以除 `GitHub Code Scanning` 那条(它只需要
 *    check run 自带的 `app.name`,**零额外请求**)之外,都落进上游自己的兜底组 `Other`。
 *
 * ## 网络预算(唯一的对外副作用)
 *
 * `loadRefChecks` 是这里**唯一**会打网络的函数:每个 `(仓库, ref)` 在 60 秒 TTL 内
 * 最多 2 次请求(`/commits/{ref}/check-runs` + `/commits/{ref}/status`,与上游
 * `commit-status-store.ts:285-288` 的并行取法同构)。同一时刻的并发调用**复用同一个
 * promise**(不会因为重渲染重复发车);60 秒这个数字也是上游的
 * (`commit-status-store.ts:107-117`:GitHub 自己的 max-age 就是 60 秒)。
 */

import * as api from './gh-api.ts';
import type { GhRef } from '../core/lib.ts';
import { ghRefKey } from '../core/lib.ts';
import type { IconName } from './icons-gh.ts';

/* ==========================================================================
 * 模型(上游 `lib/ci-checks/ci-checks.ts:28-51`,名字沿用上游)
 * ========================================================================== */

/** check run 的状态(上游 `lib/api.ts:350-354` 的 `APICheckStatus`)。 */
export type CheckStatus = 'queued' | 'in_progress' | 'completed' | (string & {});

/** check run 的结论(上游 `lib/api.ts:357-366` 的 `APICheckConclusion`)。 */
export type CheckConclusion =
  | 'action_required'
  | 'cancelled'
  | 'timed_out'
  | 'failure'
  | 'neutral'
  | 'success'
  | 'skipped'
  | 'stale';

/**
 * Desktop 自己的模型(`ci-checks.ts:19-41` 的 `IRefCheck`)。
 * `status` 放宽成 `string` 是因为 GitHub 会加新状态,而判别只在三个谓词里做。
 */
export interface IRefCheck {
  readonly id: number;
  readonly name: string;
  /** 面向用户的一句话:形容词(+ 时长)。见 `getCheckRunShortDescription`。 */
  readonly description: string;
  readonly status: CheckStatus;
  readonly conclusion: CheckConclusion | null;
  readonly appName: string;
  readonly htmlUrl: string | null;
  /** 判「同名哪个更新」的代理(上游用 `check_suite.id`)。 */
  readonly checkSuiteId: number | null;
  /** 分组名。没有 workflow 信息时是 `Other`(见文件头第 3 条)。 */
  readonly group: string;
}

/** 一个 ref 上所有 check 的合成视图(`ci-checks.ts:43-51` 的 `ICombinedRefCheck`)。 */
export interface ICombinedRefCheck {
  readonly status: CheckStatus;
  readonly conclusion: CheckConclusion | null;
  readonly checks: ReadonlyArray<IRefCheck>;
}

/** `loadRefChecks` 的结果:合成状态 + **取不到时要显示的错误**(不许静默吞)。 */
export interface IRefChecksResult {
  readonly check: ICombinedRefCheck | null;
  /** 两侧请求**都**失败时的第一条错误消息;一侧成功就是 `null`。 */
  readonly error: string | null;
  /** 本次答案是不是来自 TTL 内的缓存(给探针/报告读数用)。 */
  readonly fromCache: boolean;
}

/* ==========================================================================
 * 纯判断:`lib/format-duration.ts` + `lib/to_sentence.ts`(本仓没有镜像 ⇒ 逐字抄)
 * ========================================================================== */

interface ITimeUnitDescriptor {
  readonly shortUnit: string;
  readonly ms: number;
}

const DURATION_UNITS: ReadonlyArray<ITimeUnitDescriptor> = [
  { shortUnit: 'd', ms: 86400000 },
  { shortUnit: 'h', ms: 3600000 },
  { shortUnit: 'm', ms: 60000 },
  { shortUnit: 's', ms: 1000 },
];

/**
 * `formatPreciseDuration` 的短写法(`format-duration.ts:22-35`,示例 `1h 1m 10s`)。
 * @param inputMs - 毫秒数(取绝对值,与上游一致)。
 * @returns 形如 `1m 30s` 的字符串(至少含秒那一档)。
 */
export function formatPreciseDuration(inputMs: number): string {
  const parts: string[] = [];
  let ms = Math.abs(inputMs);
  for (const unit of DURATION_UNITS) {
    if (parts.length > 0 || ms >= unit.ms || unit.shortUnit === 's') {
      const qty = Math.floor(ms / unit.ms);
      ms -= qty * unit.ms;
      parts.push(`${qty}${unit.shortUnit}`);
    }
  }
  return parts.join(' ');
}

/** `toSentence`(`to_sentence.ts:12-31`):`['a','b']` ⇒ `a and b`,`['a','b','c']` ⇒ `a, b, and c`。 */
export function toSentence(array: ReadonlyArray<string>): string {
  const wordsConnector = ', ';
  const twoWordsConnector = ' and ';
  const lastWordConnector = ', and ';
  switch (array.length) {
    case 0:
      return '';
    case 1:
      return array.at(0) ?? '';
    case 2:
      return String(array.at(0)) + twoWordsConnector + String(array.at(1));
    default:
      return array.slice(0, -1).join(wordsConnector) + lastWordConnector + array.at(-1);
  }
}

/* ==========================================================================
 * 纯判断:结论 ↔ 文案(`ci-checks.ts:85-156`)
 * ========================================================================== */

/**
 * 结论 → 面向用户的形容词(`ci-checks.ts:85-110`,逐字)。
 * `null`(**还没得出结论**)⇒ `In progress`。
 * @param conclusion - check 的结论。
 * @returns 形容词。
 */
export function getCheckRunConclusionAdjective(conclusion: CheckConclusion | null): string {
  if (conclusion === null) {
    return 'In progress';
  }
  switch (conclusion) {
    case 'action_required':
      return 'Action required';
    case 'cancelled':
      return 'Canceled';
    case 'timed_out':
      return 'Timed out';
    case 'failure':
      return 'Failed';
    case 'neutral':
      return 'Neutral';
    case 'success':
      return 'Successful';
    case 'skipped':
      return 'Skipped';
    case 'stale':
      return 'Marked as stale';
  }
}

/**
 * 一次 check 的时长(`ci-checks.ts:162-164`):`completed_at - started_at`。
 * 任一字段解析不出来就是 `NaN`(调用方按「没有时长」处理)。
 */
export function getCheckDurationInMilliseconds(check: {
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
}): number {
  return Date.parse(String(check.completed_at)) - Date.parse(String(check.started_at));
}

/**
 * 「形容词 + 时长」的短描述(`ci-checks.ts:126-156`)。
 * 规则:未完成 ⇒ `In progress`;`Action required`/`Skipped`/`Marked as stale`
 * **不带**时长;成功用 `in`,其余用 `after`;时长不是正数就只给形容词。
 * @param status - check 的状态。
 * @param conclusion - check 的结论。
 * @param durationMs - 时长(毫秒),缺省 = 没有。
 * @returns 面向用户的一句描述。
 */
export function getCheckRunShortDescription(
  status: CheckStatus,
  conclusion: CheckConclusion | null,
  durationMs?: number,
): string {
  if (status !== 'completed' || conclusion === null) {
    return 'In progress';
  }
  const adjective = getCheckRunConclusionAdjective(conclusion);
  if (conclusion === 'action_required' || conclusion === 'skipped' || conclusion === 'stale') {
    return adjective;
  }
  const preposition = conclusion === 'success' ? 'in' : 'after';
  if (durationMs !== undefined && durationMs > 0) {
    return `${adjective} ${preposition} ${formatPreciseDuration(durationMs)}`;
  }
  return adjective;
}

/* ==========================================================================
 * 纯判断:三个谓词 + 合成(`ci-checks.ts:227-278` / `:190-222`)
 * ========================================================================== */

/**
 * 未完成(`ci-checks.ts:240-251`):`completed` 但结论是 `timed_out`/`stale`/`cancelled`。
 * 上游原文把这一类叫 incomplete ——「跑完了但没产出结论」。
 */
export function isIncomplete(check: IRefCheck): boolean {
  if (check.status === 'completed') {
    switch (check.conclusion) {
      case 'timed_out':
      case 'stale':
      case 'cancelled':
        return true;
    }
  }
  return false;
}

/** 失败(`ci-checks.ts:254-264`):`completed` 且结论是 `failure`/`action_required`。 */
export function isFailure(check: IRefCheck): boolean {
  if (check.status === 'completed') {
    switch (check.conclusion) {
      case 'failure':
      case 'action_required':
        return true;
    }
  }
  return false;
}

/** 算成功(`ci-checks.ts:267-278`):`success`/`neutral`/`skipped`。 */
export function isSuccess(check: IRefCheck): boolean {
  if (check.status === 'completed') {
    switch (check.conclusion) {
      case 'success':
      case 'neutral':
      case 'skipped':
        return true;
    }
  }
  return false;
}

/** `ci-checks.ts:227-229`。 */
export function isIncompleteOrFailure(check: IRefCheck): boolean {
  return isIncomplete(check) || isFailure(check);
}

/** 四个算「失败」的结论(`ci-checks.ts:717-722`)。 */
export const FAILING_CHECK_CONCLUSIONS: ReadonlyArray<CheckConclusion> = [
  'failure',
  'cancelled',
  'action_required',
  'timed_out',
];

/**
 * 多条 check ⇒ 一个总状态(`ci-checks.ts:190-222`,逐条沿用):
 * 0 条 ⇒ `null`(**这不是「失败」,是「这个 ref 上什么都没有」**);
 * 1 条 ⇒ 原样镜像;有「未完成或失败」⇒ `completed`/`failure`;
 * 全成功 ⇒ `completed`/`success`;否则 `in_progress`/`null`。
 * @param checks - 某个 ref 上的全部 check。
 * @returns 合成视图,或 `null`。
 */
export function createCombinedCheck(checks: ReadonlyArray<IRefCheck>): ICombinedRefCheck | null {
  if (checks.length === 0) {
    return null;
  }
  if (checks.length === 1) {
    const only = checks[0];
    return { status: only.status, conclusion: only.conclusion, checks };
  }
  if (checks.some(isIncompleteOrFailure)) {
    return { status: 'completed', conclusion: 'failure', checks };
  }
  if (checks.every(isSuccess)) {
    return { status: 'completed', conclusion: 'success', checks };
  }
  return { status: 'in_progress', conclusion: null, checks };
}

/**
 * 同名 run 只留最新的一份(`ci-checks.ts:289-318`;键的差异见文件头第 1 条)。
 * 「来源」= 这次 run 是不是 PR 触发(`pull_requests` 非空)——
 * 上游原文解释了为什么同名也要分开:`:295-302`(push 事件与 pull_request 事件
 * 可以有同名的 run,它们不是同一次 run 的重复)。
 * @param checkRuns - 原始 check run 列表。
 * @returns 去重后的列表。
 */
export function getLatestCheckRunsByName(
  checkRuns: ReadonlyArray<api.GhCheckRun>,
): ReadonlyArray<api.GhCheckRun> {
  const latest = new Map<string, api.GhCheckRun>();
  for (const run of checkRuns) {
    const hasPrs = (run.pull_requests?.length ?? 0) > 0;
    const key = `${run.name ?? ''}${hasPrs ? 'isPullRequestCheckRun' : 'isPushCheckRun'}`;
    const current = latest.get(key);
    const suiteOf = (one: api.GhCheckRun): number => one.check_suite?.id ?? -1;
    if (current === undefined || suiteOf(current) < suiteOf(run)) {
      latest.set(key, run);
    }
  }
  return [...latest.values()];
}

/**
 * 按「结论 ?? 状态」计数(`ci-checks.ts:703-712`):给完整性指示器的 aria 文案用。
 * @param checks - check 列表。
 * @returns 键是结论或状态。
 */
export function getCheckStatusCountMap(checks: ReadonlyArray<IRefCheck>): Map<string, number> {
  const countByStatus = new Map<string, number>();
  checks.forEach((check) => {
    const key = check.conclusion ?? check.status;
    countByStatus.set(key, (countByStatus.get(key) ?? 0) + 1);
  });
  return countByStatus;
}

/* ==========================================================================
 * 纯判断:分组(`ci-checks.ts:598-669`)
 * ========================================================================== */

/**
 * 组名的排序:字母序,但 `Other` **永远最后**(`ci-checks.ts:646-669`)。
 * @param groups - 组表。
 * @returns 排好序的组名。
 */
export function getCheckRunGroupNames(
  groups: ReadonlyMap<string, ReadonlyArray<IRefCheck>>,
): ReadonlyArray<string> {
  const groupNames = [...groups.keys()];
  groupNames.sort((a, b) => {
    if (a === 'Other' && b !== 'Other') {
      return 1;
    }
    if (a !== 'Other' && b === 'Other') {
      return -1;
    }
    if (a === 'Other' && b === 'Other') {
      return 0;
    }
    return a.localeCompare(b);
  });
  return groupNames;
}

/**
 * 按 workflow 名分组;`GitHub Code Scanning` 的 `Other` 组改名叫
 * `Code scanning results`(`ci-checks.ts:598-641`)。
 * ⚠️ 我们**不**加取 workflow 名(见文件头第 3 条)⇒ 除 Code scanning 外都在 `Other`。
 * @param checks - check 列表。
 * @returns 组名 ⇒ 该组的 check(组内按名字排序)。
 */
export function getCheckRunGroups(
  checks: ReadonlyArray<IRefCheck>,
): Map<string, ReadonlyArray<IRefCheck>> {
  const groups = new Map<string, IRefCheck[]>();
  for (const check of checks) {
    let group = check.group !== '' ? check.group : 'Other';
    if (group === 'Other' && check.appName === 'GitHub Code Scanning') {
      group = 'Code scanning results';
    }
    const existing = groups.get(group);
    groups.set(group, existing !== undefined ? [...existing, check] : [check]);
  }
  const sortedNames = getCheckRunGroupNames(groups);
  sortedNames.forEach((name) => {
    const group = groups.get(name);
    if (group !== undefined) {
      groups.set(name, [...group].sort((a, b) => a.name.localeCompare(b.name)));
    }
  });
  return groups;
}

/* ==========================================================================
 * 纯判断:头部标题 + 摘要(`ci-check-run-popover.tsx:43-56` / `:274-331`)
 * ========================================================================== */

/** 头部标题的五个状态(上游的四个标题 + 加载态)。 */
export type CheckTitleState = 'loading' | 'pending' | 'all-failure' | 'all-success' | 'some-failed';

/** 头部的三个布尔量(上游 `:301-331` 的计算,逐条沿用)。 */
export interface ICheckHeaderFlags {
  readonly loading: boolean;
  readonly somePendingNoFailures: boolean;
  readonly allSuccessIsh: boolean;
  readonly allFailure: boolean;
}

/**
 * 算出头部的三个布尔量(`ci-check-run-popover.tsx:301-331`)。
 * 三条**快速返回**是判断的一部分:`loading` 时既不算 allSuccess 也不算 allFailure;
 * `somePendingNoFailures` 一旦成立,另外两个必然不成立。
 * @param checks - check 列表(不是合成视图,上游这里看的是每一条)。
 * @param loading - 是否还在加载(且没有可用缓存)。
 * @returns 三个布尔量。
 */
export function getCheckHeaderFlags(
  checks: ReadonlyArray<IRefCheck>,
  loading: boolean,
): ICheckHeaderFlags {
  const somePendingNoFailures =
    !loading &&
    checks.some((one) => one.conclusion === null) &&
    !checks.some(
      (one) => one.conclusion !== null && FAILING_CHECK_CONCLUSIONS.includes(one.conclusion),
    );
  const successfulish: ReadonlyArray<string> = ['success', 'neutral', 'skipped'];
  const allSuccessIsh =
    !loading &&
    !somePendingNoFailures &&
    !checks.some((one) => one.conclusion !== null && !successfulish.includes(one.conclusion));
  const allFailure =
    !loading &&
    !somePendingNoFailures &&
    !checks.some(
      (one) => one.conclusion === null || !FAILING_CHECK_CONCLUSIONS.includes(one.conclusion),
    );
  return { loading, somePendingNoFailures, allSuccessIsh, allFailure };
}

/** 头部的四个标题(`ci-check-run-popover.tsx:274-294`),**优先级照上游**。 */
const CHECK_TITLES: Record<CheckTitleState, string> = {
  loading: 'Checks Summary',
  pending: "Some checks haven't completed yet",
  'all-failure': 'All checks have failed',
  'all-success': 'All checks have passed',
  'some-failed': 'Some checks were not successful',
};

/**
 * 由布尔量决定标题态(`ci-check-run-popover.tsx:280-294` 的 switch 顺序)。
 * @param flags - `getCheckHeaderFlags` 的结果。
 * @returns 五个状态之一。
 */
export function getCheckTitleState(flags: ICheckHeaderFlags): CheckTitleState {
  if (flags.loading) {
    return 'loading';
  }
  if (flags.somePendingNoFailures) {
    return 'pending';
  }
  if (flags.allFailure) {
    return 'all-failure';
  }
  if (flags.allSuccessIsh) {
    return 'all-success';
  }
  return 'some-failed';
}

/**
 * 标题文案。
 * @param state - `getCheckTitleState` 的结果。
 * @returns 文案(英文,与上游逐字;本仓的镜像文案不改写上游字符串)。
 */
export function getCheckTitle(state: CheckTitleState): string {
  return CHECK_TITLES[state];
}

/**
 * 「N successful, M failed and K skipped checks」(`ci-check-run-popover.tsx:43-56`)。
 * 按结论分组计数,组内先出现者先写(上游用 `Object.values(groupBy(...))`,同序)。
 * @param statusHolders - 任意带 `conclusion` 的列表。
 * @param description - `check`(默认)或 `step`,决定复数那个词。
 * @returns 一句话;空列表 ⇒ `''`。
 */
export function getCombinedStatusSummary(
  statusHolders: ReadonlyArray<{ readonly conclusion: CheckConclusion | null }>,
  description: 'check' | 'step' = 'check',
): string {
  if (statusHolders.length === 0) {
    return '';
  }
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const holder of statusHolders) {
    const key = String(holder.conclusion);
    if (!counts.has(key)) {
      order.push(key);
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const conclusions = order.map((key) => {
    const count = counts.get(key) ?? 0;
    const adjective = getCheckRunConclusionAdjective(
      key === 'null' ? null : (key as CheckConclusion),
    );
    return `${count} ${adjective.toLocaleLowerCase()}`;
  });
  const pluralize = statusHolders.length > 1 ? `${description}s` : description;
  return `${toSentence(conclusions)} ${pluralize}`;
}

/* ==========================================================================
 * 纯判断:结论 → 图标 + 类名 + 颜色(`ui/branches/ci-status.tsx:124-169`)
 * ========================================================================== */

/** 四组颜色(上游 `styles/ui/_ci-status.scss:1-25`)。 */
export type CheckTone = 'red' | 'gray' | 'yellow' | 'green';

/** 一条 check 的外观:`ci-status-*` 类名 + 图标 + 颜色组 + 形容词。 */
export interface ICheckAppearance {
  /** 上游同一份类名(`ci-status` + `ci-status-<结论>`)。 */
  readonly className: string;
  /** 我们的图标名(`icons-gh.ts`;符号身份与上游 `octicons.*` 一一对应)。 */
  readonly icon: IconName;
  readonly tone: CheckTone;
  /** 上游 `getCheckRunConclusionAdjective` 的结果。 */
  readonly label: string;
}

/** 上游 `ci-status.tsx:127-148` 的符号表(`pending` 是那条 `default` 分支)。 */
const CHECK_ICONS: Record<string, IconName> = {
  timed_out: 'x',
  failure: 'x',
  neutral: 'square-fill',
  success: 'check',
  cancelled: 'stop',
  action_required: 'alert',
  skipped: 'skip',
  stale: 'issue-reopened',
};

/** 上游 `_ci-status.scss:6-25` 的四组(颜色值换成宿主令牌,见文件头第 2 条)。 */
const CHECK_TONES: Record<string, CheckTone> = {
  timed_out: 'red',
  action_required: 'red',
  failure: 'red',
  cancelled: 'gray',
  stale: 'gray',
  skipped: 'gray',
  neutral: 'gray',
  success: 'green',
};

/**
 * 结论/状态 ⇒ 外观(`ci-status.tsx:124-169` 的 `getSymbolForCheck` +
 * `getClassNameForCheck` 合并成一次查表)。
 * 没有结论(**还在跑**)⇒ 上游的 `default`:符号 `dotFill`、类名 `pending`。
 * @param conclusion - 结论,或 `null`。
 * @returns 外观。
 */
export function getCheckAppearance(conclusion: CheckConclusion | null): ICheckAppearance {
  const label = getCheckRunConclusionAdjective(conclusion);
  if (conclusion === null) {
    return { className: 'ci-status ci-status-pending', icon: 'dot-fill', tone: 'yellow', label };
  }
  const icon = CHECK_ICONS[conclusion] ?? 'dot-fill';
  const tone = CHECK_TONES[conclusion] ?? 'yellow';
  const klass = conclusion === 'timed_out' ? 'timed-out'
    : conclusion === 'action_required' ? 'action-required'
      : conclusion;
  return { className: `ci-status ci-status-${klass}`, icon, tone, label };
}

/**
 * 把**任意来源**的结论字符串收窄回 `CheckConclusion`(运行期不变;值逐字相同:
 * 上游 `lib/api.ts:357-366` 的枚举 与 我们 `gh-api.ts` 的字符串 是同一批值)。
 *
 * 为什么需要:抄进来的 `commit-status-store.ts` 用的是上游枚举类型
 * (`APICheckConclusion`),而我们这张判断表用字符串联合 —— 两边**值相同、类型不同**,
 * 在 TypeScript 的枚举/字面量之间需要一个显式收窄点(只此一处)。
 * @param value - 结论或 `null`。
 * @returns 我们的结论联合(原值原样,不做映射)。
 */
export function asConclusion(value: string | null): CheckConclusion | null {
  return value === null ? null : (value as CheckConclusion);
}

/** 四组颜色 → 宿主令牌(与既有 `CheckDot`/`StateIcon` 同一组令牌,不新造名字)。 */
export const CHECK_TONE_COLOR: Record<CheckTone, string> = {
  red: 'var(--dsw-alias-state-error-primary)',
  gray: 'var(--dsw-alias-label-tertiary)',
  yellow: 'var(--dsw-alias-state-warn-primary)',
  green: 'var(--dsw-alias-state-success-primary)',
};

/**
 * 完整性指示器的 aria 文案(`ci-check-run-popover.tsx:265-269`)。
 * @param checks - check 列表。
 * @returns 形如 `Completeness indicator. 3 completed, 1 in progress, 0 queued.`。
 */
export function getCompletenessAriaLabel(checks: ReadonlyArray<IRefCheck>): string {
  const map = getCheckStatusCountMap(checks);
  return `Completeness indicator. ${map.get('completed') ?? 0} completed, ${
    map.get('in_progress') ?? 0
  } in progress, ${map.get('queued') ?? 0} queued.`;
}

/* ==========================================================================
 * 原始载荷 ⇒ 模型(`ci-checks.ts:56-80` + `:169-184` + `commit-status-store.ts:308-315`)
 * ========================================================================== */

/**
 * 老式 commit status ⇒ 伪 check run(`ci-checks.ts:56-80`)。
 * `success` ⇒ 完成/成功;`pending` ⇒ 进行中/无结论;**其余(含 `error`)
 * ⇒ 完成/失败** —— 上游把 `error` 也归失败(那个 `else` 分支)。
 * @param status - `/commits/{ref}/status` 里的一条。
 * @returns `IRefCheck`。
 */
export function apiStatusToRefCheck(status: api.GhCommitStatus): IRefCheck {
  let state: CheckStatus = 'completed';
  let conclusion: CheckConclusion | null = null;
  if (status.state === 'success') {
    state = 'completed';
    conclusion = 'success';
  } else if (status.state === 'pending') {
    state = 'in_progress';
  } else {
    state = 'completed';
    conclusion = 'failure';
  }
  return {
    id: status.id,
    name: status.context,
    description: getCheckRunShortDescription(state, conclusion),
    status: state,
    conclusion,
    // 老式 status 没有 app;上游这里给空串(`ci-checks.ts:76`)。
    appName: '',
    htmlUrl: status.target_url ?? null,
    checkSuiteId: null,
    group: 'Other',
  };
}

/**
 * 原始 check run ⇒ 模型(`ci-checks.ts:169-184`)。
 * @param run - GitHub REST 的 check run。
 * @returns `IRefCheck`。
 */
export function apiCheckRunToRefCheck(run: api.GhCheckRun): IRefCheck {
  const status = (run.status ?? 'queued') as CheckStatus;
  const conclusion = (run.conclusion ?? null) as CheckConclusion | null;
  return {
    id: run.id,
    name: run.name ?? '',
    description: getCheckRunShortDescription(
      status,
      conclusion,
      getCheckDurationInMilliseconds(run),
    ),
    status,
    conclusion,
    appName: run.app?.name ?? '',
    htmlUrl: run.html_url ?? null,
    checkSuiteId: run.check_suite?.id ?? null,
    // 我们不取 workflow 名 ⇒ 上游的兜底组(见文件头第 3 条)。
    group: 'Other',
  };
}

/**
 * 两侧载荷合并成一个列表(`commit-status-store.ts:308-315` 的顺序:
 * **先老式 status,再最新的 check run**)。
 * @param checkRuns - `/check-runs` 的 `check_runs`(`null` = 这一侧取失败)。
 * @param statuses - `/status` 的 `statuses`(`null` = 这一侧取失败)。
 * @returns `IRefCheck` 列表。
 */
export function toRefChecks(
  checkRuns: ReadonlyArray<api.GhCheckRun> | null,
  statuses: ReadonlyArray<api.GhCommitStatus> | null,
): ReadonlyArray<IRefCheck> {
  const checks: IRefCheck[] = [];
  if (statuses !== null) {
    checks.push(...statuses.map(apiStatusToRefCheck));
  }
  if (checkRuns !== null) {
    checks.push(...getLatestCheckRunsByName(checkRuns).map(apiCheckRunToRefCheck));
  }
  return checks;
}

/* ==========================================================================
 * 唯一的网络面:带 TTL / 并发去重 / 序号守卫的取数
 * ========================================================================== */

/**
 * 缓存条目最长活多久(毫秒)。**60 秒是上游的数字**
 * (`commit-status-store.ts:107-117`:GitHub 自己的 `max-age` 就是 60 秒,
 * 比这更密只会拿到 Chromium 的缓存副本)。
 */
export const REF_CHECK_TTL_MS = 60_000;

interface IRefCheckCacheEntry {
  readonly at: number;
  readonly result: IRefChecksResult;
}

const refCheckCache = new Map<string, IRefCheckCacheEntry>();
/** 每个 key 一个在飞 promise(`force` 会**顶掉**它,见下面「并发去重」一条)。 */
const refCheckInFlight = new Map<string, Promise<IRefChecksResult>>();
/** 每个 key 一个写入序号:**陈旧的在飞响应不许覆盖新数据**。 */
const refCheckSeqByKey = new Map<string, number>();

/**
 * 清空缓存与在飞表(探针用;产品代码里没有调用点 —— 刷新靠 TTL)。
 * 它**不是**「清空后必须重取」的开关:在飞表也要清,否则 `force` 会被复用。
 */
export function clearRefCheckCache(): void {
  refCheckCache.clear();
  refCheckInFlight.clear();
  refCheckSeqByKey.clear();
}

function cacheKeyOf(ref: GhRef, gitRef: string): string {
  return `${ghRefKey(ref)}\u0000${gitRef}`;
}

/**
 * 取一个 ref 上的 CI 状态(唯一会打网络的函数)。
 *
 * ## 纪律(逐条对应本仓付过代价的坑)
 *
 * - **TTL 60 秒**(上游数字):`(仓库, ref)` 粒度,重渲染不重取;
 * - **并发去重**:同一 key 在飞时,非 `force` 的调用返回**同一个 promise**
 *   (不会因为两处 UI 同时挂载而把请求数加倍);`force`(用户显式点重试)
 *   会**另起**一次请求并顶掉在飞表 —— 于是「旧响应后到」成为**可能**,
 *   这就要靠下一条;
 * - **每 key 序号守卫**:每个 key 一个 `seq`;响应回来时若自己不是最新的
 *   (期间被 `force` 顶掉过),**不写缓存、也不把旧值交给调用方** ——
 *   交回当前缓存里的那份。与 `gh-api.ts:542-545` 的 `searchSeq`、
 *   `store.refreshStatus` 的序号守卫同一套写法。⚠️ 这一条**可证承重**:
 *   探针里有「慢响应 vs force」的时序用例;
 * - **一侧失败不算失败**(上游 `commit-status-store.ts:308-315`):只有两侧都失败才
 *   回 `error`,并把**上一次的缓存值**原样交回去(上游 `:292-306` 的「宁可给旧的
 *   也不清空」)。不许把「取不到」当成「没有 check」——那正是本仓反复出现的
 *   空绿缺陷类。
 *
 * @param ref - 仓库。
 * @param gitRef - sha **或** ref(`refs/pull/1/head` 也合法,会被 URL 编码)。
 * @param force - 跳过 TTL(用户显式点「重试」时用)。
 * @returns 合成状态 + 错误 + 是否来自缓存。
 */
export async function loadRefChecks(
  ref: GhRef,
  gitRef: string,
  force = false,
): Promise<IRefChecksResult> {
  const key = cacheKeyOf(ref, gitRef);
  const cached = refCheckCache.get(key);
  if (!force && cached !== undefined && Date.now() - cached.at < REF_CHECK_TTL_MS) {
    return { ...cached.result, fromCache: true };
  }
  if (!force) {
    const inFlight = refCheckInFlight.get(key);
    if (inFlight !== undefined) {
      return inFlight;
    }
  }
  const mySeq = (refCheckSeqByKey.get(key) ?? 0) + 1;
  refCheckSeqByKey.set(key, mySeq);
  const previous = cached?.result ?? { check: null, error: null, fromCache: false };
  const task: Promise<IRefChecksResult> = (async (): Promise<IRefChecksResult> => {
    let checkRuns: ReadonlyArray<api.GhCheckRun> | null = null;
    let statuses: ReadonlyArray<api.GhCommitStatus> | null = null;
    let error: string | null = null;
    const [runsResult, statusResult] = await Promise.all([
      api.listCheckRuns(ref, gitRef).then(
        (value) => {
          return { ok: true as const, value };
        },
        (reason: unknown) => {
          return { ok: false as const, reason };
        },
      ),
      api.listCommitStatuses(ref, gitRef).then(
        (value) => {
          return { ok: true as const, value };
        },
        (reason: unknown) => {
          return { ok: false as const, reason };
        },
      ),
    ]);
    if (runsResult.ok) {
      checkRuns = runsResult.value;
    } else {
      error = messageOf(runsResult.reason);
    }
    if (statusResult.ok) {
      statuses = statusResult.value;
    } else if (error === null) {
      error = messageOf(statusResult.reason);
    }
    if (refCheckSeqByKey.get(key) !== mySeq) {
      // 期间被更「新」的一次请求顶掉了 ⇒ 旧响应作废,交回缓存里的那份。
      const fresh = refCheckCache.get(key);
      if (fresh !== undefined) {
        return { ...fresh.result, fromCache: true };
      }
      return { ...previous, fromCache: true };
    }
    if (checkRuns === null && statuses === null) {
      // 两侧都失败:交回上一次的值(可能为 null),并带上错误 —— **不**清空。
      const stale: IRefChecksResult = { check: previous.check, error, fromCache: true };
      refCheckCache.set(key, { at: Date.now(), result: stale });
      return stale;
    }
    const result: IRefChecksResult = {
      check: createCombinedCheck(toRefChecks(checkRuns, statuses)),
      error: null,
      fromCache: false,
    };
    refCheckCache.set(key, { at: Date.now(), result });
    return result;
  })().finally(() => {
    // 只有**自己还是表里那一个**时才删:否则会把后来者(force)顶掉。
    if (refCheckInFlight.get(key) === task) {
      refCheckInFlight.delete(key);
    }
  });
  refCheckInFlight.set(key, task);
  return task;
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
