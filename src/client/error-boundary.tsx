/**
 * **面板级错误边界** —— 一个面板在渲染期抛错时,只废掉**这个面板**,不废掉整个插件。
 *
 * ## 为什么必须是 class 组件、为什么手写(没有新依赖)
 *
 * React 18 的错误边界**只能**是 class 组件(`getDerivedStateFromError` /
 * `componentDidCatch`),函数组件没有等价物。上游 GitHub Desktop **没有**任何等价物:
 *
 * ```
 * grep -rn "componentDidCatch|getDerivedStateFromError" references/desktop/app/src/  → 0 命中
 * grep -rn "react-error-boundary" references/desktop/app/package.json              → 0 命中
 * ```
 *
 * ⇒ 「对齐优先」在这里**没有可沿用的东西**(目标文档 §2.1 的手写例外:上游那份不存在)。
 * 也不引入 `react-error-boundary`:本仓产物必须保持**恰好 4 个 require 家族**
 * (`react` / `react-dom` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives`),
 * 而这个边界 60 行就写完了,不需要第二个包。
 *
 * ## 放在哪一层(判据)
 *
 * 放在**面板**这一层,而不是插件根、也不是每个组件:
 *
 * | 层 | 效果 | 为什么不选 |
 * |---|---|---|
 * | 插件根 | 抛错 ⇒ 整个插件变一块回退 | **正是要避免的**:那等于现状(整个插件白掉),只是文案好看一点 |
 * | 每个组件 | 抛错 ⇒ 一个按钮变回退 | 边界数量爆炸,而且「一块面板坏了但它的兄弟还在」本来就是同一个面板状态机的事 |
 * | **面板(这里)** | 顶栏 / 当前页签内容 / 偏好弹窗 / 浮层各自独立 | **一次抛错只损失一块**,其余部分(含页签栏与底部状态条)照常可用 |
 *
 * 挂载点在 `workbench.tsx`,每块面板一个实例、`resetKey` 绑到「这块面板现在代表什么」
 * (页签 id / 仓库路径 / 弹窗是否打开),于是切页签或换仓库会**自动复位**边界 ——
 * 否则一次坏数据会让该面板永久停在回退上。
 *
 * ## 三条硬要求(本轮任务书)
 *
 * 1. **可见、诚实、指名道姓**:回退里写清是哪块面板、`error.name` / `error.message`、
 *    以及「其余面板不受影响」;还有**重试**按钮(数据重新拉取后重试是有意义的,
 *    重试次数会如实显示)。**绝不**静默渲染成空盒子 —— 静默的空正是这个缺陷族
 *    现在的表现,那是最坏的形态。
 * 2. **上报到持久的地方**:`console.error`(error + **组件栈**)+ 插件的 toast +
 *    `payload.ts` 的诊断环(探针据此断言「错误真的被上报了」,不必 spy console)。
 * 3. **不吞**:没有任何「开发环境才走」的静默分支。`componentDidCatch` 里
 *    **先上报再返回**;唯一的 `try/catch` 只包住次级上报(toast / 诊断写入),
 *    因为「上报本身抛错」绝不能把回退也带走 —— 那条 catch 自己还会 `console.error`。
 *    也**不**装全局 `window.onerror`/`unhandledrejection` 兜底(那会把异步错误
 *    也吞掉,而 React 边界本来就不该管异步错误)。
 *
 * ## 诚实的边界
 *
 * 它**只**接渲染期 / 生命周期抛错。事件回调(`onClick` 里抛)、`setTimeout`、
 * promise 拒绝**不会**被它接住(React 的语义如此)。那些路径今天靠各自的
 * `try/catch` 与 `ApiResult` 处理。
 *
 * @see src/client/payload.ts —— 边界层收窄(尽量不让错误走到这里)
 * @module dsh-git/client/error-boundary
 */

import { Component, createElement } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { reportDiagnostic } from './payload.ts';

export interface IErrorBoundaryProps {
  /**
   * 这块面板叫什么(用户看得懂的名字,会出现在回退标题里)。
   * 例:`变更` / `顶栏` / `dsh-git 偏好设置`。
   */
  readonly label: string;
  /**
   * 复位键:值变化 ⇒ 自动清掉回退重新渲染。
   *
   * 传「这块面板现在代表什么」(页签 id / 仓库路径 / 弹窗开关),
   * **不要**传每帧都变的临时值(那会让回退刚出现就被复位、看不出问题)。
   */
  readonly resetKey?: string | number | boolean | null;
  /** 次级上报通道(通常是 `store.toast`)。抛错也不会影响回退渲染。 */
  readonly onError?: (message: string) => void;
  readonly children?: ReactNode;
}

interface IErrorBoundaryState {
  readonly error: unknown;
  readonly componentStack: string;
  /** 已经重试过几次(如实显示,不假装「修好了」)。 */
  readonly attempts: number;
}

/** 把任意抛出物说成一句人话。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message === '' ? error.name : `${error.name}: ${error.message}`;
  }
  return String(error);
}

export class ErrorBoundary extends Component<IErrorBoundaryProps, IErrorBoundaryState> {
  /**
   * React 要求:返回部分新状态即可。
   *
   * 声明在字段**之前**:`@typescript-eslint/member-ordering` 的规则如此
   * (静态方法要先于字段定义)—— 不这么放会新增一条 lint 违规。
   */
  public static getDerivedStateFromError(error: unknown): Partial<IErrorBoundaryState> {
    return { error };
  }

  public state: IErrorBoundaryState = { error: null, componentStack: '', attempts: 0 };

  /**
   * ⚠️ `componentDidCatch` 是**真的** React 生命周期 —— 错误边界**唯一**的上报入口。
   * 本仓的自定义规则 `react-proper-lifecycle-methods` 从上游 GitHub Desktop 移植,
   * 而**上游没有错误边界**(`references/desktop` 里 0 命中),所以它的 switch 里没有
   * 这一支,落到 `default` 判成「拼错的生命周期名」。这里**有理由地**关掉那一条:
   * 名字是被 React 调的(`getDerivedStateFromError` 已经在上面证明了这条路径真的会跑),
   * 不是拼错。给 lint 那条线的建议:把 `componentDidCatch(error, errorInfo)` 加进
   * 那个 switch 的正确分支,这条 disable 就能删掉。
   */
  // eslint-disable-next-line react-proper-lifecycle-methods -- 见上:`componentDidCatch` 是真实存在的 React 生命周期(上游没有错误边界,所以规则里没有这一支)
  public componentDidCatch(error: unknown, info: ErrorInfo): void {
    const stack = info.componentStack ?? '';
    // ① 组件栈先落到 state:回退里要能展开看,而这**不**依赖任何可能坏掉的东西。
    this.setState({ componentStack: stack });
    // ② 诊断环 + console.error(带组件栈)。
    reportDiagnostic('渲染抛错', this.props.label, messageOf(error), stack);
    // ③ 次级上报:toast。它自己抛错**不能**把回退带走。
    try {
      this.props.onError?.(`「${this.props.label}」渲染失败:${messageOf(error)}`);
    } catch (reportingError) {
      console.error(`[dsh-git 渲染抛错] ${this.props.label} 的次级上报也失败了`, reportingError);
    }
  }

  public componentDidUpdate(prevProps: IErrorBoundaryProps): void {
    // 重置键变了 ⇒ 这块面板换了对象(切页签 / 换仓库 / 重开弹窗),回退必须让位。
    // 用 `!==` 而不是深比较:调用点传的都是标量。
    if (prevProps.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null, componentStack: '', attempts: 0 });
    }
  }

  private readonly onRetry = (): void => {
    this.setState((previous) => ({
      error: null,
      componentStack: '',
      // 次数只涨不清:重试三次还是同一块回退,用户与探针都该看到这件事。
      attempts: previous.attempts + 1,
    }));
  };

  public render(): ReactNode {
    const { error, componentStack, attempts } = this.state;
    if (error === null) {
      // 健康时**不加任何包裹元素** —— 多一层 div 会改变布局(目标文档 §11.1.1 的教训)。
      return this.props.children ?? null;
    }
    return createElement(
      'div',
      {
        className: 'gw-eb',
        role: 'alert',
        'data-gw-error-boundary': this.props.label,
        'data-gw-error-boundary-state': 'error',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          margin: '8px',
          padding: '10px 12px',
          border: '1px solid var(--dsw-alias-state-error-primary)',
          borderRadius: '6px',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
          fontSize: '12px',
          lineHeight: '1.5',
          overflow: 'auto',
        },
      },
      createElement('div', { style: { fontWeight: 600 } }, `「${this.props.label}」渲染失败了`),
      // 指名道姓:哪个组件抛的、抛的什么。
      createElement('div', { 'data-gw-error-message': '' }, messageOf(error)),
      createElement(
        'div',
        { style: { color: 'var(--dsw-alias-label-secondary)' } },
        '只有这一块受影响:其余面板(含页签栏、顶栏与底部状态)照常可用,切页签或关掉弹窗都正常。',
      ),
      createElement(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        createElement(
          'button',
          {
            type: 'button',
            className: 'gw-btn',
            'data-gw-error-boundary-retry': '',
            onClick: this.onRetry,
            style: {
              cursor: 'pointer',
              padding: '2px 10px',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: '4px',
              background: 'var(--dsw-alias-bg-layer-2)',
              color: 'inherit',
              font: 'inherit',
            },
          },
          '重试',
        ),
        attempts > 0
          ? createElement(
            'span',
            { 'data-gw-error-boundary-attempts': attempts, style: { color: 'var(--dsw-alias-label-secondary)' } },
            `已重试 ${attempts} 次`,
          )
          : null,
      ),
      createElement(
        'details',
        null,
        createElement('summary', { style: { cursor: 'pointer' } }, '技术细节(组件栈)'),
        createElement(
          'pre',
          {
            'data-gw-error-boundary-stack': '',
            style: {
              margin: '6px 0 0',
              padding: '6px',
              background: 'var(--dsw-alias-bg-layer-2)',
              borderRadius: '4px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              fontSize: '11px',
            },
          },
          componentStack === '' ? '(没有拿到组件栈)' : componentStack,
        ),
      ),
    );
  }
}
