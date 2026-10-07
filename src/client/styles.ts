/**
 * 样式:一份 <style> 标签即包含
 *   1. 完整基底(整份复制自 dsh-github-workbench 的令牌化样式表),
 *   2. 本插件的补充与覆盖(新组件 + 有意改写的根节点契约)。
 * 之所以「基底 + 追加」而不是逐条合并:曾经按类名挑拣合并过,结果漏掉了远端
 * 视图正在使用的类(.gw-pop-item / .gw-stateic / .gw-spin)。重复属性无害 ——
 * 同名选择器后写者胜。
 * 颜色只来自宿主 --dsw-* 令牌,深浅主题与皮肤自动跟随。
 * @module dsh-git/client/styles
 */

const STYLE_ID = 'dsh-git-styles';

const CSS = `

.gw-root{position:relative;width:100%;height:100%;min-height:0;display:flex;flex-direction:column;min-width:280px;
  /* 等宽字体:下面 .gw-st/.gw-path/.gw-num/.gw-diff-head 一直在用 var(--gw-mono),
     但这个变量**从来没被定义**(未定义的 var() 会让整条声明失效),所以那些地方
     实际一直在用继承字体。这里补上定义,顺带让移植过来的 diff 样式表能共用它。 */
  --gw-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  /* 透明根:官方面板/better-sidebar 页签/独立面板各自提供底色,
     组件不再自刷背景(避免遮住宿主 0.1.5 新调色板)。 */
  background:transparent;color:var(--dsw-alias-label-primary);
  font-size:var(--gw-body-size, 12px);line-height:1.5;
  container-type:inline-size;
  /* 浮层容纳(2026-10 修「样式侵入宿主」):插件长在宿主的**侧栏**里,而从上游逐字
     移植来的浮层里有 position:fixed(浮动下拉的 #foldout-container 就是行内
     position:fixed;top:视口坐标;width:100%),在 Desktop 里那是「整个 App 的一条通栏」,
     在侧栏里就变成「盖住宿主窗口的一整块」(真 Chrome 实测:容器/遮罩量到 1320x623 = 整个视口,
     而插件根只有 420 宽)。contain:layout paint 做两件事,缺一不可:
       · layout —— 让它成为 fixed/absolute 后代的**包含块**(于是百分数与 top 指的是
         插件自己的盒子,而不是视口);
       · paint  —— 把后代**裁**在它的 padding box 里(于是某个盒子算错也画不到宿主身上)。
     ⚠️ 不要指望 container-type:inline-size(它已经在上面)—— 实测:container-type
     产生的 containment **不会**把 position:fixed 的后代改成相对它定位;只有
     contain:layout|paint / transform / filter / will-change:transform 才会。
     两者并存没问题:实测加了 contain 之后 @container 查询照旧命中。 */
  contain:layout paint}
.gw-root *,.gw-root *::before,.gw-root *::after{box-sizing:border-box}
.gw-icon{display:block;flex:none}

/* ---------- 头部 ---------- */
.gw-header{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);position:relative}
.gw-repo-btn{appearance:none;background:none;border:none;color:inherit;font:inherit;font-weight:600;
  display:flex;align-items:center;gap:5px;cursor:pointer;padding:3px 6px;border-radius:6px;min-width:0}
.gw-repo-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gw-repo-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.gw-chip{font-size:10px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-secondary);flex:none;display:inline-flex;align-items:center;gap:4px}
.gw-select{margin-left:auto;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 20px 2px 7px;
  font-size:11px;max-width:150px;appearance:none;-webkit-appearance:none;outline:none;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path fill='%23888f9c' d='M12.78 5.22a.749.749 0 00-1.06 0L8 9.44 4.28 5.72a.749.749 0 10-1.06 1.06l4.25 4.25c.146.147.338.22.53.22s.384-.072.53-.22l4.25-4.25a.749.749 0 000-1.06z'/></svg>");
  background-repeat:no-repeat;background-position:right 5px center;background-size:10px}
.gw-hbtn{width:26px;height:26px;border:none;background:none;color:var(--dsw-alias-label-secondary);
  border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:none;padding:0;position:relative}
.gw-hbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.gw-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.gw-dot.ok{background:var(--dsw-alias-state-success-primary)}
.gw-dot.bad{background:var(--dsw-alias-state-error-primary)}
.gw-hbtn .gw-inbox-badge{position:absolute;top:-2px;right:-2px;min-width:14px;height:14px;padding:0 3px;
  border-radius:999px;font-size:9px;line-height:14px;text-align:center;
  background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-layer-1);font-weight:600}
.gw-hbtn.has-unread{color:var(--dsw-alias-state-error-primary)}

/* ---------- 弹层(仓库切换 / 设置)----------
 *
 * ⚠️ **.gw-pop / .gw-pop.left / .gw-pop.right 现在全仓零写入方**(最后一个是
 * workbench.tsx 的「更多」菜单,2026-10 改用上游 Popover)。grep 可复核:
 * src/client/** 里带 gw-pop 的 JSX 只剩 .gw-pop-title / .gw-pop-item /
 * .gw-pop-cur / .gw-pop-divider / .gw-pop-hint 这五个**别的类名**(类选择器是
 * 整 token 匹配,它们不受这里影响),而这三个规则打不到任何元素。
 *
 * **为什么不在这里删掉它们**:styles-base.ts:47/50 有一份**逐字同值**的副本,而
 * styles-base.ts 不在本轮允许改动的清单里;注入顺序是 base → 本文件
 * (index.ts:21/:25 的 ensureBaseStyles() → ensureStyles()),所以只从本文件
 * 删掉**产物 CSS 一个字节都不会变**,只会让两份基底漂移。真正的退役是一次批量动作:
 * scripts/styles.mjs 的 PORT_SURFACES 那条 pop-width 表项 + VARIABLE_EXCEPTIONS
 * 的 --gw-pop-width + repo-bar.tsx:1117 那一行行内 style + styles-base.ts 这两条
 * (scripts.mjs 自己写着退役条件就是「全仓零 .gw-pop 写入方」—— 探针
 * docs/probes/menu-anchor-probe.mjs 现在断言这个条件**已经成立**)。
 */
.gw-pop{position:absolute;top:calc(100% + 4px);z-index:40;width:min(320px,calc(100vw - 24px));
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  box-shadow:0 10px 32px rgba(0,0,0,.35);padding:8px}
.gw-pop.left{left:10px}.gw-pop.right{right:10px}
.gw-pop-title{font-size:10px;color:var(--dsw-alias-label-tertiary);padding:2px 6px 6px}
.gw-pop-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;appearance:none;background:none;
  border:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:6px;border-radius:6px;
  cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gw-pop-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.gw-pop-item.cur{color:var(--dsw-alias-label-primary)}
.gw-pop-item.cur .gw-dot{background:var(--dsw-alias-state-success-primary)}
.gw-pop-cur{margin-left:auto;font-size:9px;color:var(--dsw-alias-brand-primary);
  border:1px solid var(--dsw-alias-brand-primary);padding:0 5px;border-radius:999px;flex:none}
.gw-x{display:none;margin-left:6px;flex:none;cursor:pointer;color:var(--dsw-alias-label-tertiary);
  border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:2px;line-height:0}
.gw-x:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.gw-pop-item:hover .gw-x{display:inline-flex}
.gw-pop-divider{height:1px;background:var(--dsw-alias-border-l1);margin:6px 2px}
.gw-input{width:100%;min-width:0;background:var(--dsw-alias-bg-base,#111);border:1px solid var(--dsw-alias-border-l1);
  border-radius:6px;color:var(--dsw-alias-label-primary);padding:5px 8px;font-size:11px;outline:none;font-family:inherit}
.gw-input:focus{border-color:var(--dsw-alias-brand-primary)}
.gw-pop-hint{font-size:10px;color:var(--dsw-alias-label-tertiary);padding:6px 4px 2px;line-height:1.55}
.gw-formrow{display:flex;gap:6px;padding:2px}
.gw-field{display:flex;flex-direction:column;gap:3px;padding:4px 2px}
.gw-field>label{font-size:10px;color:var(--dsw-alias-label-secondary)}

/* ---------- 子页签 ---------- */
.gw-tabs{display:flex;border-bottom:1px solid var(--dsw-alias-border-l2);padding:0 8px;overflow-x:auto}
.gw-tab{appearance:none;background:none;border:none;color:var(--dsw-alias-label-secondary);cursor:pointer;
  font-size:11px;font-family:inherit;padding:8px 10px;border-bottom:2px solid transparent;
  display:flex;gap:5px;align-items:center;white-space:nowrap}
.gw-tab:hover{color:var(--dsw-alias-label-primary)}
/* 选中页签的下划线 = 强调线,不是正文墨色。宿主自己的选中页签就是这条:
   ui-schedule 的 TaskManagerPage.module.css:620(文字)与 :625(::after 2px 下划线)
   都用 --dsw-alias-state-business-primary(浅 #4176e6 / 深 #7aaaFF)。
   原先绑 brand-primary(浅色近黑 #0f1115)⇒ 下划线是黑的。 */
.gw-tab.on{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary)}
.gw-count{background:var(--dsw-alias-interactive-bg-active);border-radius:999px;padding:0 6px;font-size:10px;line-height:16px}

/* ---------- 主体 / 页脚 ---------- */
.gw-body{flex:1;min-height:0;position:relative;display:flex}
.gw-inbox{position:absolute;inset:0;z-index:28;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;min-height:0}
.gw-inbox .gw-list{flex:1}
.gw-inbox-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;flex-wrap:wrap}
.gw-inbox-return{display:flex;align-items:center;gap:8px;padding:5px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);flex:none}
.gw-inbox-dot{width:8px;height:8px;border-radius:50%;flex:none;margin-top:5px;background:transparent;border:1px solid var(--dsw-alias-border-l1)}
.gw-inbox-dot.on{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.gw-row.gw-inbox-unread .gw-rowtitle{font-weight:600}
.gw-footer{display:flex;justify-content:space-between;gap:12px;padding:5px 12px;
  border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:10px}

/* ---------- 按钮 ---------- */
.gw-btn{appearance:none;display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;
  padding:3px 10px;font-size:11px;font-family:inherit;cursor:pointer;white-space:nowrap}
.gw-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* 主按钮的描边与文字:宿主 Button 的主色令牌是 --dsw-alias-button-primary-fill
   (浅 = #0f1115 / 深 = #f9fafb,与 brand-primary 同值)。换成宿主命名的那一条,
   宿主改主色时我们自动跟随,不必再来改这里。 */
.gw-btn.primary{background:transparent;border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-button-primary-fill)}
.gw-btn.primary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gw-btn.danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.gw-btn:disabled{opacity:.45;cursor:not-allowed}
/* 「看着能点、点了没反应」那一类按钮的**视觉真话**(2026-10 补)。
   上游 Desktop 的配方是 .button-component[aria-disabled=true]{opacity:.6}
   (references/desktop/app/styles/ui/_button.scss),而我们的移植面里
   **一条 [aria-disabled] 规则都没有** ⇒ changes-view.tsx 的「生成」与「提交」
   两个按钮(aria-disabled + onClick 里的守卫)在视觉上就是完全可点的普通按钮,
   用户点下去当然什么都不发生 —— 这正是用户实测报告里的一类。
   这里补上上游那一条(数值沿用上游的 .6)。
   为什么选 aria-disabled 而不是把按钮改成真 disabled(二选一,理由是实证的):
     · aria-disabled **不移出焦点/命中区**,键盘与读屏用户仍能到达按钮并听到
       title / aria-describedby 里的**原因**(「请先勾选一个或多个文件」…),
       这正是 Desktop 用 aria-disabled 的用意;换成 disabled 会把原因一起藏掉;
     · 上游按钮配方(_button.scss)本身就是 :not([aria-disabled=true]):hover +
       [aria-disabled=true]{opacity:.6} 这套 ⇒ 补样式 = 补回上游**本来就该在**的
       那条规则(移植时漏了),而动按钮 = 改我们自己的语义;前者更接近「逐字复刻」。
   ⚠️ 本文件是模板字符串,注释里**不能出现反引号**(会提前闭合模板,见 styles.mjs 头注释)。
   可回收条件:若这两个按钮将来改用真 disabled,删掉本条即可(.gw-btn:disabled 已有配方)。
   已知残留(**未修,如实记录**):.gw-btn:hover 仍会命中 aria-disabled 的按钮,
   所以悬停时底色仍会变 —— 压掉它需要改写成 :not([aria-disabled=true]),
   那是**第二条**规则的改动,本轮只授权追加这一条。 */
.gw-btn[aria-disabled=true]{opacity:.6;cursor:default}
.gw-btn.backbtn{margin-bottom:6px}
/* 链接:宿主自己的链接令牌就是 --dsw-alias-link(浅 #4176e6 / 深 #7aaaFF)。
   Desktop 的 --link-button-color 也是 lighten($blue,5%)。原先绑 brand-primary = 近黑,
   看起来像普通文字而不是链接。 */
.gw-link{color:var(--dsw-alias-link);text-decoration:none}
.gw-link:hover{text-decoration:underline}

/* ---------- 列表(Code 外三页签共用)---------- */
.gw-colpane{flex-direction:column}
.gw-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;flex-wrap:wrap}
.gw-open-count{color:var(--dsw-alias-label-tertiary);font-size:11px}
.gw-list{flex:1;min-height:0;overflow:auto}
.gw-more{display:flex;justify-content:center;padding:10px 12px 14px}
.gw-row{display:flex;gap:9px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);
  cursor:pointer;align-items:flex-start;width:100%;text-align:left;background:none;border-left:none;border-right:none;border-top:none;font-family:inherit;color:inherit;font-size:inherit}
.gw-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gw-stateic{flex:none;margin-top:1px}
.gw-rowmain{flex:1;min-width:0}
.gw-rowtitle{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gw-rowsub{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:6px}
.gw-meta{flex:none;text-align:right;color:var(--dsw-alias-label-tertiary);font-size:11px}
.gw-created{display:none;margin-left:10px}
.gw-label-chip{display:inline-block;font-size:10px;padding:0 7px;border-radius:999px;line-height:17px;margin-right:4px}
.gw-branch-chip{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);
  border-radius:5px;padding:0 5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}
.gw-diffstat-add{color:var(--dsw-alias-state-success-primary)}
.gw-diffstat-del{color:var(--dsw-alias-state-error-primary)}
.gw-checkdot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:baseline}
.gw-hoverbar{display:none;gap:6px;margin-top:6px;flex-wrap:wrap}
.gw-row:hover .gw-hoverbar{display:flex}

/* ---------- Code 双栏 ---------- */
.gw-codepane{flex:1;min-height:0;display:flex}
.gw-tree{width:190px;flex:none;border-right:1px solid var(--dsw-alias-border-l2);overflow:auto;padding:6px 4px}
.gw-tree-item{display:flex;align-items:center;gap:4px;padding:2px 6px;border-radius:5px;cursor:pointer;
  color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;font-size:12px;
  appearance:none;-webkit-appearance:none;background:none;border:none;font-family:inherit;
  text-align:left;width:100%;min-width:0}
.gw-tree-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* 选中的文件树行:文字取正文墨色;**底色**取宿主的「选中控件底色」别名
   --dsw-alias-button-ghost-active-fill(浅 #ebeef2 / 深 #43454a;
   消费方 ui-primitives 的 Pill.active)。原先文字绑 brand-primary +
   底色 interactive-bg-active:文字在浅色下偶然等价于 label-primary,但语义是品牌墨而非正文。 */
.gw-tree-item.sel{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-ghost-active-fill)}
.gw-tree-name{overflow:hidden;text-overflow:ellipsis}
.gw-filepane{flex:1;min-width:0;display:flex;flex-direction:column}
.gw-crumb{padding:7px 12px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l2);
  font-size:11px;display:flex;gap:8px;align-items:center;min-width:0}
.gw-crumb-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.gw-crumb-path b{color:var(--dsw-alias-label-primary);font-weight:600}
.gw-code{flex:1;min-height:0;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11px;line-height:1.55;padding:8px 0}
.gw-ln{display:flex;min-width:max-content}
.gw-ln:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gw-no{width:38px;flex:none;text-align:right;padding-right:10px;color:var(--dsw-alias-label-tertiary);user-select:none}

/* ---------- 详情抽屉 ---------- */
.gw-detail{position:absolute;inset:0;z-index:30;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column}
.gw-detail-head{padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.gw-detail-body{flex:1;min-height:0;overflow:auto;padding:12px 14px;color:var(--dsw-alias-label-secondary);
  line-height:1.65;white-space:pre-wrap;word-break:break-word}
.gw-comment{border-top:1px dashed var(--dsw-alias-border-l2);padding-top:10px;margin-top:10px}
.gw-comment-head{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;margin-bottom:6px}
.gw-composer{border-top:1px solid var(--dsw-alias-border-l2);padding:8px 14px;display:flex;flex-direction:column;gap:6px;flex:none}
.gw-textarea{resize:vertical;min-height:52px;max-height:200px;font-family:inherit}
.gw-composer-row{display:flex;gap:8px;align-items:center}

/* ---------- 反馈:确认气泡 / toast / 空 / 错误 / 加载 ---------- */
.gw-scrim{position:absolute;inset:0;z-index:60;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:20px}
.gw-dialog{width:min(360px,100%);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);
  border-radius:12px;padding:14px;box-shadow:0 16px 44px rgba(0,0,0,.45)}
.gw-dialog h4{margin:0 0 8px;font-size:13px;color:var(--dsw-alias-label-primary)}
.gw-dialog p{margin:0 0 12px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;white-space:pre-wrap}
/*
 * 推送失败弹窗里的 **git 原始输出**(bits.tsx 的 PushFailureDialog 的 generic 档)。
 * 上游对应的是 Terminal(rows=15 cols=80)那个固定宽等宽块
 * (ui/app-error.tsx:80-83 的 isRawGitError 分支)—— 我们这里最小的等价物就是
 * 一个限高可滚的 pre:不加它,长 stderr 会横向撑破 360px 的弹窗。
 * 刻意**不引任何 --dsw-alias-* 令牌**:底色用中性半透明,明暗主题都能用,
 * 也就不会因为某个宿主令牌不存在而在构建期被 checkInlineTokens 拦下。
 *
 * user-select:text(2026-10 加):用户要求这段原文**可选中、可复制**(能粘到搜索或
 * issue 里)。上游这一族**没有**复制按钮(在 ui/app-error.tsx /
 * dialog/default-dialog-footer.tsx / lib/terminal.tsx 里 grep copy 命中 0),
 * 所以按用户的话「没有就至少保证文本可选中」。
 * 显式写出来而不是靠继承:这条规则既是保证,也是探针
 * docs/probes/push-failure-detail-probe.mjs 能**从级联里读出来**的那一条判据
 * (jsdom 真的会算 class 选择器的 computed style)。
 */
.gw-dialog pre{margin:0 0 12px;max-height:180px;overflow:auto;padding:8px;border-radius:6px;
  background:rgba(127,127,127,.14);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;
  user-select:text}
/*
 * 「错误码:xxx」那一行(bits.tsx 的 PushFailureDialog;**每一档**都渲染)。
 *
 * 为什么选择器写成 .gw-dialog p.gw-dialog-code:上面那条 .gw-dialog p(0,1,1)比
 * .gw-dialog-code(0,1,0)**更具体**,后者会被它压掉。同样刻意不引 --dsw-alias-* 令牌
 * (理由同上);只压低透明度 —— 它是证据行,不该抢正文的注意力。
 *
 * ⚠️ 这一段注释里**不许出现反引号**:本文件整份 CSS 是一个模板字符串,
 * 多一个反引号就会把字符串截断(闸门 scripts/check-template-literals.mjs 管这条)。
 */
.gw-dialog p.gw-dialog-code{margin:0 0 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11px;line-height:1.5;opacity:.8}
.gw-dialog-actions{display:flex;gap:8px;justify-content:flex-end}
/*
 * ---------- 反馈:确认气泡 / toast / 空 / 错误 / 加载 ----------
 *
 * ⚠️ **.gw-toasts / .gw-toast* 现在全仓零渲染方(2026-10)** —— 通知改由宿主原语
 * 「@deepseek-ai/dsh-client-ui-primitives」的 Toast 渲染(见 src/client/bits.tsx 的
 * Toasts;理由与 file:line 在那个组件的 JSDoc 里)。所以下面四条打不到任何元素。
 *
 * **为什么留在这里而不是删掉**:styles-base.ts:174-178 有一份**逐字同值**的副本,
 * 而顺序是 base → 本文件(index.ts:21/:25 的 ensureBaseStyles() → ensureStyles())⇒
 * 只从这里删掉**产物 CSS 一个字节都不会变**,只会让两份基底漂移。这是既有先例
 * (见上面 .gw-pop 那段,同样是「另一个注入源里还有一份」)。
 *
 * **为什么值得记一笔**:这四条里的 left:12px / right:12px / bottom:34px 正是用户报的
 * 「生成 commit message 后的通知宽度铺满、挡到提交按钮」的**根因** —— 它把通知钉在插件根
 * 底部通栏,而提交按钮就在那个位置。新探针
 * docs/probes/toast-commit-button-probe.mjs 的阴性对照就是在本页里把旧 markup 插回
 * .gw-root(旧规则仍在,故量到的是**改前的真实几何**),实测交集 > 0。
 *
 * **退役条件**:styles-base.ts 那两条被删除时,这四条同批删掉 ——
 * 那时 .gw-toast 才真的全仓零残留。在那之前**不要**只删一边。
 */
.gw-toasts{position:absolute;left:12px;right:12px;bottom:34px;z-index:70;display:flex;flex-direction:column;gap:6px;pointer-events:none}
.gw-toast{padding:7px 12px;border-radius:8px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.gw-toast.err{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.gw-toast.ok{border-color:var(--dsw-alias-state-success-primary)}
/*
 * ---------- 通知:右下角 + 按右栏夹宽(2026-10 用户裁决)----------
 *
 * 通知本体仍由宿主原语渲染(见 src/client/bits.tsx 的 Toasts),但原语把自己的位置写在
 * CSS module 里(position:fixed; top:40px; left:50%; transform:translateX(-50%)),它的
 * anchor 只改**水平中心**,而且它把横幅 portal 到 document.body —— 所以「右下角」与
 * 「夹宽」这两件事只能在这里覆盖。两个门控条件缺一不可:
 *
 *   1. html[data-gw-toast-clamp] —— bits.tsx 的 useToastBandClamp 在**量到通知带**时
 *      才打上(右栏 .gw-split > .right 的实测矩形 → --gw-toast-* 四个变量)。属性不在
 *      ⇒ 整条规则不生效 ⇒ 原语退回它自己的顶部居中(即改前的行为,不会更坏)。
 *   2. :has(> span > .gw-toast-mark) —— 只命中**我们自己的**横幅:标记类在 bits.tsx 的
 *      ToastIcon 里。宿主与别的插件走同一个原语但没有这个标记 ⇒ 命中不了这条规则
 *      (新探针 docs/probes/toast-overlay-probe.mjs 有一条阴性对照专门量这件事)。
 *
 * 改的只有四类:纵向(top→bottom)、横向(left→right)、夹宽/夹高、宿主那条「居中」
 * transform。配色、圆角、阴影、z-index、pointer-events、淡出动画**全部留给原语** ——
 * 这不是重做外观。两个变量名与 bits.tsx 的写入方是**跨文件契约**(探针会同时读两个
 * 源文件、断言名字一致;改一边忘另一边会让横幅静默回到顶部居中)。
 */
html[data-gw-toast-clamp] body > div[role="alert"]:has(> span > .gw-toast-mark){
  top:auto;bottom:var(--gw-toast-bottom, 12px);left:auto;right:var(--gw-toast-right, 12px);
  /* border-box:让 max-width 把原语自己的 padding(16+16)算进去,否则外框会比夹宽宽 32px */
  box-sizing:border-box;
  /* 夹宽 = 右栏宽 − 两侧 12(bits.tsx 里已经减过);再与原语自己的上限取小 */
  max-width:min(var(--gw-toast-max-w, 640px), 640px, calc(100vw - 48px));
  /* 夹高只在窄档(<420px,split 变成上下堆叠)才起作用,见 bits.tsx 的 toastBand 注释 */
  max-height:var(--gw-toast-max-h, none);overflow-y:auto;
  /* ⚠️ 必须 !important:入场/淡出关键帧里是 translate(-50%, …),而 CSS 动画**压过**普通
     声明。不加它,横幅在入场那 160ms 会向左偏半个自身宽度。代价是入场那 6px 的纵向滑入
     也一起没了(只剩不透明度)——与 prefers-reduced-motion 那一档的观感一致。淡出**没有**
     受影响:它只动 opacity / visibility。 */
  transform:none !important;
}
/* 成功档的图标色 = 原语 tone="success" 那一档自己的令牌(见 Toast.module.css 的
   .icon.success)。标记类只是「这条是我们发的」,不是新配色。 */
.gw-toast-ok{color:var(--dsw-alias-state-success-primary)}
.gw-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);
  padding:28px;text-align:center;line-height:1.8}
.gw-errbox{margin:12px;padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary);
  border-radius:8px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.6;white-space:pre-wrap}
.gw-spin{animation:gw-spin 1s linear infinite}
@keyframes gw-spin{to{transform:rotate(360deg)}}
.gw-muted{color:var(--dsw-alias-label-tertiary)}

/* ---------- 窄屏紧凑档(<600px):树变覆盖抽屉、头部换行 ---------- */
.gw-codepane{position:relative}
/* 抽屉开关(CodeView 层悬浮,宽屏隐藏);treeOpen 时变为关闭钮 */
.gw-tree-fab{display:none;position:absolute;top:8px;left:8px;z-index:26}
@container (max-width:599px){
  .gw-header{flex-wrap:wrap;row-gap:6px;padding-right:10px}
  .gw-select{margin-left:0;max-width:104px}
  .gw-tabs{padding:0 4px}
  .gw-tab{padding:8px 9px}
  .gw-codepane.tree-open .gw-tree-fab{left:auto;right:8px} /* 抽屉开着 ⇒ 变成右上角关闭位 */
  .gw-tree-fab{display:inline-flex}
  .gw-codepane:not(.tree-open) .gw-tree{display:none;width:auto;position:absolute;inset:0;z-index:25;
    background:var(--dsw-alias-bg-layer-1);border-right:none}
  .gw-rowtitle{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.35}
  .gw-rowsub{white-space:normal;flex-wrap:wrap}
  .gw-composer-row{flex-wrap:wrap}
  .gw-crumb{flex-wrap:wrap}
}

/* ---------- 容器查询三档(<720 默认紧凑 / ≥720 / ≥1000)---------- */
@container (min-width:720px){
  .gw-tree{width:240px}
  .gw-header,.gw-toolbar{padding-left:16px;padding-right:16px}
  .gw-tab{padding:9px 14px;font-size:12px}
  .gw-row{padding:11px 16px}
}
@container (min-width:1000px){
  .gw-tree{width:290px}
  .gw-header{padding:12px 18px}
  .gw-rowsub{font-size:12px}
  .gw-code{font-size:12px;line-height:1.6}
  .gw-created{display:inline}
  .gw-pane-wrap>.gw-detail{inset:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;
    box-shadow:0 14px 40px rgba(0,0,0,.4)}
}

/* ===== 以下为 dsh-git 自己的补充与覆盖(重复属性是无害的:同名选择器以后者为准) ===== */
/* ---------- 顶栏:仓库下拉 / 同步 / 分支 / 设置 ---------- */
.gw-header{display:flex;align-items:center;gap:6px;padding:8px;flex:none;
  /* position:relative 与上面那条 .gw-header 重复,但**这条必须自己写**。
     仓库下拉的 .gw-pop 是 position:absolute,它的包含块就是最近的定位祖先 ——
     也就是 .gw-header。上面那条基底规则里也有 position:relative,靠 CSS 的
     **逐属性合并**存活;一旦有人删掉上面那条(或把它改成 position:static),
     包含块就会退到 .gw-root,下拉会整体错位。docs/goal-port-desktop.md §8 记过同型事故
     (依赖逐属性合并的写法是脆的)。这里显式写一遍,把「不能丢」这件事钉在
     语义上,顺便给 checkDuplicateSelectors 的 dup-ok 一个真理由。 */
  position:relative; /* dup-ok:与基底 .gw-header 有意重复,理由见上 */
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.gw-sync{display:flex;align-items:center;gap:5px;height:30px;padding:0 9px;font:inherit;font-size:12px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);border-radius:8px;cursor:pointer;flex:none}
.gw-sync:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gw-sync[data-state="clean"]{color:var(--dsw-alias-label-tertiary)}
.gw-branch{display:flex;align-items:center;gap:4px;height:30px;max-width:140px;padding:0 7px;font:inherit;
  font-size:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);border-radius:8px;cursor:pointer;flex:none}
.gw-branch span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gw-hbtn:disabled{opacity:.45;cursor:default}
/* ---------- 页签栏 ---------- */
.gw-tabs{display:flex;gap:2px;padding:0 6px;flex:none;overflow-x:auto;scrollbar-width:none;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.gw-tabs::-webkit-scrollbar{display:none}
/* 选中页签上的计数角标:底色是强调色,文字走宿主「强调底上的前景色」令牌
   (--dsw-alias-label-primary-foreground:浅 #ffffff / 深 #0f1115)。
   原先背景绑 brand-primary(浅色近黑)且文字**写死 #fff** —— 那是唯一的字面色。 */
.gw-tab.on .gw-count{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}
/* ---------- 视图区通用 ---------- */
.gw-body{flex:1;min-height:0;position:relative;display:flex;flex-direction:column}
.gw-pane{flex:1;min-height:0;display:flex;flex-direction:column}
.gw-toolbar .grow{flex:1}
.gw-btn{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;font:inherit;font-size:11px;
  cursor:pointer;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);border-radius:6px}
.gw-btn.ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.gw-btn.ghost:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* 左右两栏,照 GitHub Desktop 的仓库视图:
     左栏 = 变更列表(可滚) + **底部提交表单**
     右栏 = diff;没有变更时是 NoChanges 空态。
   注意:这里曾有一对被后来的规则覆盖掉的声明,把布局变成了「上下堆叠」
   (列表在上一半、diff 在下一半)。CSS 是逐属性覆盖的,**后写的赢**,
   所以千万不要再在下面重复声明 .gw-split。 */
.gw-split{flex:1;min-height:0;display:grid;grid-template-columns:minmax(190px,44%) 1fr}
.gw-split>.left{min-width:0;min-height:0;display:flex;flex-direction:column;
  border-right:1px solid var(--dsw-alias-border-l1)}
.gw-split>.right{min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
/* ---------- 文件列表 ---------- */
.gw-files{flex:1;min-height:0;overflow:auto;padding:2px 0 6px}
.gw-grp{display:flex;align-items:center;gap:5px;padding:6px 8px 3px;font-size:11px;
  color:var(--dsw-alias-label-tertiary);letter-spacing:.02em;cursor:pointer;user-select:none}
.gw-frow{display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;font-size:12px;
  border-left:2px solid transparent}
.gw-frow:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* 选中/当前行的**左侧强调条**:它是强调线(不是底色、不是正文),
   用宿主选中态用的蓝色强调令牌;原先 brand-primary 在浅色下是近黑条。
   底色仍由 --dsw-alias-interactive-bg-active 提供(中性交互层,见下方 .gw-frow 注释)。 */
.gw-frow.on{background:var(--dsw-alias-interactive-bg-active);border-left-color:var(--dsw-alias-state-business-primary)}
/* '.gw-cb' 的 4 条规则已于 2026-10 删除:全仓已无 'gw-cb' 消费方(changes-view 改用上游
   <Checkbox>),它们是死规则。Changes 行勾选列的配方改由上游槽位类 '.checkbox-component'
   提供,见本文件下方的 '.gw-frow.file .checkbox-component'。 */
.gw-st{width:12px;text-align:center;font-weight:700;font-size:11px;flex:none;font-family:var(--gw-mono)}
.gw-st.M{color:var(--dsw-alias-state-warn-primary)}
.gw-st.A{color:var(--dsw-alias-state-success-primary)}
.gw-st.D{color:var(--dsw-alias-state-error-primary)}
.gw-st.R,.gw-st.C{color:var(--dsw-alias-label-secondary)}
.gw-st.U,.gw-st\?{color:var(--dsw-alias-label-tertiary)}
.gw-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;
  text-align:left;font-family:var(--gw-mono);font-size:11px}
.gw-num{flex:none;font-size:10px;font-family:var(--gw-mono);color:var(--dsw-alias-label-tertiary)}
.gw-num .a{color:var(--dsw-alias-state-success-primary)}
.gw-num .d{color:var(--dsw-alias-state-error-primary)}
/* ---------- diff ---------- */
.gw-diff-head{display:flex;align-items:center;gap:6px;padding:6px 8px;flex:none;font-size:11px;
  font-family:var(--gw-mono);color:var(--dsw-alias-label-secondary);
  border-bottom:1px solid var(--dsw-alias-border-l1)}
/* 旧手写渲染器的 .gw-diff / .gw-dl / .gw-dl.add|del|hunk 已随 diff-view.tsx 删除:
   行样式现在来自 src/client/scss/desktop-diff.scss(编译产物注入,作用域 .gw-desktop-diff)。 */
/* ---------- 提交区 ---------- */
.gw-commit{flex:none;display:flex;flex-direction:column;gap:6px;padding:7px 8px 8px;
  border-top:1px solid var(--dsw-alias-border-l1)}
.gw-commit .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.gw-input,.gw-area{width:100%;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;
  padding:5px 7px}
.gw-area{resize:vertical;min-height:44px;font-family:inherit}
.gw-input:focus,.gw-area:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.gw-input::placeholder,.gw-area::placeholder{color:var(--dsw-alias-label-tertiary)}
.gw-sel{display:inline-flex;align-items:center;gap:4px;padding:3px 7px;font:inherit;font-size:11px;
  cursor:pointer;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);border-radius:6px;max-width:100%}
.gw-sel span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gw-chk{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary);
  cursor:pointer}
/* 复选框强调色:宿主自己在确认对话框里就是这么写的
   (ui-primitives ConfirmationDialog.module.css 的 acknowledgement input
   accent-color: var(--dsw-alias-button-primary-fill))。换成宿主命名的那一条。 */
.gw-chk input{accent-color:var(--dsw-alias-button-primary-fill);margin:0}
.gw-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:5px;line-height:1.6}
/* ---------- 历史 ---------- */
.gw-commits{flex:1;min-height:0;overflow:auto}
.gw-crow{display:flex;gap:8px;padding:7px 9px;cursor:pointer;border-left:2px solid transparent}
.gw-crow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gw-crow.on{background:var(--dsw-alias-interactive-bg-active);border-left-color:var(--dsw-alias-state-business-primary)}
.gw-crow .sha{flex:none;font-family:var(--gw-mono);font-size:11px;color:var(--dsw-alias-label-tertiary);padding-top:1px}
.gw-crow .meta{flex:1;min-width:0}
.gw-crow .subj{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gw-crow .sub2{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.gw-detail{padding:9px;overflow:auto;min-height:0}
.gw-detail h3{margin:0 0 6px;font-size:13px;line-height:1.45}
.gw-kv{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.gw-kv .pill{border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:0 5px;
  font-family:var(--gw-mono);cursor:pointer}
.gw-stat{border-top:1px solid var(--dsw-alias-border-l1);padding-top:7px;margin-top:4px}
.gw-srow{display:flex;gap:6px;align-items:center;padding:3px 0;font-size:11px;font-family:var(--gw-mono);
  cursor:pointer}
.gw-srow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gw-srow .p{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gw-mono{font-family:var(--gw-mono)}
/* ---------- Code(远端树) ---------- */
.gw-tree{min-height:0;overflow:auto;padding:3px 0 8px;font-family:var(--gw-mono);font-size:11px}
.gw-trow{display:flex;align-items:center;gap:5px;padding:3px 8px;cursor:pointer}
.gw-trow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gw-trow.on{background:var(--dsw-alias-interactive-bg-active)}
/* ---------- 页脚 ---------- */
.gw-footer{display:flex;justify-content:space-between;gap:8px;padding:5px 9px;flex:none;font-size:10px;
  color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l1);white-space:nowrap;
  overflow:hidden}
/* ---------- 弹层 ---------- */
/* 这里只覆盖 z-index。CSS 级联是**逐属性**合并的,所以基底 .gw-scrim 的
   display:flex / align-items / justify-content / 遮罩底色依然生效 —— 曾误以为
   「只写三个属性会丢掉居中」而去补写 display:block,那才会真的把居中破坏掉。 */
.gw-scrim{position:absolute;inset:0;z-index:50} /* dup-ok:只覆盖 z-index,其余属性靠逐属性级联保留 */
/* ---------- 「更多」(kebab)菜单 —— 现在长在**上游 Popover** 上 ----------
 *
 * 用户原话「.gw-pop 相关的不太对吧,你看下 references/dekstop 是怎么实现的」。
 * 改前这里是自算锚点的手写浮层(一层 .gw-scrim + .gw-pop gw-pop-more + 一整套
 * top/right/maxWidth 的行内数学,来自已删除的 src/client/menu-anchor.ts);
 * 改后 src/client/workbench.tsx 的 MenuPopover 渲染的是**与上游一致的**
 * core/desktop/ui/lib/popover.tsx,定位交给 floating-ui
 * (computePosition + offset/shift/flip/size)。
 *
 * ## 这一条为什么还留在这里,而不是搬进某个移植面
 *
 * Popover **不做 portal**(它就是就地渲染一个 div),所以菜单 DOM 落在
 * workbench.tsx 用 ReactDOM.createPortal 指定的 .toolbar-button 里 —— 那在
 * .gw-app-toolbar 那一面的**作用域内**,理论上可以蹭上游 .popover-component
 * 的皮(ui/_popover.scss)。**刻意不蹭**,两条理由:
 *   1. 本轮任务边界是「只改菜单**怎么渲染 / 怎么定位**」,**不改它长什么样**:
 *      .popover-component 是给**表单气泡**的皮(20px 内边距 + 8px 尖角),
 *      套在 9 项菜单上视觉会明显变样;
 *   2. 蹭它就把「菜单有没有样式」和「portal 落点是否仍在顶栏子树里」绑成一条
 *      **静默**耦合 —— 落点一变,菜单会**全裸**,而那正好是
 *      docs/probes/README-generated-css.md 第 10 种「什么都没有看起来像一切正常」。
 *      自带一份皮没有这个耦合。
 *
 * ## 三个声明各自守什么(每一条都被探针断言)
 *
 *   · max-width:min(360px,100%) —— 「宽度由内容决定」的**上下限兜底**
 *     (max-content 会把盒子撑到最长那一行,.gw-pitem .grow 是 nowrap+ellipsis,
 *     所以不会折行缩窄)。360 取宿主自有菜单的口径(上游 Menu.module.css 的
 *     .list{max-width:360px});100% 是**包含块**宽度 —— .gw-root 上有
 *     contain:layout paint,所以它就是 .gw-root,这条因而等价于「绝不比插件根更宽」,
 *     而浮层的左右边被 bottom-end 钉在 kebab 上 ⇒ 它也**绝不会被 contain:paint
 *     在左边裁掉**。这是改前那段手算 maxWidth 想做的事,一行 CSS 表达完了。
 *   · z-index **不在这里**:Popover 自己写死行内 zIndex:17,样式表压不过行内,
 *     所以层级由 workbench.tsx 的 MORE_MENU_Z_INDEX 行内给。
 *   · .gw-more-menu-items 的 max-width —— **消费上游 size() 中间件**给出的
 *     --available-width(它把两个变量写在 .popover-content 的行内;自定义属性会继承,
 *     所以子元素读得到)。
 *
 * ## ⚠️ 高度上限**不能**消费 --available-height:镜像那条变量是坏的(实测 + 逐字读源)
 *
 * popover.tsx:166-176 是
 *
 *     const newMaxHeight = maxHeight === undefined ? availableHeight + "px" : ...   // 已经带 px
 *     contentDiv.style.setProperty("--available-height", newMaxHeight + "px")       // 又拼一次
 *
 * ⇒ 实测值就是 **220.5pxpx**。自定义属性「语法合法」(它什么都收),于是 substitution
 * 照常发生,只是替换出来的 max-height:220.5pxpx 是 invalid-at-computed-value-time
 * ⇒ **整条声明被丢掉**、回落 max-height:none。也就是说**上游 _popover.scss:15 的
 * max-height:var(--available-height) 从来没生效过**(矮视口实测:菜单 337px 高、
 * 视口 277px,底部溢出 **106.5px**)。
 *
 * ⚠️ **2026-10 已修镜像**(与本段原先「不改镜像」的说法相反,故更正):
 * src/core/desktop/ui/lib/popover.tsx 去掉那一次重复拼接,并作为**全仓唯一一处
 * ui/lib/** 的 EXPECTED 偏离**登记在 scripts/verify-mirror.mjs(理由与回收条件都在那里)。
 * 修后真 Chrome 实测:.popover-content 的 computed max-height **逐字等于**
 * --available-height(不再是 none),由 docs/probes/menu-anchor-probe.mjs
 * 的「上游规则已生效」一条断言盯着。
 *
 * 即便镜像修好了,下面这两条**仍然保留** —— 因为它们守的是上游那条规则**守不住的**
 * 边界(而且它们比上游那条更对症):
 *
 *     max-height: min(calc(100% - 60px), calc(100vh - 66px))
 *                         │                    │
 *                         │                    └ 视口相对:宿主窗口比侧栏还矮时的安全网
 *                         └ 包含块相对 —— 本浮层是 position:fixed 且 .gw-root 上有
 *                           contain:layout,所以 100% 就是**插件根**(= 宿主侧栏)的高度。
 *                           60 = 顶栏 50px(已被探针断言为契约)+ 10px 余量 ⇒ 菜单底边
 *                           永远不会越过侧栏底边。⚠️ 这一条恰好补上 floating-ui **看不见**
 *                           的那个边界:contain:paint 的裁剪在 computed overflow 上是
 *                           visible,所以 getClippingElementAncestors 不认它(上游的
 *                           shift/flip 只看到探针里那个 #root{overflow:hidden})。
 *
 * 卡片因此是 flex 列,滚动落在 .gw-more-menu-items 上(.popover-content 的行内
 * overflow:hidden 于是没有东西可裁)。
 */
.gw-more-menu{width:max-content;min-width:160px;max-width:min(360px,100%);
  max-height:min(calc(100% - 60px),calc(100vh - 66px));display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;
  box-shadow:0 12px 32px rgba(0,0,0,.32);padding:7px;color:var(--dsw-alias-label-primary);font-size:12px}
.gw-more-menu>.popover-content{display:flex;flex-direction:column;min-height:0}
.gw-more-menu .gw-more-menu-items{min-height:0;max-width:var(--available-width);
  overflow-y:auto;overflow-x:hidden}
.gw-pitem{display:flex;align-items:center;gap:6px;width:100%;padding:5px 6px;font:inherit;font-size:12px;
  text-align:left;background:none;border:none;border-radius:7px;color:var(--dsw-alias-label-primary);
  cursor:pointer}
.gw-pitem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gw-pitem.cur{background:var(--dsw-alias-interactive-bg-active)}
.gw-pitem .sub{font-size:10px;color:var(--dsw-alias-label-tertiary);font-family:var(--gw-mono);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gw-pitem .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gw-pitem .tail{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.gw-field label{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.gw-badge{font-size:10px;padding:0 5px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-secondary)}
.gw-device{display:flex;align-items:center;gap:8px;padding:6px;border:1px dashed var(--dsw-alias-border-l2);
  border-radius:8px;margin:4px 0;flex-wrap:wrap}
.gw-device .code{font-family:var(--gw-mono);font-size:15px;letter-spacing:.14em;font-weight:600}
/* ---------- 确认气泡 / toast ---------- */
.gw-dialog-scrim{position:absolute;inset:0;z-index:60;display:grid;place-items:center;
  background:rgba(0,0,0,.35);padding:16px}
/* ---------- Preferences 模态:插件自有卡片的布局层 ----------
   Preferences 弹窗的卡片是 .gw-dialog + .gw-prefs-card,内容那一层是 #preferences.gw-prefs-body。
   这两条规则负责**整张卡片的尺寸契约**,2026-10 由探针(真 Chrome)重新定过:

   1) .gw-prefs-card 是**竖向 flex 容器**。卡片必须能「把高度上限传给内容」,否则内容超高时
      #preferences 只会越出卡片、靠卡片自己的 overflow 滚整张卡(实测病态档:卡片 388px 高、
      #preferences 607px,页脚被顶到卡片外)。.gw-clone(.styles.ts 下面那一段)早就是这个形状。
   2) .gw-prefs-body 的 min-height 原为 calc(100vh - 150px)(逐字取自上游 _dialog.scss:413-418,
      那条注释在 scss/preferences.scss 第 9 段)。**上游那句话的前提在这里不成立**:Desktop 的
      Settings 是**接近满窗口**的窗口,而本弹窗长在 DSH 右侧栏里 —— 视口是整块浏览器窗口
      (>=900px),插件根只有 280~720px 宽、高度是侧栏的。实测(插件根 500x760):
      卡片被这条算成 **609px**,而侧栏给得出 728px —— 既比内容高(短内容的页留白 210~334px),
      又不跟随包含块。⇒ 改成**内容驱动**(min-height:0 + flex:1):
        · 卡片自然高度的**下限由页签栏自己给**(6 项实测 344px + 页脚 66px),
          不再需要一个手算的魔数(旧版那次 height:320px 的塌陷也是被它取代的);
        · 内容真的超高时由 flex + min-height:0 把可用高度压给 .tab-container 的 overflow-y:auto,
          页脚仍然钉在卡片底部(上游 _dialog.scss 的 dialog-footer 也是 flex:none)。
   3) 上一版为「矮窗口里卡片自己滚」在 preferences-dialog.tsx 留了一条行内 overflowY:auto。
      它写明的两个回收条件(布局搬进 styles.ts、min-height 改成与包含块无关的形式)现在都成立
      ⇒ 已经删除,布局只有这一处真源。
   4) ⚠️ **overflow:auto 不是顺手加的,它是 max-height 生效的前提**(实测,别删):
      卡片是 .gw-dialog-scrim(display:grid + place-items:center)的**网格项**。网格项在
      overflow 为 visible 时,它的**自动最小尺寸**等于内容尺寸 ⇒ 那条 auto 行被内容撑高,
      max-height:100% 于是按**被撑大的网格区域**解析 = 内容高 ⇒ **根本不封顶**。
      真 Chrome 对照实验(宿主盒 500x420、内容 500px):
        · 卡片无 overflow(只有 max-height:100%)→ 卡片 560px,**溢出宿主盒**
        · 卡片 overflow:auto 或 hidden           → 卡片 388px(= 宿主 420 − 遮罩 32),不溢出
      上一版之所以「矮窗口里卡片滚得动」,靠的正是调用点那条行内 overflowY:auto
      —— 也就是说这个机制**原本就在**,只是落在权宜的位置。现在写进这里,取 auto 而不是 hidden:
      内容真的超高时**能滚**比**被静默裁掉**好(§3 那个失败模式家族)。
      行内样式删掉后短宿主档一度退化(卡片 553px 溢出 420px 的宿主盒),就是这条缺失的症状。 */
.gw-prefs-card{display:flex;flex-direction:column;width:min(600px,100%);max-height:100%;overflow:auto;padding:0;gap:0}
.gw-prefs-body{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
.gw-prefs-body .preferences-container{flex:1 1 auto;min-width:0;min-height:0}
/* 页签列不参与拉伸,分给右侧内容区(上游 _preferences.scss:18 只给了 .tab-container flex:1) */
.gw-prefs-body .tab-bar{flex:none;align-self:stretch}
/* .tab-container 要能在矮窗口里滚。选择器比上游的 '.preferences-container .tab-container'
   (0-2-0)高一级,所以这里的 flex/overflow 一定赢 —— 本插件的全局样式先注入,
   「同特异性靠后注入」那条规则救不了它,只能靠特异性。 */
.gw-prefs-body .preferences-container>.tab-container{flex:1 1 auto;min-width:0;min-height:0;overflow-y:auto}
.gw-prefs-body .gw-prefs-form{display:contents}
.gw-prefs-body .dialog-footer{flex:none;display:flex;flex-direction:column;border-top:var(--base-border);padding:var(--spacing-double);gap:0}
.gw-prefs-body .dialog-footer .button-group{display:flex;flex-direction:row;justify-content:flex-end}
.gw-prefs-body .dialog-footer button{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:var(--spacing-half);min-width:120px}
.gw-prefs-body .dialog-footer button:last-child{margin-right:0}
/* 同上一段:.gw-toast 已零渲染方(通知走宿主 Toast 原语),这条动作文字样式同样只在
   styles-base.ts 里还有一份的时候才有意义 —— 退役与那一段同批。 */
.gw-toast .act{margin-left:6px;color:var(--dsw-alias-link);cursor:pointer;background:none;
  border:none;font:inherit;padding:0}
/* 远端视图(issues/pulls/comments)用到但基底未定义的类 */
.gw-spin{display:inline-flex;animation:gw-spin 1s linear infinite} /* dup-ok:基底没有 display,这里是超集 */
@keyframes gw-spin{to{transform:rotate(360deg)}}

/* ===== diff 相关样式 =====
   diff **正文**已改由移植过来的 Desktop Diff 组件渲染,它的样式表是
   src/client/scss/desktop-diff.scss(用 Dart Sass 编译出来,见 desktop-diff-styles.ts)。
   下面这一段是**保留仍在用的**部分:头部 .gw-diff-head、统计 .gw-diff-stat、
   Diff Settings 弹层 .gw-diffopt*,以及历史页签的 .gw-diff-head。
   已删除的是旧手写渲染器的行样式(.gw-diff/.gw-dl/.gw-df 等,随 diff-view.tsx 一起下线)。 */
.gw-diff-stat{display:flex;align-items:center;gap:8px;padding:3px 8px;flex:none;
  font-family:var(--gw-mono,ui-monospace,Menlo,monospace);font-size:10px;
  color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.gw-diff-stat .a{color:var(--dsw-alias-state-success-primary)}
.gw-diff-stat .d{color:var(--dsw-alias-state-error-primary)}

/* ============================================================================
   Clone / 仓库下拉 / 设置 三个界面 —— 结构照 GitHub Desktop,尺寸取它的
   _variables.scss(--spacing 10px / 正文 12px / 次要 11px / 行高 29px)。
   ============================================================================ */

/* ---------- Clone a repository ---------- */
.gw-clone{width:min(520px,100%);max-height:calc(100% - 32px);display:flex;flex-direction:column}
.gw-clone-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:8px}
.gw-clone-tab{display:inline-flex;align-items:center;gap:5px;padding:6px 10px;font:inherit;font-size:12px;
  background:none;border:none;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);
  cursor:pointer}
.gw-clone-tab:hover{color:var(--dsw-alias-label-primary)}
.gw-clone-tab.on{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary)}
.gw-dialog-body{flex:1;min-height:0;overflow:auto;padding:2px 0 6px}
.gw-clone-list{max-height:240px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;
  padding:2px}

/* ---------- 仓库下拉的行(Desktop RepositoryListItem) ---------- */
.gw-repo-row{height:29px}
.gw-repo-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gw-repo-owner{color:var(--dsw-alias-label-tertiary)}
.gw-repo-indicators{display:inline-flex;align-items:center;gap:4px;flex:none;
  color:var(--dsw-alias-label-tertiary)}
.gw-pop-divider{height:1px;margin:6px 5px;background:var(--dsw-alias-border-l1)}

/* ---------- 设置(Desktop Preferences) ---------- */
.gw-settings{width:min(560px,100%);height:min(480px,calc(100% - 32px));display:flex;flex-direction:column}
.gw-settings-container{flex:1;min-height:0;display:flex;gap:0;border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px;overflow:hidden;margin:2px 0 10px}
.gw-settings-tabs{flex:none;width:150px;display:flex;flex-direction:column;padding:4px;
  background:var(--dsw-alias-bg-layer-2);border-right:1px solid var(--dsw-alias-border-l1)}
.gw-settings-tab{display:flex;align-items:center;gap:7px;padding:6px 8px;font:inherit;font-size:12px;
  text-align:left;background:none;border:none;border-radius:6px;color:var(--dsw-alias-label-secondary);
  cursor:pointer}
.gw-settings-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.gw-settings-tab.on{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);
  font-weight:600}
.gw-settings-tab .icon{flex:none;color:var(--dsw-alias-label-tertiary)}
.gw-settings-tab.on .icon{color:var(--dsw-alias-label-primary)}
.gw-settings-content{flex:1;min-width:0;min-height:0;overflow:auto;padding:12px}
.gw-settings-section h3{margin:0 0 8px;font-size:13px;font-weight:600}
.gw-settings-section h3:not(:first-child){margin-top:16px}
.gw-settings-desc{margin:6px 0 0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
.gw-settings-desc code{font-family:var(--gw-mono,ui-monospace,Menlo,monospace);font-size:10px;
  background:var(--dsw-alias-bg-layer-2);border-radius:3px;padding:0 3px}
.gw-settings-row{display:flex;align-items:center;gap:6px;padding:5px 0;font-size:12px;cursor:pointer}
.gw-settings-list{max-height:220px;overflow:auto;margin-top:6px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:6px;padding:2px}
.gw-subtabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:10px}
.gw-subtab{padding:5px 9px;font:inherit;font-size:12px;background:none;border:none;
  border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.gw-subtab:hover{color:var(--dsw-alias-label-primary)}
.gw-subtab.on{color:var(--dsw-alias-label-primary);
  border-bottom-color:var(--dsw-alias-state-business-primary)}

/* Desktop accounts.tsx 的账号卡片 */
.gw-account-card{display:flex;align-items:center;gap:10px;padding:10px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.gw-avatar{width:32px;height:32px;border-radius:50%;flex:none;
  background:linear-gradient(135deg,var(--dsw-alias-brand-primary),#a371f7)}
.gw-account-meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.gw-account-login{font-size:11px;color:var(--dsw-alias-label-tertiary)}

/* 提交选项齿轮(Desktop 的 Configure commit options)。
   ⚠️ .gw-undo-commit 的两条规则已在 2026-10 随撤销提交条的移植**删除** ——
   那条 DOM 现在由上游 ui/changes/undo-commit.tsx 渲染(#undo-commit),
   外观由 desktop-changes.scss 已经在编译的 ui/changes/_undo-commit.scss 提供
   (references/desktop/app/styles/ui/changes/_undo-commit.scss:1-37)。
   留着这两条只会多一份会漂移的真源,而且它们和上游的 #undo-commit 不是同一套尺寸。

   ⚠️ 本文件是**一个 CSS 模板字符串**:这段注释里**不能出现反引号**(2026-10 已因此
   把构建炸掉一次,整棵客户端闭包连带所有探针全跑不了)。写选择器/路径名请用
   「…」或单引号。 */
.gw-commit-options{display:flex;flex-direction:column;gap:4px;padding:6px 8px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}

/* History 页签:提交详情原先以 .gw-body 为包含块(position:relative),整个盖住了
   提交列表(实测 320px 下 elementFromPoint 命中详情而非列表)。让它回到普通流。 */
.gw-split>.right>.gw-detail{position:static;inset:auto;flex:1;min-height:0}

/* ============================================================================
   空态修正。
   基底样式里的 .gw-empty 是 display:flex 但**没有 flex-direction**,默认就是 row;
   而 bits.tsx 的 Empty 组件会往它里面放 4 个直接子元素(图标 / 标题 / 正文 / 按钮),
   于是四块被横着排成一行,在窄侧栏里必然挤爆。这里显式改成列方向。
   注意必须写在基底样式副本**之后**才能覆盖它。
   ============================================================================ */
.gw-empty{flex-direction:column;gap:0;padding:24px 18px;align-items:center; /* dup-ok:空态修正,有意覆盖基底 */
  /* 刻意**不用** justify-content:center:内容比容器高时,居中会把顶行推到可视区外
     且滚不到(实测 320×200 面板下按钮落在 y=204 之外)。首尾 auto margin 等价居中,
     放不下时从顶部开始并可滚动。 */
  justify-content:flex-start;min-height:0;overflow:auto;
  line-height:1.7;text-align:center}
.gw-empty>div{max-width:100%}
.gw-empty>div:first-child{margin-top:auto}
.gw-empty>div:last-child{margin-bottom:auto}
/* 嵌在 .gw-files/.gw-tree 这类普通流容器里的空态:flex:1 失效,靠 min-height 撑满。 */
.gw-files>.gw-empty,.gw-tree>.gw-empty{padding:14px 10px;min-height:100%}

/* 极窄侧栏:再收一层内边距,并让按钮竖排,避免逐字换行 */
/* 极窄容器:左右两栏放不下时退回上下堆叠。
   Desktop 靠 BrowserWindow 的 minWidth=960 回避了窄栏问题,我们长在侧栏里没有这个条件。 */
@container (max-width: 420px){
  .gw-split{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) minmax(0,1fr)}
  .gw-split>.left{border-right:none;border-bottom:1px solid var(--dsw-alias-border-l1)}
}
@container (max-width: 340px){
  .gw-empty{padding:16px 10px}
  .gw-empty>div:last-child{display:flex;flex-direction:column;gap:6px;width:100%}
  .gw-empty .gw-btn{width:100%;justify-content:center}
}

/* 分支下拉里提示「按回车新建分支」用到的按键样式 */
.gw-hint kbd,.gw-settings-desc kbd{font-family:var(--gw-mono,ui-monospace,Menlo,monospace);font-size:10px;
  padding:0 3px;border:1px solid var(--dsw-alias-border-l2);border-radius:3px;
  background:var(--dsw-alias-bg-layer-2)}
.gw-strip{padding:5px 8px;margin:4px 0;border-radius:6px;font-size:11px;line-height:1.5;
  color:var(--dsw-alias-state-warn-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent)}

/* ============================================================================
   「没有本地变更」空态(Desktop 的 changes-interstitial + suggested-action)
   结构照 no-changes.tsx:763-785 与 suggested-action.tsx:70-92:标题句 + 描述 + 按钮。
   ============================================================================ */
.gw-interstitial{flex:1;min-height:0;overflow:auto;display:flex;align-items:flex-start;
  justify-content:center;padding:24px 18px}
.gw-interstitial .content{width:100%;max-width:520px;display:flex;flex-direction:column;gap:14px}
.gw-interstitial .interstitial-header h1{margin:0 0 6px;font-size:16px;font-weight:600;
  color:var(--dsw-alias-label-primary)}
.gw-interstitial .interstitial-header p{margin:0;font-size:12px;line-height:1.7;
  color:var(--dsw-alias-label-secondary)}
.gw-suggested-group{display:flex;flex-direction:column;gap:8px}
.gw-suggested{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
/* 「建议」列表里第一张卡的主色描边(Desktop 那边是蓝色强调)⇒ 蓝色强调令牌。 */
.gw-suggested-group.primary .gw-suggested{border-color:var(--dsw-alias-state-business-primary)}
.gw-suggested .text{flex:1;min-width:0}
.gw-suggested h2{margin:0;font-size:12px;font-weight:500;line-height:1.5;
  color:var(--dsw-alias-label-primary)}
.gw-suggested .desc{margin:3px 0 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.gw-suggested .gw-btn{flex:none;white-space:nowrap}

/* 窄侧栏下卡片改为竖排(标题在上、按钮通栏) */
@container (max-width: 420px){
  .gw-interstitial{padding:16px 12px}
  .gw-suggested{flex-direction:column;align-items:stretch}
  .gw-suggested .gw-btn{width:100%;justify-content:center}
}

/* ============================================================================
   变更行 —— 数值照 GitHub Desktop:
     · 行高 29px(ui/changes/filter-changes-list.tsx:85 的 RowHeight = 29)
     · .file 布局(styles/ui/_file-list.scss:28-57):flex / align-items:center /
       flex-grow:1 / min-width:0 / height:100% / padding:0 10px
     · 宽度算术(changed-file.tsx:57-66):列表内边距 20 + 复选框 20 + 文件内边距 5
       + 状态图标 16
     · 状态配色(styles/mixins/_octicon-status.scss:1-24,颜色换成宿主令牌)
   注意:这段注释在模板字符串里,**不能出现反引号**(会提前终止模板)。
   ============================================================================ */
.gw-frow.file{display:flex;align-items:center;flex-grow:1;min-width:0;height:29px;
  padding:0 10px;gap:0}
/* Changes 行勾选列的**上游槽位配方**(上游 'ui/_checkbox.scss:1-14' 的 '.checkbox-component'
   + 'ui/_file-list.scss:34-42' 的 20px 槽宽)。为什么必须在这里补:产物里 '.checkbox-component'
   只出现在 '.gw-desktop-diff' / '.gw-repo-list' / '.gw-desktop-history' 三个作用域下,
   '.gw-desktop-changes .checkbox-component' **不存在**(全仓没有任何 className 发出
   '.gw-desktop-changes')⇒ Changes 面的配方永远匹配不到。A/B 实测:配方在场 → input 13×13、
   margin 0、在 29px 行里垂直居中;不在场 → 外层 div 20×21 block、input 带 UA margin 3/4px
   (横向偏 4px)。
   唯一残差:本行有 border-left:2px(:581)⇒ 内容起点 x=12 而上游 x=10,**2px,不修也看不出**。 */
.gw-frow.file .checkbox-component{flex:none;width:20px;display:flex;flex-direction:row;align-items:center}
.gw-frow.file .checkbox-component input{margin:0}
/* 路径:目录变暗、文件名正常(styles/ui/_path-text.scss:3-9) */
.gw-frow.file .path-label-component{display:flex;flex-direction:row;flex-grow:1;
  align-self:center;min-width:0;margin-right:5px}
.gw-frow.file .path-text-component{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  min-width:0;flex:1}
.gw-frow.file .path-text-component .dirname{color:var(--dsw-alias-label-tertiary)}
.gw-frow.file .path-text-component .filename{color:var(--dsw-alias-label-primary)}
.gw-frow.file .rename-arrow{margin:0 5px;color:var(--dsw-alias-label-tertiary);
  vertical-align:middle;flex:none}
.gw-frow.file .status{flex:none;display:inline-flex;align-items:center;
  justify-content:center;width:16px}
/* 状态配色:Desktop 用 --color-*,这里映射到宿主的 state/brand 令牌 */
.gw-frow.file .status-new{color:var(--dsw-alias-state-success-primary)}
.gw-frow.file .status-copied{color:var(--dsw-alias-state-success-primary)}
.gw-frow.file .status-modified{color:var(--dsw-alias-state-warn-primary)}
.gw-frow.file .status-deleted{color:var(--dsw-alias-state-error-primary)}
/* 重命名状态图标:Desktop 的 --color-renamed 是 $blue(蓝),不是品牌墨色。
   宿主没有 renamed 专用令牌,取蓝色强调令牌(同 _dsh-bridge.scss 的 --color-renamed)。 */
.gw-frow.file .status-renamed{color:var(--dsw-alias-state-business-primary)}
.gw-frow.file .status-conflicted{color:var(--dsw-alias-state-error-primary)}

/* 目录图标用品牌色(远端 Code 页签原来是内联 --dsw-alias-accent-primary,但那个令牌
   在宿主里不存在、一直退化成继承色;这里统一走类名,免得再漏一次)。 */
.gw-tree-dir{color:var(--dsw-alias-brand-primary)}

/* ============================================================================
   Changes 表头与筛选 — 数值照 GitHub Desktop:
     · 表头 padding 5px 10px、底色 alt、下边框(ui/changes/_changes-list.scss:82-88)
     · 组合控件:按钮 6px 0 0 6px 且 border-right:none,输入框 0 6px 6px 0
       (_changes-list.scss:95-108),两者都 25px 高(--button-height/--text-field-height)
     · 复选框行 input 右间距 7px(_changes-list.scss:155-167)
     · 弹层 min-width 200px(这里用 240 免得标签+计数换行),
       .filter-options margin 10px 0,footer padding 5px 0 10px(_changes-list.scss:47-73)
     注意 Desktop 的 .filter-options-footer 用了 var(--spacing-quarter),而那个变量
     在它的样式表里**从未定义**(只有 half/third/double...),等于 margin-top:0。我们直接写 0。
   ============================================================================ */
.gw-chead{flex:none;display:flex;flex-direction:column;padding:5px 10px;
  background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1)}
.gw-filter-box{display:flex;align-items:center;margin-bottom:5px;position:relative}
.gw-filter-btn{display:inline-flex;align-items:center;gap:2px;height:25px;padding:0 8px;
  border-radius:6px 0 0 6px;border:1px solid var(--dsw-alias-border-l1);border-right:none;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;font-weight:600;cursor:pointer;flex:none}
/* 激活的筛选按钮文字:这是「选中态的最强正文墨色」,宿主对应 --dsw-alias-label-primary
   (与 brand-primary 同值,但语义是正文墨而不是品牌色)。 */
.gw-filter-btn.active{color:var(--dsw-alias-label-primary)}
.gw-filter-input{flex:1;min-width:0;height:25px;padding:0 5px;font:inherit;font-size:12px;
  border-radius:0 6px 6px 0;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.gw-filter-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.gw-checkall{display:flex;align-items:center;gap:7px;font-size:12px;flex-wrap:wrap}
.gw-chead-warn{color:var(--dsw-alias-state-error-primary);font-size:11px}
.gw-filter-pop{position:absolute;top:30px;left:0;z-index:40;min-width:240px;
  max-width:calc(100% - 4px);padding:10px 10px 0;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  box-shadow:0 8px 24px rgba(0,0,0,.28)}
.gw-filter-pop-head{display:flex;justify-content:space-between;align-items:center}
.gw-filter-pop-head h3{margin:0;font-size:12px;font-weight:600}
.gw-filter-opts{margin:10px 0;display:flex;flex-direction:column;gap:4px}
.gw-filter-pop-foot{padding:5px 0 10px;margin-top:0;text-align:left}

/* ============================================================================
   仓库下拉 —— 数值照 GitHub Desktop 的 app/styles/ui/_repository-list.scss:
     .repository-list-item      padding 0 10px / flex row / align-items center / width 100%
     .icon-for-repository       margin-right 5px / flex-shrink 0 / width 16px
     .name                      ellipsis;.prefix 次要色;.alias 斜体
     .repo-indicators           margin-left auto / justify-end / margin-right 5px
     .change-indicator-wrapper  min-width 12px / 居中 / margin-left 5px
     .ahead-behind              高 12px(macOS)、底色用 badge 底、色用 badge 字色
     .filter-list-group-header  padding-top 10px + 溢出省略 + 600 字重
     .no-items                  text-align center / padding 10px;.title 600;.protip 11px
   行高 29 来自 repositories-list.tsx:85 的 RowHeight。
   ============================================================================ */
/* .gw-repo-pop 的高度/定位**统一由上面那条 .gw-pop 决定**(position:absolute +
   top:calc(100% + 4px) + max-height:min(70vh,520px))。
   这里原本还有一条 .gw-repo-pop{max-height:calc(100% - 56px)} —— 它的选择器
   比 .gw-pop 多一个类、特异性更高,所以**静默压掉了** .gw-pop 的上限。
   而 100% 在绝对定位元素上解析成**包含块**(即 .gw-header)的高度 ≈ 46px,
   于是 max-height 被算成负数、夹到 0 —— 面板塌成 16px、列表完全看不见。
   这是真 Chrome 实测确认的根因(docs/desktop-ui-port.md 的实测记录),
   不是「定位差 1px」那类小问题。**别再把它加回来**。 */
.gw-repo-list{flex:1;min-height:0;overflow:auto;padding-bottom:4px}
.gw-repo-row{display:flex;flex-direction:row;align-items:center;width:100%;height:29px;
  padding:0 10px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary)}
.gw-repo-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.gw-repo-row.cur{background:var(--dsw-alias-interactive-bg-active)}
.gw-repo-row.missing .name{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}
/* 焦点环:只声明样式,颜色与宽度交给宿主的全局 :focus-visible
   (ui-theme/src/styles/focus.css 的 outline-color / outline-width)。
   键盘聚焦时是宿主标准的 2px 蓝色环;指针模态下宿主把
   --dsw-focus-ring-color 置成 transparent 的抑制也照样生效。 */
.gw-repo-row:focus-visible{outline-style:solid;outline-offset:-2px}
.gw-repo-row .icon-for-repository{margin-right:5px;flex:none;width:16px;
  color:var(--dsw-alias-label-tertiary)}
.gw-repo-row .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.gw-repo-row .name .prefix{color:var(--dsw-alias-label-tertiary)}
.gw-repo-row .name .alias{font-style:italic}
.gw-repo-row .repo-indicators{margin-left:auto;display:flex;justify-content:flex-end;
  align-items:center;margin-right:5px;flex:none;gap:0}
/* 照 _repository-list.scss:248-267:
     .ahead-behind { height:16px; background:var(--list-item-badge-background-color);
                     color:var(--list-item-badge-color); @include darwin { height:12px; line-height:12px } }
   我们是 web,取 darwin 那档 12px;徽标底色/字色映射到宿主的层级色与次要文字色。 */
.gw-repo-row .ahead-behind{height:12px;line-height:12px;display:inline-flex;align-items:center;
  padding:0 4px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);
  color:var(--dsw-alias-label-secondary)}
.gw-repo-row .change-indicator-wrapper{display:flex;min-width:12px;justify-content:center;
  align-items:center;margin-left:5px;
  /* 照 _repository-list.scss:243-247: .change-indicator-wrapper .octicon{color:var(--tab-bar-active-color)}
     —— Desktop 的 --tab-bar-active-color 是 Sass 变量 $blue,截图里那个蓝点就是它。
     宿主没有「tab 栏激活色」这个名字,对应的是 --dsw-alias-state-business-primary
     (浅 #4176e6 / 深 #7aaaFF);原先绑 brand-primary ⇒ 浅色下是近黑点,不是蓝点。 */
  color:var(--dsw-alias-state-business-primary)}
/* 照 Desktop 的两条规则叠加:
     _filter-list.scss:28-31  .filter-list-group-header { padding:0 var(--spacing); font-weight:semibold }
     _repository-list.scss:73-78  .repository-list .filter-list-group-header { padding-top:var(--spacing);
                                   text-overflow:ellipsis; overflow-x:hidden; white-space:nowrap }
   --spacing=10px、semibold=600。Desktop 此处**没有** uppercase,截图也证实是 Recent/1rgs。 */
.gw-group-head{padding:10px 10px 0;font-weight:600;font-size:12px;
  color:var(--dsw-alias-label-primary);overflow-x:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.gw-no-items{text-align:center;padding:10px;word-wrap:break-word}
.gw-no-items .title{font-weight:600;font-size:12px;color:var(--dsw-alias-label-secondary)}
.gw-no-items .protip{padding:20px 20px 0;text-align:center;font-size:11px;
  color:var(--dsw-alias-label-tertiary);line-height:1.7}
/* 照 _repository-list.scss:110-125 的 kbd:radius 6px、base-border、min-height 16px、
   padding 1px 2px、line-height 1、font-family 继承。 */
.gw-no-items kbd{display:inline-block;padding:1px 2px;min-height:16px;line-height:1;
  font-family:inherit;font-size:10px;text-align:center;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
/* 右键菜单:Desktop 用 Electron 原生菜单,这里用绝对定位的 div */
.gw-menu{position:absolute;z-index:60;min-width:180px;max-width:calc(100% - 16px);
  padding:4px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px rgba(0,0,0,.28)}
.gw-menu-item{display:block;width:100%;text-align:left;padding:5px 8px;border:none;
  background:none;font:inherit;font-size:12px;border-radius:4px;cursor:pointer;
  color:var(--dsw-alias-label-primary)}
.gw-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.gw-menu-item:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.gw-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1)}

/* Diff Settings 弹层 —— 数值照 Desktop 的 styles/ui/_diff-options.scss(79 行)。
   只有两项控件,理由见 diff-settings.tsx 的注释。 */
.gw-diffopt{position:relative;flex:none;display:flex;align-items:center}
.gw-diffopt>.gw-hbtn{display:inline-flex;align-items:center;gap:2px}
.gw-diffopt-pop{position:absolute;top:22px;right:0;z-index:45;width:250px;
  max-width:calc(100vw - 24px);padding:10px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  box-shadow:0 8px 24px rgba(0,0,0,.28);text-align:left}
.gw-diffopt-head{display:flex;justify-content:space-between;align-items:center;
  margin-bottom:6px}
.gw-diffopt-head h3{margin:0;font-size:12px;font-weight:600}
.gw-diffopt-group{margin:10px 0 0;padding:0;border:none}
.gw-diffopt-group legend{padding:0;font-size:11px;font-weight:600;
  color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.04em}
.gw-diffopt-group .gw-chk{margin-top:6px}
.gw-diffopt-radios{display:flex;gap:14px}
.gw-diffopt-hint{margin:6px 0 0;font-size:11px;line-height:1.5;
  color:var(--dsw-alias-label-tertiary)}
`;

/** 注入样式(幂等)。 */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS.replace(/var\(--gw-mono\)/g, 'var(--gw-mono,ui-monospace,SFMono-Regular,Menlo,monospace)');
  document.head.appendChild(style);
}
