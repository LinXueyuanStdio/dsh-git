/**
 * **提交信息输入框的右键菜单** —— 上游 `ui/changes/commit-message.tsx:929-950` 的
 * `onAutocompletingInputContextMenu` 在浏览器半的落点。
 *
 * ## 上游那一份菜单**能产出的全部项**(逐条带 `file:line`,一个不漏)
 *
 * | 序 | 项 | 上游出处 | 出现条件 |
 * |---|---|---|---|
 * | 1 | `Add co-authors` / `Remove co-authors` | `:863-873`(`getAddRemoveCoAuthorsMenuItem`) | 总在列;`enabled = repository.gitHubRepository !== null && isCommitting !== true`(`:869-871`) |
 * | 2 | `Generate Commit Message with Copilot` | `:875-909`(`getGenerateCommitMessageMenuItem`) | **条件产项**:`accounts.some(enableCommitMessageGeneration) && onGenerateCommitMessage !== undefined`(`:884-889`)⇒ 不满足时**这一项根本不 push** |
 * | — | 分隔符 | `:938` | |
 * | 3 | **`{ role: 'editMenu' }`** | `:939` | 恒在。它是 Electron 的**角色**,由主进程展开成平台编辑项:`build-context-menu.ts:67-71` 读 `getEditMenuItems()`(`:16-30`,Electron 自带 `editMenu` 模板去掉 `pasteandmatchstyle`),注释逐字说那是 **platform-specific edit menu items** ⇒ Undo / Redo / 分隔符 / Cut / Copy / Paste / Delete / Select All(macOS 另有系统项:听写 / 表情与符号) |
 * | — | 分隔符 | `:940` | |
 * | 4 | `Disable Commit Spellcheck` / `Enable Commit Spellcheck` | `:952-963`(`getCommitSpellcheckEnabilityMenuItem`) | 恒在;文字随 `props.commitSpellcheckEnabled` 反转 |
 * | 5 | **拼写建议块**(词典建议 / `Add to Dictionary` / 非 macOS 的「Set spellcheck to …」) | `:949` 的 `showContextualMenu(items, true)` 第二参 ⇒ `lib/menu-item.ts:82-89`(`addSpellCheckMenu`)⇒ 主进程 `main.ts:502-509` 调 `buildSpellCheckMenu`(`main-process/menu/build-spell-check-menu.ts:34-105`),由 Electron 的 `params.dictionarySuggestions` / `misspelledWord` 生成 | 只有右键落在**拼错词**上才有(`:35-38` 空则返回) |
 *
 * 上游另有一条**同文件、不同落点**的 `onContextMenu`(`:911-927`):它挂在**外层容器**
 * 上,且第一句就是 `if (event.target instanceof HTMLTextAreaElement || HTMLInputElement) return`
 * —— 也就是说**输入框上的右键走的是上面那张表**(`:1795` 摘要 / `:1832` 描述两处都把
 * `onContextMenu` 传给了 `onAutocompletingInputContextMenu`),容器那一条只服务
 * 「右键在提交框的非输入区」。本模块**只**做输入框那一条(功能点 7.24 的行文就是
 * 「提交信息输入的右键菜单」);容器那一条只有第 1、2 项,属于 7.14 / 7.17 那条线,
 * 与「编辑命令」无关,不在这里实现。
 *
 * ## 本模块实现了什么 / 登记了什么(**不许静默缺**)
 *
 * | 上游项 | 这里 | 理由(不是「忘了」) |
 * |---|---|---|
 * | `{role:'editMenu'}` 的 Undo / Redo / Cut / Copy / Paste / Delete / Select All | **实现** | 逐条都是真命令,见下面「机制」一节;`role` 交给 `context-menu-host.tsx` 的 `runRole` 执行(该模块**本来**就只处理了 `copy`) |
 * | macOS 的听写 / 表情与符号(Electron platform-specific 项) | **未实现**(登记) | 浏览器半没有打开系统听写/字符检视器的 API |
 * | 拼写建议块(词典建议 / Add to Dictionary / 设语言) | **未实现**(登记) | 建在 Electron 主进程的拼写检查器上(`build-spell-check-menu.ts:34-105` 读 `webContents` 的 `params`),**浏览器半没有任何等价 API**:页内脚本既拿不到「当前光标下是不是拼错词」,也拿不到候选词表。⛔ 不发明拼写检查、不伪造建议行 |
 * | `Add co-authors` / `Remove co-authors` | **未实现**(登记) | 上游 `enabled` 要求 `repository.gitHubRepository !== null`,而本插件**两处构造都传 `null`**(功能点 7.14 的阻塞者),协同作者行在**产品形状下根本不渲染** ⇒ 摆进来就是一行恒禁用的死项 |
 * | `Generate Commit Message with Copilot` | **未实现**(**决定**,不是能力缺口) | 我们的「生成提交信息」是**操作行里那颗按钮 + 模型选择器**(功能点 7.17/7.18,用户点名的能力),上游那一项另有 Copilot 账户闸门(`:884-889`)。要不要在菜单里再放一个**第二入口**是产品裁决,不在 7.24 这条(编辑命令)里 —— 需要时单独做,⛔ 不要为了「看起来一致」把它凑进来 |
 * | 拼写检查开关(`Disable/Enable Commit Spellcheck`) | **未实现**(登记) | 键与两个输入框的 `spellCheck` 属性都没有(功能点 7.21 / 12.14),`src/client/**` 里**没有**这个键的读写方 ⇒ 菜单里放一项点了不改变任何状态,是**看得见的空操作** |
 *
 * ## 机制:为什么是这几条命令、为什么粘贴要手写
 *
 * 上游那 7 条来自 **Electron 的角色展开**,不是一串普通菜单项。浏览器半的等价物只有
 * `document.execCommand`。**真 Chrome 实测**:
 * `undo`/`redo`/`cut`/`copy`/`delete`/`selectAll` 六条由
 * `docs/probes/changes-commit-input-menu-probe.mjs` 的 **C 组现场跑出**(它量的是「值真的变了 /
 * 剪贴板真的拿到了」);而 `paste` 那一行与下面第 3 条的 `queryCommandEnabled` 是**一次性实验**
 * 的读数(探针**不重跑**它们,也不该拿它们当判据 —— 见那份探针文件头的「诚实边界」第 9 条):
 *
 * | 命令 | `execCommand` | 实测 |
 * |---|---|---|
 * | `undo` / `redo` | ✅ | 可信手势里返回 true,并真的改值(还会派发 `inputType: historyUndo/historyRedo` 的 `input` 事件 ⇒ React 的 `onChange` 跟着跑) |
 * | `cut` / `copy` | ✅ | **必须有可信用户手势**(无手势时返回 false);点击菜单项本身就是手势 |
 * | `delete` | ✅ | 同上 |
 * | `selectAll` | ✅ | 同上 |
 * | `paste` | ❌ | **`execCommand('paste')` 对网页内容恒为 false**(实测:即使有可信手势 + 已授予 `clipboardReadWrite` 权限也一样)⇒ 粘贴只能走 Clipboard API,见下 |
 *
 * 所以:6 条走 `role`(复用 `context-menu-host.tsx` 已有的 `role` 执行口),
 * **粘贴这一条手写**(`role:'paste'` 在浏览器里是个空操作,摆上去就是死项)。
 *
 * ## 诚实边界(这些都不是「已实现」)
 *
 * 1. **原生菜单被取代**:本模块在 `onContextMenu` 里 `preventDefault()`
 *    (`showCommitInputMenu` 的调用方,与文件列表那一族同一个约定),所以**真浏览器里
 *    原生右键菜单不再出现在这两个输入框上** —— 代价是浏览器的**原生拼写建议**
 *    与**原生粘贴**也一并不可达。前者没有替代品(上表已登记),后者由本模块的
 *    「粘贴」项接住(权限被拒时**出一声**:见 `PASTE_DENIED_NOTICE`)。
 * 2. **`enabled` 读的是「有没有文本」,不是「有没有选区」** —— 这是一条**实测出来的**
 *    决定,不是随手:真 Chrome(macOS 档)里右键一个词的时序是
 *    `mousedown`(选区 `[0,0]`)→ **`contextmenu`(选区 `[3,3]`,即光标已落、词还没选)**
 *    → `mouseup`(选区 `[0,5]`,**这时 Chrome 才把那个词选中**)。
 *    而我们的菜单项是在 `contextmenu` 那一刻就建好的 ⇒ 若按选区判闸门,
 *    「右键一个词 ⇒ 复制被灰掉」——那是个用户一眼能看见的错误(原生菜单那时是可点的)。
 *    ⇒ 闸门改为 `value !== ''`(空输入框 ⇒ 剪切/复制/删除灰掉,与原生菜单一致;
 *    非空 ⇒ 可用,因为 Chrome 在 `mouseup` 必然给出一段词选区)。
 *    时序读数的原始记录在 `docs/probes/changes-commit-input-menu-probe.mjs` 的文件头。
 * 3. **撤销/重做无法灰掉**:Electron 的原生菜单会按撤销栈把 Undo/Redo 变灰;
 *    我们查不到那个状态(`document.queryCommandEnabled('undo')` 在 Chrome 里实测
 *    **恒 false**,用它当 `enabled` 会把整份菜单灰掉)⇒ 这两项只按只读拦,
 *    没东西可撤销时点了没有可见变化。**登记过的保真度缺口**。
 * 4. **粘贴依赖剪贴板权限**:见 `pasteFromClipboard` 的 JSDoc。
 *
 * @module dsh-git/client/commit-input-menu
 */

import { installContextMenuHost } from './context-menu-host.tsx';
import { showContextualMenu } from '../core/desktop/lib/menu-item.ts';
import type { IMenuItem } from '../core/desktop/lib/menu-item.ts';

/** 两个提交信息输入框的共同类型(摘要 `<input>` / 描述 `<textarea>`)。 */
export type CommitInputElement = HTMLInputElement | HTMLTextAreaElement;

/**
 * 输入框在**右键那一刻**的可编辑状态。
 *
 * 为什么是**纯数据**而不是直接传元素:`enabled` 的判定(有没有文本 / 是不是只读 /
 * 剪贴板 API 在不在)是这份 item 列表里**唯一的逻辑**,把它变成一个可构造的入参
 * ⇒ 探针能对同一份实现喂三档状态(**空 / 有文本 / 只读**)而不必驱动真浏览器,
 * 判据因此是「这一格闸门真的读了我喂的那个状态」(先例:`changes-file-menu.ts` 的
 * `changesFileMenuItems` 也把「能力」当入参传,而不是读全局)。
 *
 * ⚠️ **刻意没有 `selectionStart/End`**:闸门读的是 `value`,理由(时序实测)见模块头
 * 「诚实边界」第 2 条 —— 按选区判会把「右键一个词」判成「没有选区」。
 */
export interface ICommitInputState {
  /** 输入框是不是只读(生成中/提交中,上游 `commit-message.tsx:1796-1798`)。 */
  readonly readOnly: boolean;
  /** 输入框当前的文本(空 ⇒ 剪切/复制/删除没有对象)。 */
  readonly value: string;
}

/** 从真元素取状态(唯一的产品调用口径)。 */
export function commitInputStateOf(target: CommitInputElement): ICommitInputState {
  return { readOnly: target.readOnly === true, value: target.value };
}

/** 右键菜单里那一条条命令要做的事(依赖注入,照 `changes-file-menu.ts` 的 `actions` 形状)。 */
export interface ICommitInputMenuActions {
  /** 「粘贴」被点中。**只有这一条不走 `role`**,理由见模块头。 */
  readonly paste: () => void;
}

/**
 * 粘贴失败(读剪贴板被拒 / 没有 API)时要说的那句话。
 *
 * 为什么必须有这句:把原生菜单挡掉之后,粘贴是**我们**的责任;读剪贴板失败时
 * 静默 no-op 就成了「看得见、点不动」的那一类控件(本仓明令禁止)。
 * 文案里给出**用户马上能做的替代动作**(快捷键),不是一句「暂不支持」。
 */
export const PASTE_DENIED_NOTICE =
  '浏览器拒绝了读取剪贴板(Clipboard API 不可用或权限被拒)⇒ 请用 Cmd/Ctrl+V 粘贴。';

/** 剪贴板里没有文本时的提示(同样是「出一声」,不是静默)。 */
export const PASTE_EMPTY_NOTICE = '剪贴板里没有可粘贴的文本。';

/** 输入框里有没有文本 —— 剪切/复制/删除三项的 `enabled` 只读它(理由见模块头第 2 条)。 */
export function commitInputHasText(state: ICommitInputState): boolean {
  return state.value !== '';
}

/** 浏览器半有没有可用的剪贴板**读**能力(决定「粘贴」是否在列可点)。 */
export function canReadClipboard(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    navigator.clipboard !== undefined &&
    typeof navigator.clipboard.readText === 'function'
  );
}

/**
 * 造出提交信息输入框的右键菜单项。
 *
 * 项序 = Electron `editMenu` 的项序(`build-context-menu.ts:16-30` 展开出来的那一串,
 * 去掉 `pasteandmatchstyle`):Undo / Redo / — / Cut / Copy / Paste / Delete / Select All。
 *
 * ⚠️ **上游那两条分隔符(`commit-message.tsx:938` / `:940`)没有抄**:它们分隔的是
 * 「协同作者 / 生成」与「拼写开关」两组,而那两组在本模块里**未实现**(见模块头),
 * 于是这两条分隔符只剩首尾两条空线 —— 不摆。`editMenu` 自己内部的那一条
 * (Redo 与 Cut 之间)**保留**。
 *
 * @param state - 右键那一刻的输入框状态。
 * @param actions - 「粘贴」的落点。
 */
export function commitInputMenuItems(
  state: ICommitInputState,
  actions: ICommitInputMenuActions,
): IMenuItem[] {
  const editable = state.readOnly !== true;
  const hasText = commitInputHasText(state);

  return [
    // 上游 Undo / Redo。⚠️ 没有闸门可用(模块头第 3 条),所以只按只读拦。
    { label: '撤销', role: 'undo', enabled: editable },
    { label: '重做', role: 'redo', enabled: editable },
    // Electron `editMenu` 内部的那一条分隔符(Redo 与 Cut 之间)。
    { type: 'separator' },
    { label: '剪切', role: 'cut', enabled: editable && hasText },
    // 复制对**只读**输入框仍然有效(原生 Chrome 也一样),所以不看 `editable`。
    { label: '复制', role: 'copy', enabled: hasText },
    // ⚠️ 唯一一条 `action`:浏览器半没有 `execCommand('paste')`(模块头表)。
    { label: '粘贴', action: () => actions.paste(), enabled: editable && canReadClipboard() },
    { label: '删除', role: 'delete', enabled: editable && hasText },
    { label: '全选', role: 'selectAll', enabled: true },
  ];
}

/**
 * 打开提交信息输入框的右键菜单。
 *
 * **调用方必须先 `event.preventDefault()`**(与文件列表的 `rowMenu` / `headerMenu`
 * 同一个约定):挡掉浏览器原生菜单是「我们的菜单能被看见」的前提 —— 原生菜单画在
 * 网页内容之上,不挡就只会看到原生那一个。代价与登记见模块头「诚实边界」第 1 条。
 *
 * @param state - 右键那一刻的输入框状态。
 * @param actions - 「粘贴」的落点。
 * @returns 菜单关闭后 resolve(与上游 `showContextualMenu` 同形)。
 */
export async function showCommitInputMenu(
  state: ICommitInputState,
  actions: ICommitInputMenuActions,
): Promise<void> {
  installContextMenuHost();
  await showContextualMenu(commitInputMenuItems(state, actions));
}

/** `pasteFromClipboard` 的结果(探针按它判据,UI 按它出声)。 */
export type PasteOutcome = 'pasted' | 'denied' | 'unsupported' | 'empty';

/**
 * **粘贴**(上游 `editMenu` 的 Paste 在本仓的唯一天真实现)。
 *
 * ## 为什么手写(这是「不许静默缺」那一条的落点)
 *
 * - `document.execCommand('paste')` **对网页内容恒为 false**(真 Chrome 实测:
 *   可信手势 + 已授 `clipboardReadWrite` 权限也一样)—— 它只对 Electron/扩展可用;
 * - 于是唯一的通道是 `navigator.clipboard.readText()`:安全上下文(本插件跑在
 *   `http://127.0.0.1:<port>`,`127.0.0.1` 算安全上下文)+ `clipboard-read` 权限。
 *   **权限被拒或 API 不在时这里出声**(`notify`),绝不静默 no-op;
 * - **插入**这一段**不手写 `setRangeText` + 伪造 `input` 事件**:改用
 *   `document.execCommand('insertText')` —— 它本身就是浏览器的编辑命令(实测返回
 *   true,并派发 `inputType: insertText` 的 `input` 事件,React 的 `onChange` 因此
 *   照常跑,还能被 Cmd+Z 撤销)。少一段手写就意味着少一处「DOM 值与 React state
 *   不同步」的机会。
 *
 * ## 边界(不是「已实现」的那部分)
 *
 * - 真浏览器里第一次点「粘贴」会弹 Chrome 自己的剪贴板权限询问(本探针**不测**
 *   那个弹窗的交互:headless 里没有 UI,只能用 CDP 预授权/撤销权限两档来测
 *   「成功路径」与「被拒路径」);
 * - 本模块**不**碰 `navigator.clipboard.writeText`(那是复制路径要用的,而我们用的是
 *   `execCommand('copy')`,理由同上:它是浏览器自己的命令,与原生菜单同源)。
 *
 * @param target - 要粘贴进去的输入框。
 * @param notify - 出错/空剪贴板时的**出声**通道(产品里是 `store.toast(msg, kind)`)。
 * @returns 结局:粘上了 / 被拒 / 没有 API / 剪贴板是空的。
 */
export async function pasteFromClipboard(
  target: CommitInputElement,
  notify: (message: string, kind: 'ok' | 'err') => void,
): Promise<PasteOutcome> {
  if (!canReadClipboard()) {
    notify(PASTE_DENIED_NOTICE, 'err');
    return 'unsupported';
  }

  /*
   * 焦点先还给输入框:光标(选区)跟焦点走,而菜单层把焦点放到了第一个可用项上。
   * 顺序是「先聚焦、再 await」—— `readText()` 是一个异步权限往返,期间焦点可能被
   * 用户点走(那时插入落到别处才是对的),所以这里不锁焦点、也不在 await 之后
   * 再抢一次。
   */
  target.focus();

  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    notify(PASTE_DENIED_NOTICE, 'err');
    return 'denied';
  }

  if (text === '') {
    notify(PASTE_EMPTY_NOTICE, 'ok');
    return 'empty';
  }

  document.execCommand('insertText', false, text);
  return 'pasted';
}
