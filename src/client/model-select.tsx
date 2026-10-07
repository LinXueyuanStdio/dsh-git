/**
 * **模型选择器** —— Changes 提交区里「生成」右边那个控件(用户 2026-10-07)。
 *
 * ## 它为什么不是原生 `<select>`(实测过,别再走回头路)
 *
 * 用户的两条文案要求是:
 *  1. **收起时只显示模型名**(不带 provider);
 *  2. **下拉列表里保持原设计**:每一项 `name · providerName`,provider 名在**末尾**。
 *
 * 看着正好是 `<option label>` 的用途,但**本机 headless Chrome 实测否掉了它**:
 *
 * ```
 * <select><option label="Model OK">Model OK · Provider AAAA</option>…</select>
 * Accessibility.getPartialAXTree →
 *   combobox  value = "Model OK"        ← 收起状态**确实**用 label(截图也确认)
 *   option    name  = "Model OK"        ← 但列表项的名字**也是** label
 * ```
 *
 * ⇒ 挂 `label` 会让列表里**也**看不到 provider 名。原生 `<select>` 满足不了这两条。
 *
 * ## 定位/翻转/可用高度:**用已经装好的成熟开源库,不手搓**
 *
 * 用户两次点到这里:「为什么不用下拉框按钮控件?」「要不你用成熟的开源第三方控件来实现?」
 * 本仓的硬约束是**不新增 npm 依赖**,所以不能用一个新的第三方 UI 包;但位置这件事
 * **本来就有现成的、并且本仓已经装了的**库:`@floating-ui/react-dom`
 * (`package.json:72`,镜像里的上游 `ui/lib/popover.tsx:9` 用的就是它)。
 * 于是:
 *
 * | 这一层 | 谁负责 |
 * |---|---|
 * | 锚定锚点元素、`flip`(上下翻转)、`shift`(不越出视口)、`size`(**把可用高度交给滚动容器**)、`autoUpdate`(祖先滚动/尺寸变化时自动重定位) | **`@floating-ui/dom` 的 `computePosition` + `autoUpdate`**(经 `@floating-ui/react-dom` 再导出;成熟库,**不用它的 React 钩子**,理由见下面那条 ⚠️) |
 * | 列表内容 / `role=listbox` / 键盘走位 / 选中语义 | 本组件(宿主原语包里**没有** Select/Combobox —— 只有命令菜单 `Menu*`,那是 `role=menu` 语义,拿来做「值选择」是无障碍上的反模式) |
 *
 * ## 两个已经踩过的坑(都在本文件里修掉了,别再犯)
 *
 * 1. **「列表出现即立刻消失」**(用户 2026-10-07 报的):第一版在
 *    `window` 上加 `scroll` 监听,任何滚动都 `closeList()`。而列表为了把高亮项滚进
 *    可视区调了 `scrollIntoView` —— 它会滚**祖先容器**,于是 `scroll` 事件把列表当场关掉。
 *    ⇒ 现在:① 交给 `autoUpdate` **重定位**而不是关闭;② 键盘高亮**手工算 `scrollTop`**
 *    (只滚列表自己),不用 `scrollIntoView`;
 * 2. **「列表太长,滚不动」**(用户第二轮报的):列表必须有自己的高度上限 + `overflow-y:auto`,
 *    上限由 `size()` 的 `availableHeight` 给出 —— 于是它一定放得进视口、也一定能滚。
 *
 * ## 无障碍(自绘控件必须自己兑现的部分)
 *
 * · 按钮:`aria-haspopup="listbox"` + `aria-expanded` + `aria-controls`;
 * · 列表:`role="listbox"`,每一项 `role="option"` + `aria-selected`;
 * · **焦点留在按钮上**,高亮项用 `aria-activedescendant` 表达(select-only combobox 的形状);
 * · 键位:`↓/↑/Home/End` 移动高亮、`Enter/Space` 选中、`Esc` 关闭、`Tab` 关闭;
 * · 关闭后焦点**归还**按钮;点外面(mousedown 捕获)关闭。
 *
 * @module dsh-git/client/model-select
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as ReactDOM from 'react-dom';
/*
 * ⚠️ **只取框架无关的那几个 API**(`@floating-ui/react-dom` 会 `export * from '@floating-ui/dom'`)。
 * **不要**用它的 React hooks(`useFloating` 等):那族内部调 `React.useId`(18 才有),
 * 而本仓的探针环境是 React 17 —— 组件一渲染就会
 * `TypeError: (0 , import_react19.useId) is not a function`,整棵 ChangesView 被卸载,
 * 看起来像「提交表单坏了」。这里自己管 `computePosition` + `autoUpdate` 的生命周期,
 * 定位/翻转/可用高度仍然全是这个成熟库算的。
 */
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/react-dom';

/** 宿主模型清单的一项(`core/types` 那一层的投影,与 `snap.models` 同形)。 */
export interface IModelSelectEntry {
  provider: string;
  providerName: string;
  id: string;
  name: string;
}

/**
 * 列表的**最大高度**。长清单靠它 + `overflow-y:auto` 滚动 ——
 * 这正是第一版(右键菜单宿主)缺的那一样,用户两次报的都是它。
 */
const LIST_MAX_HEIGHT = 240;
/** 可用空间再小也至少留这么高(不然列表会矮到没法用;此时它仍然可滚)。 */
const LIST_MIN_HEIGHT = 96;
/** 与视口边缘留的缝(交给 floating-ui 的 `padding`)。 */
const VIEWPORT_MARGIN = 8;
/** 按钮与列表之间的间距。 */
const GAP = 4;
/** `listId` 的计数器(见组件里那条「不要用 React.useId」的注释)。 */
let idSeq = 0;

/**
 * 按钮**收起时**显示的文字 —— **只有模型名**(用户第一轮追加要求)。
 *
 * 找不到(宿主落盘的 pin 不在可用清单里 / 清单还没到)时退回原始 `provider/id`:
 * 宁可显示一个丑但真实的值,也不假装它可用、更不显示空。
 * @param models - 宿主可用模型清单。
 * @param model - 当前 `provider/id`。
 */
export function modelButtonText(
  models: readonly IModelSelectEntry[],
  model: string,
): string {
  const found = models.find((m) => `${m.provider}/${m.id}` === model);
  if (found !== undefined) {
    return found.name;
  }
  return model === '' ? '未选模型' : model;
}

/**
 * 列表里每一项的文字 —— `name · providerName`(**provider 名在末尾**,用户要求保持不变)。
 * @param entry - 模型清单的一项。
 */
export function modelOptionText(entry: IModelSelectEntry): string {
  return `${entry.name} · ${entry.providerName}`;
}

/**
 * 模型选择器。
 * @param props.models - 宿主可用模型清单(`snap.models`)。
 * @param props.value - 当前 `provider/id`(`snap.model`)。
 * @param props.onSelect - 选中一项时回调(传 `provider/id`;调用方负责落盘偏好)。
 */
export function ModelSelect(props: {
  models: readonly IModelSelectEntry[];
  value: string;
  onSelect: (next: string) => void;
}): ReactNode {
  const { models, value, onSelect } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [maxHeight, setMaxHeight] = useState(LIST_MAX_HEIGHT);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /*
   * ⚠️ **不要用 `React.useId`**(18 才有):本仓的探针环境是 React 17,组件一渲染就
   * `TypeError: (0 , import_react19.useId) is not a function` ⇒ 整棵 ChangesView 被卸载,
   * 现象是「提交表单没了」(看起来像产品坏了)。id 只需要**同一次挂载内稳定且全页唯一**,
   * 一个模块级计数器就够(`useState` 的惰性初值只在挂载时跑一次)。
   */
  const [listId] = useState(() => `gw-model-select-${(idSeq += 1)}`);
  const currentIndex = models.findIndex((m) => `${m.provider}/${m.id}` === value);

  /*
   * 位置、翻转、不越界、**可用高度**全交给 floating-ui 的 `computePosition`,
   * 并用它的 `autoUpdate` 在**祖先滚动 / 尺寸变化**时自动重算 ——
   * 所以「滚一下列表就没了」这个缺陷从根上不存在了(重定位,而不是关闭)。
   *
   * ⚠️ `computePosition` 是异步的(promise);`size().apply()` 里**直接写样式**,
   * 这是不用 React 钩子时的标准用法。
   */
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const reference = buttonRef.current;
    const floating = listRef.current;
    if (reference === null || floating === null) {
      return undefined;
    }
    const update = (): void => {
      void computePosition(reference, floating, {
        placement: 'bottom-start',
        strategy: 'fixed',
        middleware: [
          offset(GAP),
          flip({ padding: VIEWPORT_MARGIN }),
          shift({ padding: VIEWPORT_MARGIN }),
          size({
            padding: VIEWPORT_MARGIN,
            apply({ availableHeight, x, y }) {
              floating.style.left = `${x}px`;
              floating.style.top = `${y}px`;
              setMaxHeight(Math.max(LIST_MIN_HEIGHT, Math.min(LIST_MAX_HEIGHT, Math.floor(availableHeight))));
            },
          }),
        ],
      });
    };
    update();
    return autoUpdate(reference, floating, update);
  }, [open]);

  /* 两个 ref 回调都必须 `useCallback`:本仓的 `react/jsx-no-bind` 会把内联箭头算成违规。 */
  const setReference = useCallback((node: HTMLButtonElement | null): void => {
    buttonRef.current = node;
  }, []);
  const setFloating = useCallback((node: HTMLDivElement | null): void => {
    listRef.current = node;
  }, []);

  const openList = useCallback((): void => {
    setActive(currentIndex < 0 ? 0 : currentIndex);
    setOpen(true);
  }, [currentIndex]);

  const closeList = useCallback((refocus: boolean): void => {
    setOpen(false);
    if (refocus && buttonRef.current !== null) {
      buttonRef.current.focus();
    }
  }, []);

  const select = useCallback((index: number): void => {
    const entry = models[index];
    if (entry === undefined) {
      closeList(true);
      return;
    }
    onSelect(`${entry.provider}/${entry.id}`);
    closeList(true);
  }, [closeList, models, onSelect]);

  /* 点外面关闭(捕获阶段,免得被列表自己的点击抢先)。 */
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onDocumentMouseDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (buttonRef.current?.contains(target) === true || listRef.current?.contains(target) === true) {
        return;
      }
      closeList(false);
    };
    document.addEventListener('mousedown', onDocumentMouseDown, true);
    return () => { document.removeEventListener('mousedown', onDocumentMouseDown, true); };
  }, [closeList, open]);

  /*
   * 键盘高亮移动之后,**只滚列表自己**(手工算 scrollTop)。
   *
   * ⚠️ 不要用 `scrollIntoView`:它会连**祖先容器**一起滚,而那正是第一版
   * 「列表出现即立刻消失」的机制(scroll 事件把浮层关掉)。选项是列表的直接子元素,
   * 所以 `offsetTop`/`offsetHeight` 就是相对列表内容盒的量。
   */
  useEffect(() => {
    if (!open) {
      return;
    }
    const list = listRef.current;
    const option = list?.querySelector<HTMLElement>('[data-gw-model-active="true"]');
    if (list === null || list === undefined || option === null || option === undefined) {
      return;
    }
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [active, open]);

  const onButtonKeyDown = useCallback((event: React.KeyboardEvent): void => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openList();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeList(true);
      return;
    }
    if (event.key === 'Tab') {
      closeList(false);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(active);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (models.length === 0) {
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((prev) => (prev + step + models.length) % models.length);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActive(Math.max(0, models.length - 1));
    }
  }, [active, closeList, models.length, open, openList, select]);

  const onButtonClick = useCallback((): void => {
    if (open) {
      closeList(false);
      return;
    }
    openList();
  }, [closeList, open, openList]);

  /*
   * 列表内的交互走**事件委托**(在容器上挂一次),而不是每一行各写一个内联箭头 ——
   * 后者会给本仓的 `react/jsx-no-bind` 增加新违规(闸门是「0 new」)。
   */
  const optionIndexOf = (target: EventTarget | null): number => {
    if (!(target instanceof Element)) {
      return -1;
    }
    const option = target.closest('[role="option"]');
    if (option === null) {
      return -1;
    }
    const raw = option.getAttribute('data-gw-model-index');
    return raw === null ? -1 : Number(raw);
  };
  const onListMouseOver = useCallback((event: React.MouseEvent): void => {
    const index = optionIndexOf(event.target);
    if (index >= 0) {
      setActive(index);
    }
  }, []);
  const onListMouseDown = useCallback((event: React.MouseEvent): void => {
    /* 不让列表抢焦点:焦点必须留在按钮上(键位与 aria-activedescendant 都挂在它身上)。 */
    event.preventDefault();
  }, []);
  const onListClick = useCallback((event: React.MouseEvent): void => {
    const index = optionIndexOf(event.target);
    if (index >= 0) {
      select(index);
    }
  }, [select]);

  const text = modelButtonText(models, value);
  const activeId = open && models[active] !== undefined ? `${listId}-${active}` : undefined;

  const list = open
    ? ReactDOM.createPortal(
      <div
        ref={setFloating}
        id={listId}
        role="listbox"
        data-gw-model-list=""
        aria-label="生成用的模型"
        style={{
          /*
           * `position:fixed` + `left/top` 由上面那个 effect 里的 `size().apply()` 写;
           * 初值 0 只存在于首帧(下一帧就被算好的坐标覆盖)。
           */
          position: 'fixed',
          left: 0,
          top: 0,
          /*
           * **这两行就是「列表太长、滚不动」的修法**:高度上限来自 floating-ui 的
           * `size()`(可用空间),超出**滚动**。
           */
          maxHeight: `${maxHeight}px`,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          minWidth: '160px',
          maxWidth: '320px',
          padding: '4px',
          background: 'var(--dsw-alias-bg-layer-3, #ffffff)',
          border: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.35))',
          borderRadius: '6px',
          boxShadow: '0 6px 24px rgba(0, 0, 0, 0.24)',
          color: 'var(--dsw-alias-label-primary, inherit)',
          fontSize: '12px',
          lineHeight: '1.4',
          zIndex: 2147483000,
        }}
        onMouseOver={onListMouseOver}
        onMouseDown={onListMouseDown}
        onClick={onListClick}
      >
        {models.length === 0 && (
          <div style={{ padding: '5px 8px', color: 'var(--dsw-alias-label-dimmed, rgba(127,127,127,0.8))' }}>
            (没有可用模型)
          </div>
        )}
        {models.map((entry, index) => (
          <div
            key={`${entry.provider}/${entry.id}`}
            id={`${listId}-${index}`}
            role="option"
            data-gw-model-index={index}
            aria-selected={`${entry.provider}/${entry.id}` === value}
            data-gw-model-active={index === active ? 'true' : 'false'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '5px 8px',
              borderRadius: '4px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              background: index === active ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.15))' : 'transparent',
            }}
          >
            {/* ✓ 只标当前选中项(与原生 select 的选中高亮等价)。 */}
            <span style={{ width: '10px', flex: '0 0 auto' }}>
              {`${entry.provider}/${entry.id}` === value ? '✓' : ''}
            </span>
            <span style={{ flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {modelOptionText(entry)}
            </span>
          </div>
        ))}
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      <button
        ref={setReference}
        type="button"
        className="gw-btn ghost gw-model-select"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        {...(activeId === undefined ? {} : { 'aria-activedescendant': activeId })}
        style={{ maxWidth: 132, minWidth: 0, flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={`生成用的模型:${value === '' ? '未选' : value}(点击选择;会被记住,与设置页的「默认模型」是同一个偏好)`}
        onClick={onButtonClick}
        onKeyDown={onButtonKeyDown}
      >
        {text}
      </button>
      {list}
    </>
  );
}
