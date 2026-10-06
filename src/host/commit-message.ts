/**
 * 提交信息生成:用 DSH 的模型列表里的模型(ctx.llm.stream)读 diff 产出
 * `{title, description}`。
 *
 * 契约照 GitHub Desktop 的 Copilot 生成器:模型可能把 JSON 包在 ```json 里,
 * 解析要容错;只把 title 当必填。区别是我们用 ctx.llm 的任意已配置 provider,
 * 不涉及 Copilot 付费能力。
 *
 * 约定:diff 文本先截断(默认 24k 字符),避免大仓把请求撑爆。
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
          const reason = (c as { reason?: { kind?: string; failure?: { message?: string } } }).reason;
          if (reason?.kind === 'error' || reason?.kind === 'aborted') {
            throw new GitServiceError('internal', `模型调用失败:${reason.failure?.message ?? '未知错误'}`);
          }
        }
      }
    } catch (error) {
      if (error instanceof GitServiceError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new GitServiceError('internal', `模型调用失败:${message}`);
    }

    if (text.trim() === '') {
      throw new GitServiceError('internal', '模型没有返回内容,请换一个模型再试。');
    }
    const parsed = parseCommitMessageJson(text);
    return {
      title: parsed.title,
      description: parsed.description,
      provider: input.choice.provider,
      model: input.choice.model,
    };
  }
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
