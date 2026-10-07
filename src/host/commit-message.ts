/**
 * 提交信息生成:用 DSH 的模型列表里的模型(ctx.llm.stream)读 diff 产出
 * `{title, description}`。
 *
 * 契约照 GitHub Desktop 的 Copilot 生成器:模型可能把 JSON 包在 ```json 里,
 * 解析要容错;只把 title 当必填。区别是我们用 ctx.llm 的任意已配置 provider,
 * 不涉及 Copilot 付费能力。
 *
 * 约定:diff 文本先截断(默认 24k 字符),避免大仓把请求撑爆。
 *
 * **失败一律带 `detail`(2026-10-07,用户报「生成错误时通知里缺失具体信息」)**:
 * 每一处失败都经 `modelCallDetail` / `rawOutputDetail` 把**真的拿到的机器事实**
 * (provider/model、`finish` 原因、`LlmFailure` 的 `code`/`status`/`requestId`/原文、
 * 已收到的模型输出、解析失败时的原样输出)拼成 `detail` 交给客户端弹窗的 `<pre>`。
 * 只放拿到的东西,一个字段都不编 —— 与 `docs/push-failure-surfaces.md` §10.5
 * 「让宿主命名已知条件」同一条纪律。**兜底占位符一个字没删**(「先做,不删」)。
 * @module dsh-git/host/commit-message
 */

import { GitServiceError } from './git-service.ts';
import type { RepoRegistry } from './repo-registry.ts';

/** 模型选择(来自客户端的 DSH 模型列表下拉)。 */
export interface LlmModelChoice {
  provider: string;
  model: string;
}

/** 下拉用的模型条目。 */
export interface LlmModelLite {
  provider: string;
  providerName: string;
  id: string;
  name: string;
}

export interface GeneratedCommitMessage {
  title: string;
  description: string;
  /** 实际使用的路由,界面回显用。 */
  provider: string;
  model: string;
}

/** ctx.llm 的结构切面。 */
interface LlmServiceLike {
  listProviders(): readonly { id: string; name: string }[];
  listModels(provider: string): Promise<readonly { id: string; name: string; provider: string }[]>;
  stream(options: Record<string, unknown>): AsyncIterable<unknown>;
}

export interface CommitMessageDeps {
  /** 懒取 llm 服务(缺省时功能降级为「不可用」而不是崩)。 */
  llm: () => LlmServiceLike | undefined;
  registry: RepoRegistry;
  /** 默认模型(设置里没选时的兜底);provider 为空表示未配置。 */
  defaultModel?: () => LlmModelChoice | undefined;
}

const DEFAULT_SYSTEM_PROMPT = [
  '你是 Git 提交信息助手。根据提供的 diff 生成一条提交信息。',
  '要求:',
  '1. 第一行是摘要,使用 Conventional Commits 前缀(feat/fix/docs/refactor/chore/test/style/perf/build/ci),不超过 72 个字符;',
  '2. 如果改动较大,补一个 description 字段,用简短要点说明改了什么与为什么;',
  '3. 用中文书写;',
  '4. 只输出 JSON,不要解释。',
  '输出格式:{"title":"...","description":"..."}',
].join('\n');

/** diff 文本上限:超出部分丢弃并标注。 */
const DIFF_CHAR_LIMIT = 24_000;

export class CommitMessageGenerator {
  constructor(private readonly deps: CommitMessageDeps) {}

  /** 可用的模型列表(按 provider 分组信息一起给)。 */
  async listModels(): Promise<LlmModelLite[]> {
    const llm = this.deps.llm();
    if (llm === undefined) return [];
    const out: LlmModelLite[] = [];
    let providers: readonly { id: string; name: string }[] = [];
    try {
      providers = llm.listProviders();
    } catch {
      return [];
    }
    for (const provider of providers) {
      try {
        const models = await llm.listModels(provider.id);
        for (const model of models) {
          out.push({
            provider: provider.id,
            providerName: provider.name,
            id: model.id,
            name: model.name === '' ? model.id : model.name,
          });
        }
      } catch {
        // 单个 provider 列举失败不影响其他 provider。
      }
    }
    return out;
  }

  /**
   * 生成提交信息。
   * @param input - diff 文本与模型选择。
   */
  async generate(input: {
    path: string;
    diff: string;
    files: readonly string[];
    stagedOnly: boolean;
    choice: LlmModelChoice;
    systemPrompt?: string;
  }): Promise<GeneratedCommitMessage> {
    const llm = this.deps.llm();
    if (llm === undefined) {
      throw new GitServiceError('internal', 'DSH 模型服务不可用,无法生成提交信息。');
    }
    const diff = truncate(input.diff, DIFF_CHAR_LIMIT);
    const fileList = input.files.length > 0 ? input.files.join('\n') : '(见 diff)';
    // 措辞跟着模型改:我们这里「纳入提交」= 用户勾选要提交的东西(勾选**不**写索引),
    // 所以不能再说「已暂存」—— 那会让模型按 git 索引去理解,和实际输入不符。
    const userPrompt = [
      input.stagedOnly ? '以下是用户纳入本次提交的改动:' : '以下是当前所有未提交的改动:',
      '',
      '涉及文件:',
      fileList,
      '',
      'diff:',
      '```diff',
      diff,
      '```',
    ].join('\n');

    const system = (input.systemPrompt ?? '').trim() !== ''
      ? (input.systemPrompt as string)
      : (this.deps.registry.prefSystemPrompt().trim() !== ''
        ? this.deps.registry.prefSystemPrompt()
        : DEFAULT_SYSTEM_PROMPT);

    let text = '';
    /*
     * 最后一条 `finish` 分片:失败时把它交给 `modelCallDetail` 当**机器事实**
     * (改前它被就地丢掉,于是「模型没有返回内容」这句话里没有任何具体信息)。
     */
    let lastFinish: unknown;
    try {
      for await (const chunk of llm.stream({
        provider: input.choice.provider,
        model: input.choice.model,
        system,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: userPrompt }],
        }],
        maxTokens: 800,
        temperature: 0.2,
      })) {
        const c = chunk as { type?: string; text?: string };
        if (c.type === 'text-delta' && typeof c.text === 'string') text += c.text;
        if (c.type === 'finish') {
          lastFinish = chunk;
          const reason = (c as { reason?: { kind?: string; failure?: { message?: string } } }).reason;
          if (reason?.kind === 'error' || reason?.kind === 'aborted') {
            /*
             * 占位符 `?? '未知错误'` **一个字没删**(「先做,不删」,而且
             * `push-failure-detail-probe.mjs` 的 A14 把「占位符仍然活着」钉成判据);
             * 但**具体信息不再只靠它**:`detail` 里逐字带上 provider/model 与
             * `LlmFailure` 的机器字段(见 `modelCallDetail`)。
             */
            throw new GitServiceError(
              'internal',
              `模型调用失败:${reason.failure?.message ?? '未知错误'}`,
              modelCallDetail(input.choice, { type: 'finish', reason }, text),
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof GitServiceError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new GitServiceError(
        'internal',
        `模型调用失败:${message}`,
        modelCallDetail(input.choice, error, text),
      );
    }

    if (text.trim() === '') {
      /*
       * 「模型没有返回内容」是**已知条件**,不是未知:宿主手里就有 `finish` 分片
       * (它的 `reason.kind` 能区分 `max-tokens` / `stop` / `aborted` …)。
       * 改前这句话只说「换一个模型再试」,用户看不出到底发生了什么 —— 与
       * `docs/push-failure-surfaces.md` §10.5 那条「让宿主命名已知条件」同一裁决。
       */
      throw new GitServiceError(
        'internal',
        '模型没有返回内容,请换一个模型再试。',
        modelCallDetail(input.choice, lastFinish, text),
      );
    }
    let parsed: { title: string; description: string };
    try {
      parsed = parseCommitMessageJson(text);
    } catch (error) {
      /*
       * 解析失败时**模型的原样输出就是唯一的具体信息** —— 改前它被整段丢掉,
       * 用户只看到「模型返回的内容无法解析为提交信息。」,无从判断模型到底说了什么。
       * `parseCommitMessageJson` 自己的行为一个字没改(它仍抛同一句话),
       * 这里只是把它的失败**再接上一层 detail**。
       */
      if (error instanceof GitServiceError) {
        throw new GitServiceError('internal', error.message, rawOutputDetail(input.choice, text));
      }
      throw error;
    }
    return {
      title: parsed.title,
      description: parsed.description,
      provider: input.choice.provider,
      model: input.choice.model,
    };
  }
}

/** `detail` 里逐字带上模型原样输出时的上限(超出部分**标注**截断,不静默丢)。 */
const RAW_OUTPUT_DETAIL_LIMIT = 2000;

/** 逐字渲染一个可能是任意形状的值(不 JSON.stringify 成一行,便于人读)。 */
function describeValue(value: unknown): string {
  if (value === undefined) {
    return '(没有)';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value === '' ? '(空字符串)' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 一次**模型调用失败**的机器事实 —— 弹窗 `<pre>` 里逐字播出的 `detail`。
 *
 * 为什么要有它(第一手):`commit-message/generate` 改前**每一处**失败都只抛
 * `{code, message}`,于是 provider 给出的 `code` / `status` / `requestId`
 * (`dsh-llm` 的 `LlmFailure` 真有这三个字段:`lib/typert.host.js` 的声明
 * `{message, code, status?, providerRetryAfterMs?, requestId?, offloadImages?}`)
 * 在宿主这一层就被丢掉了;用户在通知里看到的只有宿主拼的一句话。
 *
 * **只放真的拿到的东西**,一条都不编(没有的字段整行不写):
 *  · 生成用的 `provider/model`(一定是已知的,它就是请求参数);
 *  · `finish` 的 `kind`(区分 `error` / `aborted` / `max-tokens` / `stop` …);
 *  · provider 失败的 `code` / `status` / `requestId` / 原文;
 *  · **已经收到的模型输出**(共几字符 + 原文);一个字节都没有时如实写出来。
 *
 * ⚠️ 不写「退出码」这类不存在的东西(与 `docs/push-failure-surfaces.md` §10.5.2 同一条纪律)。
 * @param choice - 这次生成用的 provider/model。
 * @param failureContext - `finish` 分片、`reason.failure`、或抛出的异常;`undefined` = 没拿到。
 * @param textReceived - 到失败为止收到的模型输出。
 */
function modelCallDetail(
  choice: LlmModelChoice,
  failureContext: unknown,
  textReceived: string,
): string {
  const lines: string[] = [
    `生成用的模型: ${choice.provider}/${choice.model}`,
  ];
  const finish = failureContext as { type?: string; reason?: { kind?: string; failure?: Record<string, unknown> } } | undefined;
  const reason = finish !== undefined && finish !== null && finish.type === 'finish' ? finish.reason : undefined;
  if (reason !== undefined) {
    lines.push(`finish 原因: ${describeValue(reason.kind)}`);
    const failure = reason.failure;
    if (failure !== undefined && failure !== null) {
      lines.push(`provider 失败码: ${describeValue(failure.code)}`);
      if (failure.status !== undefined) {
        lines.push(`provider HTTP 状态: ${describeValue(failure.status)}`);
      }
      if (failure.requestId !== undefined) {
        lines.push(`provider 请求 id: ${describeValue(failure.requestId)}`);
      }
      lines.push(`provider 原文: ${describeValue(failure.message)}`);
    }
  } else if (failureContext !== undefined) {
    lines.push(`调用抛出的异常: ${describeValue(failureContext)}`);
  }
  lines.push(
    textReceived === ''
      ? '已收到的模型输出: 0 字符(一个字节都没有)'
      : `已收到的模型输出(${textReceived.length} 字符):\n${textReceived}`,
  );
  return lines.join('\n');
}

/**
 * 解析失败时的 `detail`:模型**原样输出**(唯一能解释「为什么解析不了」的证据)。
 *
 * 超出 {@link RAW_OUTPUT_DETAIL_LIMIT} 时**显式标注**截断 —— 不学
 * `git-service.ts` 那条静默 `slice(0, 2000)`:静默截断会让读者以为已经看完了。
 * @param choice - 这次生成用的 provider/model。
 * @param raw - 模型的原样输出。
 */
function rawOutputDetail(choice: LlmModelChoice, raw: string): string {
  const head = `生成用的模型: ${choice.provider}/${choice.model}\n`
    + `模型原样输出(无法解析为 {"title","description"}),共 ${raw.length} 字符:`;
  if (raw.length <= RAW_OUTPUT_DETAIL_LIMIT) {
    return `${head}\n${raw}`;
  }
  return `${head}\n${raw.slice(0, RAW_OUTPUT_DETAIL_LIMIT)}`
    + `\n…[已截断:原文共 ${raw.length} 字符,这里只保留前 ${RAW_OUTPUT_DETAIL_LIMIT} 字符]`;
}

/**
 * 容错解析:模型可能返回裸 JSON、```json 围栏、或前后带解释文字。
 * @param content - 模型原始输出。
 */
export function parseCommitMessageJson(content: string): { title: string; description: string } {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1]?.trim(), content.trim()].filter((s): s is string => s !== undefined && s !== '');
  for (const candidate of candidates) {
    const jsonText = extractJsonObject(candidate);
    if (jsonText === null) continue;
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const title = typeof record.title === 'string' ? record.title.trim() : '';
      if (title === '') continue;
      const description = typeof record.description === 'string' ? record.description.trim() : '';
      return { title, description };
    } catch {
      // 试下一个候选
    }
  }
  // 兜底:没有 JSON 时把第一行当摘要,其余当描述。
  const lines = content.trim().split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const title = (lines[0] ?? '').replace(/^["'`]|["'`]$/g, '').slice(0, 120);
  if (title === '') throw new GitServiceError('internal', '模型返回的内容无法解析为提交信息。');
  return { title, description: lines.slice(1).join('\n') };
}

/** 取第一个平衡的 JSON 对象(容忍前后有解释文字)。 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[diff 已截断,原长 ${text.length} 字符]`;
}
