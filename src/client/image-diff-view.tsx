/**
 * **图片 diff 的渲染层(URL 版)** —— 上游 `ui/diff/image-diffs/**` 的同一套结构,
 * 唯一改动是**图片地址的来源**:`<img src>` 直接指向 `GET /dsh-git/blob`,
 * 而不是 `data:${mediaType};base64,${contents}`。
 *
 * ## 为什么需要一个兄弟实现(而不是直接用镜像里那 11 个文件)
 *
 * 上游那 11 个文件**一个字节都没改**地躺在 `src/core/desktop/ui/diff/image-diffs/`,
 * 但它们全都经过 `image-container.tsx` 的 `loadImage()`,而那里写死了:
 *
 *     imageSource: `data:${image.mediaType};base64,${image.contents}`
 *
 * 于是「让浏览器自己去取、去解码、去缓存」在这条路上**做不到**:
 *  - `contents` 必须是**整份 base64 字符串**,内存里同时存在 base64 与解码结果;
 *  - base64 比原始字节大 33%,而且必须先穿过 JS 字符串;
 *  - `data:` URL 没有 HTTP 缓存语义(每次渲染重新构造、重新解码)。
 *
 * 上游 `Image`(`models/diff/image.ts`)与 `image-container.tsx` 都是**字节一致的镜像
 * 文件**,本轮的改动范围明确不含它们(`docs/goal-port-desktop.md` §10.3 的「镜像必须
 * 字节一致,适配放我们这层」)。所以适配放在**我们这层**:本文件逐条沿用上游的
 * 结构、类名与交互(`TwoUp` / `Swipe` / `Onion Skin` / `Difference` 四种模式、
 * `TabBar` 切换器、`ResizeObserver` 量最大适配尺寸),只把 `ImageContainer`
 * 换成 {@link BlobImageContainer}(`<img src={url}>`)。
 *
 * **这是本轮唯一一处刻意的手写渲染层,已写进报告**:更彻底的修法是给上游 `Image`
 * 加一个可选的 `src` 字段(约 2 行),那样镜像组件可以原样用 URL 渲染,本文件
 * 500 行重复即可删除 —— 但那要改镜像文件,归本轮范围之外。
 *
 * ## 镜像那一份仍然是**活的兜底**
 *
 * `image-diff.ts` 在 `blobHead` 回 `unavailable`(老 host,host 半不热重载)时会
 * 退回 `show-file`/`file-text` 的 base64,再把 `data:` URL 交给**本文件**
 * (两侧的 `src` 字段就是一个字符串,URL 与 data URL 都能喂 `<img src>`)。
 * 所以镜像的 `image-container` 只在那条兜底路上参与 —— 它没有变成死代码。
 *
 * @module dsh-git/client/image-diff-view
 */

import * as React from 'react'
import classNames from 'classnames'

import { ImageDiffType } from '../core/desktop/models/diff/index.ts'
import { TabBar, TabBarType } from '../core/desktop/ui/tab-bar.tsx'
import { getMaxFitSize, type ISize } from '../core/desktop/ui/diff/image-diffs/sizing.ts'
import { formatBytes } from '../core/desktop/ui/lib/bytes.ts'
import { assertNever } from '../core/desktop/lib/fatal-error.ts'

/** How much bigger the slider should be than the images.(上游 `swipe.tsx:6`) */
const SliderOverflow = 14

/**
 * 镜像 `TabBar` 的**类型适配**:它的 `ITabBarProps`(`ui/tab-bar.tsx:11-22`)
 * 没声明 `children` —— 上游靠 React 的隐式 children,而我们这层是严格检查,
 * 于是 `<TabBar>{items}</TabBar>` 会被判成「不存在的 prop」。
 * 同一处报错在 `src/client/preferences-dialog.tsx` 也有(另一条线),说明这是镜像的
 * 既有类型缺口,不是我们用法的问题。
 * 镜像文件不能改 ⇒ 在**我们这层**补上 props 类型再渲染(适配放我们的层)。
 */
const SwitchTabBar = TabBar as unknown as React.ComponentType<{
  selectedIndex: number
  onTabClicked: (index: number) => void
  type?: TabBarType
  children?: React.ReactNode
}>

/**
 * 一侧图片。与上游 `Image`(models/diff/image.ts)**同形**,只把「内容」换成地址:
 *  - `src` —— 直接喂 `<img src>`(blob 端点 URL,或迁移期兜底的 `data:` URL);
 *  - `mediaType` / `bytes` —— 与上游同义(footer 显示大小、DDS 分支判断)。
 *
 * `src` 是字符串而不是 `contents + mediaType` 两个字段:后者决定了「必须是 base64」,
 * 而这里要的正是**不必知道内容是什么形态**。
 */
export interface IBlobImage {
  readonly src: string
  readonly mediaType: string
  readonly bytes: number
}

interface IBlobImageContainerProps {
  readonly image: IBlobImage
  readonly style?: React.CSSProperties
  readonly onElementLoad?: (img: HTMLImageElement) => void
}

/**
 * 上游 `image-container.tsx` 的等价物:**没有 `loadImage` / 没有 state**。
 *
 * 上游要在 `componentDidMount` 里把 `contents` 拼成 data URL 再 setState,
 * 所以它是个带状态的 class;直接给 URL 就只剩一个受控的 `<img>`,不需要状态,
 * 也就不会因为「图片对象换了、state 没跟上」再渲染一帧空图。
 *
 * 仍然是 class(而不是函数组件)有两个具体理由:
 *  1. 与上游同一个形状,DOM/类名逐字可比;
 *  2. `onLoad` 必须是**稳定的方法引用** —— 函数组件里的箭头常量每次渲染都会换新,
 *     而 `react/jsx-no-bind` 正是拦这个(镜像那份靠基线豁免,我们这层不豁免)。
 */
class BlobImageContainer extends React.Component<IBlobImageContainerProps, {}> {
  private onLoad = (event: React.SyntheticEvent<HTMLImageElement>): void => {
    this.props.onElementLoad?.(event.currentTarget)
  }

  public render(): React.ReactNode {
    return (
      <div className="image-wrapper">
        <img src={this.props.image.src} style={this.props.style} onLoad={this.onLoad} alt="" />
      </div>
    )
  }
}

/** 上游 `ICommonImageDiffProperties`(逐字)。 */
export interface ICommonImageDiffProperties {
  readonly maxSize: ISize
  readonly previous: IBlobImage
  readonly current: IBlobImage
  readonly onPreviousImageLoad: (img: HTMLImageElement) => void
  readonly onCurrentImageLoad: (img: HTMLImageElement) => void
  readonly onContainerRef: (e: HTMLElement | null) => void
}

/** 上游 `modified-image-diff.tsx` 的 `TwoUp`(逐字,只换容器)。 */
function TwoUp(props: ICommonImageDiffProperties & {
  readonly previousImageSize: ISize | null
  readonly currentImageSize: ISize | null
}): React.ReactElement {
  const zeroSize = { width: 0, height: 0 }
  const previousImageSize = props.previousImageSize ?? zeroSize
  const currentImageSize = props.currentImageSize ?? zeroSize
  const { current, previous } = props
  const diffBytes = current.bytes - previous.bytes
  const diffBytesSign = diffBytes >= 0 ? '+' : ''
  const percent = previous.bytes === 0 ? 0 : Math.abs(Math.round((current.bytes / previous.bytes) * 100))
  const style: React.CSSProperties = { maxWidth: props.maxSize.width < 200 ? undefined : props.maxSize.width }

  return (
    <div className="image-diff-container" ref={props.onContainerRef}>
      <div className="image-diff-two-up">
        <div className="image-diff-previous" style={style}>
          <div className="image-diff-header">Deleted</div>
          <BlobImageContainer image={previous} onElementLoad={props.onPreviousImageLoad} />
          <div className="image-diff-footer">
            <span className="strong">W:</span> {previousImageSize.width}
            px | <span className="strong">H:</span> {previousImageSize.height}
            px | <span className="strong">Size:</span> {formatBytes(previous.bytes, 2)}
          </div>
        </div>

        <div className="image-diff-current" style={style}>
          <div className="image-diff-header">Added</div>
          <BlobImageContainer image={current} onElementLoad={props.onCurrentImageLoad} />
          <div className="image-diff-footer">
            <span className="strong">W:</span> {currentImageSize.width}
            px | <span className="strong">H:</span> {currentImageSize.height}
            px | <span className="strong">Size:</span> {formatBytes(current.bytes, 2)}
          </div>
        </div>
      </div>
      <div className="image-diff-summary">
        Diff:{' '}
        <span className={classNames({ added: diffBytes > 0, removed: diffBytes < 0 })}>
          {diffBytes !== 0 ? `${diffBytesSign}${formatBytes(diffBytes, 2)} (${percent}%)` : 'No size difference'}
        </span>
      </div>
    </div>
  )
}

/** 上游 `swipe.tsx`(逐字,只换容器)。 */
class Swipe extends React.Component<ICommonImageDiffProperties, { readonly percentage: number }> {
  public constructor(props: ICommonImageDiffProperties) {
    super(props)
    this.state = { percentage: 0 }
  }

  private onValueChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    this.setState({ percentage: e.currentTarget.valueAsNumber })
  }

  public render(): React.ReactNode {
    const style: React.CSSProperties = { height: this.props.maxSize.height, width: this.props.maxSize.width }
    const swiperWidth = this.props.maxSize.width * (1 - this.state.percentage / 100.0)
    const previousStyle: React.CSSProperties = {
      position: 'absolute',
      top: 0,
      left: 0,
      height: this.props.maxSize.height,
      width: this.props.maxSize.width,
      clipPath: `inset(0 ${Math.floor(swiperWidth)}px 0 0)`,
    }
    const currentStyle: React.CSSProperties = {
      position: 'absolute',
      top: 0,
      left: 0,
      height: this.props.maxSize.height,
      width: this.props.maxSize.width,
      clipPath: `inset(0 0 0 ${Math.floor(this.props.maxSize.width - swiperWidth)}px)`,
    }
    const maxSize: React.CSSProperties = {
      maxHeight: this.props.maxSize.height,
      maxWidth: this.props.maxSize.width,
    }

    return (
      <div className="image-diff-swipe">
        <input
          style={{ width: this.props.maxSize.width + SliderOverflow }}
          className="slider"
          type="range"
          max={100}
          min={0}
          value={this.state.percentage}
          step={0.1}
          onChange={this.onValueChange}
        />
        <div className="sizing-container" ref={this.props.onContainerRef}>
          <div className="image-container" style={style}>
            <div className="image-diff-previous" style={previousStyle}>
              <BlobImageContainer image={this.props.previous} onElementLoad={this.props.onPreviousImageLoad} style={maxSize} />
            </div>
            <div className="image-diff-current" style={currentStyle}>
              <BlobImageContainer image={this.props.current} onElementLoad={this.props.onCurrentImageLoad} style={maxSize} />
            </div>
          </div>
        </div>
      </div>
    )
  }
}

/** 上游 `onion-skin.tsx`(逐字,只换容器)。 */
class OnionSkin extends React.Component<ICommonImageDiffProperties, { readonly crossfade: number }> {
  public constructor(props: ICommonImageDiffProperties) {
    super(props)
    this.state = { crossfade: 1 }
  }

  private onValueChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    this.setState({ crossfade: e.currentTarget.valueAsNumber })
  }

  public render(): React.ReactNode {
    const style: React.CSSProperties = { height: this.props.maxSize.height, width: this.props.maxSize.width }
    const maxSize: React.CSSProperties = {
      maxHeight: this.props.maxSize.height,
      maxWidth: this.props.maxSize.width,
    }

    return (
      <div className="image-diff-onion-skin">
        <input
          style={{ width: this.props.maxSize.width / 2 }}
          className="slider"
          type="range"
          max={100}
          min={0}
          value={this.state.crossfade}
          step={0.1}
          onChange={this.onValueChange}
        />
        <div className="sizing-container" ref={this.props.onContainerRef}>
          <div className="image-container" style={style}>
            <div className="image-diff-previous" style={style}>
              <BlobImageContainer image={this.props.previous} onElementLoad={this.props.onPreviousImageLoad} style={maxSize} />
            </div>
            <div className="image-diff-current" style={{ ...style, opacity: this.state.crossfade / 100.0 }}>
              <BlobImageContainer image={this.props.current} onElementLoad={this.props.onCurrentImageLoad} style={maxSize} />
            </div>
          </div>
        </div>
      </div>
    )
  }
}

/** 上游 `difference-blend.tsx`(逐字,只换容器)。 */
function DifferenceBlend(props: ICommonImageDiffProperties): React.ReactElement {
  const style: React.CSSProperties = { height: props.maxSize.height, width: props.maxSize.width }
  const maxSize: React.CSSProperties = { maxHeight: props.maxSize.height, maxWidth: props.maxSize.width }

  return (
    <div className="image-diff-difference" ref={props.onContainerRef}>
      <div className="sizing-container">
        <div className="image-container" style={style}>
          <div className="image-diff-previous">
            <BlobImageContainer image={props.previous} onElementLoad={props.onPreviousImageLoad} style={maxSize} />
          </div>
          <div className="image-diff-current">
            <BlobImageContainer
              image={props.current}
              onElementLoad={props.onCurrentImageLoad}
              style={{ ...maxSize, mixBlendMode: 'difference' }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

interface IImageDiffPanelProps {
  /**
   * 两侧;只有一侧时另一侧为 `undefined`。
   *
   * **不再需要 `kind`**:上游 `Diff.renderImage` 拿文件状态判「单侧视图是否合法」,
   * 而 `loadImageView` 已经把判据换成「另一侧**确实不存在**」(`pickImageView`)——
   * 走到这里时「只有 current」就等价于「这是一张新增的图」,标签因此永远是真的。
   * 少一个 prop 也少一处会漂移的判据。
   */
  readonly previous: IBlobImage | undefined
  readonly current: IBlobImage | undefined
  readonly diffType: ImageDiffType
  readonly onChangeDiffType: (type: ImageDiffType) => void
}

interface IImageDiffPanelState {
  readonly previousImageSize: ISize | null
  readonly currentImageSize: ISize | null
  readonly containerSize: ISize | null
}

/**
 * 上游 `modified-image-diff.tsx` 的容器部分(逐字),外加新增/删除两种单侧形态
 * (上游 `new-image-diff.tsx` / `deleted-image-diff.tsx` 是独立的两个组件,
 * 这里收到同一个组件里,因为它们的差别只有节点多少)。
 */
class ModifiedBlobImageDiff extends React.Component<
  IImageDiffPanelProps & { readonly previous: IBlobImage; readonly current: IBlobImage },
  IImageDiffPanelState
> {
  private container: HTMLElement | null = null
  private readonly resizeObserver: ResizeObserver

  public constructor(props: IImageDiffPanelProps & { readonly previous: IBlobImage; readonly current: IBlobImage }) {
    super(props)
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const { target } of entries) {
        if (target === this.container && target instanceof HTMLElement) {
          // 用 offsetWidth/Height(而不是 contentRect):上游 `modified-image-diff.tsx:104-107`
          // 量的就是这个,边框宽度因此与上游一致。
          this.setState({ containerSize: { width: target.offsetWidth, height: target.offsetHeight } })
        }
      }
    })
    this.state = { previousImageSize: null, currentImageSize: null, containerSize: null }
  }

  public componentWillUnmount(): void {
    this.resizeObserver.disconnect()
  }

  private onPreviousImageLoad = (img: HTMLImageElement): void => {
    this.setState({ previousImageSize: { width: img.naturalWidth, height: img.naturalHeight } })
  }

  private onCurrentImageLoad = (img: HTMLImageElement): void => {
    this.setState({ currentImageSize: { width: img.naturalWidth, height: img.naturalHeight } })
  }

  /**
   * `TabBar` 的 `onTabClicked: (index: number) => void` 与上游的
   * `onChangeDiffType(type: ImageDiffType)` 是同一个东西(`ImageDiffType` 的下标
   * 就是序号)。写成**稳定的方法引用**而不是 JSX 里的箭头(`react/jsx-no-bind`),
   * 用显式转换代替上游那种靠方法双变性通过类型检查的写法。
   */
  private onTabClicked = (index: number): void => {
    this.props.onChangeDiffType(index as ImageDiffType)
  }

  private onContainerRef = (c: HTMLElement | null): void => {
    this.container = c
    this.resizeObserver.disconnect()
    if (c) {
      this.resizeObserver.observe(c)
    }
  }

  private getMaxSize(): ISize {
    const zeroSize = { width: 0, height: 0 }
    const containerSize = this.state.containerSize
    if (!containerSize) {
      return zeroSize
    }
    const { previousImageSize, currentImageSize } = this.state
    if (!previousImageSize || !currentImageSize) {
      return zeroSize
    }
    return getMaxFitSize(previousImageSize, currentImageSize, containerSize)
  }

  private getCommonProps(maxSize: ISize): ICommonImageDiffProperties {
    return {
      maxSize,
      previous: this.props.previous,
      current: this.props.current,
      onPreviousImageLoad: this.onPreviousImageLoad,
      onCurrentImageLoad: this.onCurrentImageLoad,
      onContainerRef: this.onContainerRef,
    }
  }

  private renderCurrentDiffType(): React.ReactNode {
    const maxSize = this.getMaxSize()
    switch (this.props.diffType) {
      case ImageDiffType.TwoUp:
        return (
          <TwoUp
            {...this.getCommonProps(maxSize)}
            previousImageSize={this.state.previousImageSize}
            currentImageSize={this.state.currentImageSize}
          />
        )
      case ImageDiffType.Swipe:
        return <Swipe {...this.getCommonProps(maxSize)} />
      case ImageDiffType.OnionSkin:
        return <OnionSkin {...this.getCommonProps(maxSize)} />
      case ImageDiffType.Difference:
        return <DifferenceBlend {...this.getCommonProps(maxSize)} />
      default:
        return assertNever(this.props.diffType, `Unknown diff type: ${this.props.diffType}`)
    }
  }

  public render(): React.ReactNode {
    return (
      <div className="panel image" id="diff">
        <SwitchTabBar
          selectedIndex={this.props.diffType}
          // 上游 `modified-image-diff.tsx:150` 直接把 `onChangeDiffType` 传给
          // `onTabClicked: (index: number) => void`(靠方法的双变性通过类型检查)。
          // 这里是**我们这层**的文件、严格检查生效,所以显式转一下:
          // `ImageDiffType` 的下标与序号一一对应,`TabBar` 传来的就是那个序号。
          onTabClicked={this.onTabClicked}
          type={TabBarType.Switch}
        >
          <span>2-up</span>
          <span>Swipe</span>
          <span>Onion Skin</span>
          <span>Difference</span>
        </SwitchTabBar>
        {this.renderCurrentDiffType()}
      </div>
    )
  }
}

/**
 * 图片 diff 的入口:按「哪几侧存在」分派(判据与上游 `Diff.renderImage` 逐条一致)。
 * @param props - 见 {@link IImageDiffPanelProps}。
 */
export function ImageDiffPanel(props: IImageDiffPanelProps): React.ReactElement | null {
  const { previous, current } = props
  if (current !== undefined && previous !== undefined) {
    return <ModifiedBlobImageDiff {...props} previous={previous} current={current} />
  }
  if (current !== undefined) {
    return (
      <div className="panel image" id="diff">
        <div className="image-diff-current">
          <div className="image-diff-header">Added</div>
          <BlobImageContainer image={current} />
        </div>
      </div>
    )
  }
  if (previous !== undefined) {
    return (
      <div className="panel image" id="diff">
        <div className="image-diff-previous">
          <div className="image-diff-header">Deleted</div>
          <BlobImageContainer image={previous} />
        </div>
      </div>
    )
  }
  return null
}
