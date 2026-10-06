/**
 * Diff Settings 弹层 —— 照 GitHub Desktop 的 `ui/diff/diff-options.tsx`。
 *
 * **只有两项控件**(审计核实,diff-options.tsx:138-180):
 *   1. `fieldset` 图例 `Whitespace` → 复选框「隐藏空白改动」;
 *      当 diff 可交互时下面还有一句提示「隐藏空白时行/块级交互会被禁用」;
 *   2. `fieldset role=radiogroup` 图例 `Diff display` → `Unified` / `Split`。
 *
 * 图片 diff 的类型选择**不在这里**(它是 `modified-image-diff.tsx:151-160` 里另一个
 * TabBar,持久化键也不同),所以这个弹层刻意只有两项。
 *
 * Desktop 用它的 `Popover`(依赖 floating-ui + focus-trap);这里用绝对定位的 div,
 * 换来零依赖 —— 审计确认 `ui/diff/` 里没有任何文件**直接**依赖那两个库。
 * @module dsh-git/client/diff-settings
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './icons.ts';

export function DiffSettings(props: {
  /** 是否用并排显示(Desktop 的 showSideBySideDiff)。 */
  sideBySide: boolean;
  onSideBySideChange: (value: boolean) => void;
  /** 是否隐藏空白改动(Desktop 的 hideWhitespaceIn*Diff)。 */
  hideWhitespace: boolean;
  onHideWhitespaceChange: (value: boolean) => void;
  /**
   * 这份 diff 是否可交互(能勾选行来暂存)。
   * 只有 Changes 页签传 true —— Desktop 的 `isInteractiveDiff`(`diff-header.tsx:58`)。
   * 为 true 时才会显示「隐藏空白会禁用行级交互」那句提示。
   */
  interactive?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent): void => {
      if (event.target instanceof Node && !wrap.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="gw-diffopt" ref={wrap}>
      <button className="gw-hbtn" aria-expanded={open}
        aria-label="Diff 设置" title="Diff 设置"
        onClick={() => setOpen((v) => !v)}>
        <Icon name="gear" size={12} />
        <Icon name="chevron-down" size={9} />
      </button>
      {open && (
        <div className="gw-diffopt-pop" role="dialog" aria-label="Diff 设置">
          <div className="gw-diffopt-head">
            <h3>Diff 设置</h3>
            <button className="gw-hbtn" aria-label="关闭" onClick={() => setOpen(false)}>
              <Icon name="x-circle" size={12} />
            </button>
          </div>

          <fieldset className="gw-diffopt-group">
            <legend>空白</legend>
            <label className="gw-chk">
              <input type="checkbox" checked={props.hideWhitespace}
                onChange={(event) => props.onHideWhitespaceChange(event.target.checked)} />
              隐藏空白改动
            </label>
            {props.interactive === true && (
              <p className="gw-diffopt-hint">
                隐藏空白时,行级与块级的交互会被禁用:此时的行号是按「忽略空白」重算的,
                与真实补丁不再对应,按行号暂存会改错行。
              </p>
            )}
          </fieldset>

          <fieldset className="gw-diffopt-group">
            <legend>Diff 显示</legend>
            <div role="radiogroup" aria-label="Diff 显示" className="gw-diffopt-radios">
              <label className="gw-chk">
                <input type="radio" name="gw-diff-mode" checked={!props.sideBySide}
                  onChange={() => props.onSideBySideChange(false)} />
                Unified
              </label>
              <label className="gw-chk">
                <input type="radio" name="gw-diff-mode" checked={props.sideBySide}
                  onChange={() => props.onSideBySideChange(true)} />
                Split
              </label>
            </div>
          </fieldset>
        </div>
      )}
    </div>
  );
}
