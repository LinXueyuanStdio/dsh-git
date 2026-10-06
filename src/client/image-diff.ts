/**
 * **图片 diff 的组装层**(纯客户端)—— 把 `GET /dsh-git/blob` 的原始字节组装成
 * 渲染层要的两侧。
 *
 * ## 为什么需要这一层(而镜像里明明有图片 diff 的实现)
 *
 * `src/core/desktop/ui/diff/image-diffs/**`(11 文件 / 892 行)与 20 条样式规则**都已与上游一致**、
 * 也都在产出 CSS 里,但 `Diff` 的 `DiffType.Image` 分支**从来没有输入** ——
 * 全仓库没有任何一处构造 `IImageDiff`。上游那个构造器在
 * `references/desktop/app/src/lib/git/diff.ts` 的 `getImageDiff` / `getBlobImage`
 * / `getWorkingDirectoryImage`,而 `lib/git/**` 正是**宿主已经取代**的那一层
 * (`docs/goal-port-desktop.md` §1.3:不沿用 `lib/stores/**`;git 操作归 host)。
 * 所以这一层必须在我们这侧写,和 `desktop-diff.tsx` 的「客户端翻译」同一个性质。
 *
 * ## 这一版换了**取数通道**(本轮的重点)
 *
 * | | 旧 | 新 |
 * |---|---|---|
 * | 传输 | `show-file` / `file-text` 的 **base64 in JSON** | `GET /dsh-git/blob` 的**原始字节** |
 * | 图片地址 | `data:${mediaType};base64,${…}` | blob 端点的 **URL**(`<img src>`) |
 * | 内存 | base64 字符串 + 解码结果同时在 JS 里 | 只有浏览器的解码结果 |
 * | 缓存 | 无(`data:` URL 没有 HTTP 缓存语义) | `ETag` + `immutable`(完整 sha)/ `no-cache`(会动的引用与工作区) |
 * | 超限 | 客户端不知道上限,只会拿到空内容 | **先量后画**:`blobHead` 报「3.2 MB,上限 2 MB」,走 `DiffType.Binary` |
 *
 * ## 镜像那一份没被丢掉,是**老 host 的兜底**
 *
 * host 半不热重载:刷新页面会先拿到新前端,而 host 可能还是旧构建(没有 blob 路由)。
 * 那时 `blobHead` 回 `unavailable`,这里退回 `show-file` / `file-text` 的 base64,
 * 把 `data:` URL 交给同一个 `<img src>`(`IBlobImage.src` 只是一个字符串)。
 * 兜底的 base64 上限是 256 KiB(`core/blob.ts` 的 `BLOB_JSON_FALLBACK_MAX_BYTES`)——
 * 比主路径的上限低得多,理由写在那里。
 *
 * ## 两道必须照做的守卫(与旧版逐条相同)
 *
 *  1. **只接受「真的拿到了字节」的响应**。`too-big` / `missing` / 空内容一律降级成
 *     `null` ⇒ 调用方退回 `DiffType.Binary`(「This binary file has changed.」+
 *     打开外部程序)。拿空内容去画就是**一张 0 字节的裂图,而且不报错**。
 *  2. **两侧的顺序/存在性与上游一致**(`lib/git/diff.ts:612-686`):
 *     删除的文件只有 `previous`;新增/未跟踪只有 `current`;重命名要按
 *     `getOldPathOrDefault` 去读旧路径。**并且**只有上游 `renderImage` 真能画出来的
 *     组合才返回 view;其余回 `null`(同样降级,而不是交一个会让 `renderImage`
 *     返回 `null` 的空白面板)。
 *
 * @module dsh-git/client/image-diff
 */

import { api } from './api.ts';
import { getOldPathOrDefault } from '../core/desktop/lib/get-old-path.ts';
// `ChangedFile = WorkingDirectoryFileChange | CommittedFileChange` 的**导出**位置是
// 镜像的 `ui/diff/diff-helpers.tsx:207`(上游同址);`models/status.ts` 没有这个别名,
// 从那里 import 会得到 TS2305(而且名字被擦除,构建照样绿)。本文件由 diff 那条线
// 新建,这里只改这一行 import 目标 —— 见交付说明。
import type { ChangedFile } from '../core/desktop/ui/diff/diff-helpers.tsx';
import type { FileStatusKind } from '../core/partial-stage.ts';
import type { IBlobImage } from './image-diff-view.tsx';

/**
 * 我们能渲染的图片扩展名 —— **与上游一致**上游
 * `references/desktop/app/src/lib/git/diff.ts:94-104`。
 *
 * 上游在这之后还有一步 `if (enableImagePreviewsForDDSFiles()) imageFileExtensions.add('.dds')`,
 * 而那个开关是 Desktop 的**beta 特性标志**(`lib/feature-flag.ts:83-85` →
 * `enableBetaFeatures()`),浏览器半没有特性标志界面。默认值就是「不启用」,
 * 所以这里保持与默认一致:`.dds` 不进白名单(`getMediaType` 仍保留 `.dds` 分支,
 * 与上游逐字一致,等真有特性标志时只需加一行)。
 */
const IMAGE_FILE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.bmp',
  '.avif',
])

/** 小写扩展名(带点);`path` 里没有点则回空串。与 `Path.extname` 同口径。 */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** 这个路径是不是上游白名单里的图片。 */
export function isRenderableImagePath(path: string): boolean {
  return IMAGE_FILE_EXTENSIONS.has(extensionOf(path));
}

/**
 * 扩展名 → data URI 的 media type —— **与上游一致**上游
 * `references/desktop/app/src/lib/git/diff.ts:719-751`(含那个 `text/plain` 兜底)。
 *
 * 新路径下它只用于**兜底**的 `data:` URL;主路径的 media type 由服务端的
 * `Content-Type`(魔数 + 扩展名)给出 —— 那比扩展名更可信。
 */
export function getMediaType(extension: string): string {
  if (extension === '.png') {
    return 'image/png';
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpg';
  }
  if (extension === '.gif') {
    return 'image/gif';
  }
  if (extension === '.ico') {
    return 'image/x-icon';
  }
  if (extension === '.webp') {
    return 'image/webp';
  }
  if (extension === '.bmp') {
    return 'image/bmp';
  }
  if (extension === '.avif') {
    return 'image/avif';
  }
  if (extension === '.dds') {
    return 'image/vnd-ms.dds';
  }
  // fallback value as per the spec
  return 'text/plain';
}

/** 能交给 `ImageDiffPanel` 的两侧(至少一侧存在)。 */
export interface IImageView {
  readonly previous?: IBlobImage;
  readonly current?: IBlobImage;
}

/** 一次组装的结果:`view` 或**可展示的原因**。 */
export interface IImageViewLoad {
  readonly view: IImageView | null;
  /** 不能渲染时的原因(超限时带真实大小与上限,界面据此说「3.2 MB,上限 2 MB」)。 */
  readonly reason: string | null;
  readonly size: number | null;
  readonly limit: number | null;
}

/**
 * 一侧的读取结果。
 *
 * `none` 与 `unavailable` 的区别是这套逻辑的关键:
 *  - `none` = **这一侧确实不存在**(新增/删除/这个版本里没有这个路径);
 *    它和「另一侧存在」组合起来是**准确的**单侧视图,不是降级;
 *  - `unavailable` = 我们**问不出来**(路由不存在、网络失败、非 missing 的错误);
 *    这时绝不能假装另一侧不存在 —— 那会把一张改过的图标成「Added」。
 */
type SideRead =
  | { readonly kind: 'ok'; readonly image: IBlobImage }
  /** 该侧的修订/工作区里确实没有这个路径。 */
  | { readonly kind: 'none' }
  | { readonly kind: 'too-big'; readonly size: number | null; readonly limit: number | null }
  /** 拿不到内容(路由不存在 / 读失败)。 */
  | { readonly kind: 'unavailable' }
  /** 这台 host 是旧构建:既没有 blob 路由,也没有旧的 JSON 路由。 */
  | { readonly kind: 'stale-host' };

/** 字节数 → 人类可读(只用于提示文案,与镜像 `formatBytes` 同口径的近似)。 */
function humanBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 读某一侧的图片。
 *
 * 顺序是刻意的:**先问元数据**(HEAD,不取内容),再决定要不要让浏览器去取。
 *  - `blobHead` 说超限 ⇒ 这一侧就是 `too-big`(**一个字节都不取**);
 *  - 说没有 ⇒ `none`;
 *  - 说不能问(老 host / 网络)⇒ 退回 base64 兜底;
 *  - 说可以 ⇒ 交一个**指向端点的 URL**。
 *
 * @param repoPath - 仓库绝对路径。
 * @param rev - 修订;`undefined` = 工作区磁盘,`'index'` = 索引。
 * @param path - 仓库内相对路径(决定兜底 data URL 的 media type)。
 */
async function readSide(repoPath: string, rev: string | undefined, path: string): Promise<SideRead> {
  const fallbackType = getMediaType(extensionOf(path));
  const head = await api.blobHead(repoPath, rev, path);
  if (head.ok) {
    // 0 字节:没有内容可画(空文件当图片只会是一张裂图,而上游也会当作「没有这一侧」)。
    if (head.size === 0) {
      return { kind: 'none' };
    }
    return {
      kind: 'ok',
      image: {
        src: api.blobUrl(repoPath, rev, path),
        // 服务端的类型更可信(魔数 + 扩展名);它缺失时才用扩展名表。
        mediaType: head.contentType === '' ? fallbackType : head.contentType,
        bytes: head.size,
      },
    };
  }
  if (head.reason === 'missing') {
    return { kind: 'none' };
  }
  if (head.reason === 'too-big') {
    return { kind: 'too-big', size: head.size ?? null, limit: head.limit ?? null };
  }
  // 老 host(没有 blob 路由)或别的错误:走 base64 兜底(上限 256 KiB)。
  const legacy = rev === undefined
    ? await api.fileText(repoPath, path)
    : await api.showFile(repoPath, rev, path);
  if (!legacy.ok) {
    // 连旧路由都没有 = 这台 host 的构建比「有 blob 路由」那一版还老。
    // 这与「这一侧内容拿不到」是两件不同的事:前者**重启 DSH Desktop 就能解决**,
    // 提示必须说得出这句话,否则用户只会看到一句无动作可做的降级文案。
    return /未知路由/.test(legacy.error.message) ? { kind: 'stale-host' } : { kind: 'unavailable' };
  }
  const value = legacy.value;
  // **旧路由说「这个版本里没有这个文件」就是 `none`**,不是 `unavailable`。
  // 这一条曾经写错:blob 路由在老 host 上必然缺席,于是每一次「旧侧不存在」
  // 都被折成 `unavailable`,让一张**正常的未跟踪图片**显示成降级文案。
  if (value.kind === 'missing') {
    return { kind: 'none' };
  }
  // 判据是「宿主说这是二进制 + 文本字段非空」,而**不要求** `encoding === 'base64'`:
  // 那个字段在更老的 host 上不存在(见 `api.ts` 的 `fileText`/`showFile` 注释),
  // 而 `kind: 'binary'` 的契约就是「`text` 里装的是 base64」。多要求一个可选字段,
  // 结果是兜底在那些 host 上**静默失效**并退化成 `unavailable`。
  if (value.kind === 'binary' && value.text !== '') {
    return {
      kind: 'ok',
      image: { src: `data:${fallbackType};base64,${value.text}`, mediaType: fallbackType, bytes: value.size },
    };
  }
  if (value.kind === 'too-big') {
    return { kind: 'too-big', size: value.size, limit: null };
  }
  return { kind: 'unavailable' };
}

/** 把「哪一侧失败」折成一句可展示的原因。 */
function reasonOf(sides: readonly SideRead[]): string | null {
  for (const side of sides) {
    if (side.kind === 'too-big') {
      const size = side.size === null ? '文件' : humanBytes(side.size);
      const limit = side.limit === null ? '' : `,上限 ${humanBytes(side.limit)}`;
      return `${size}${limit} —— 这个版本太大,无法在 diff 里显示图片。`;
    }
  }
  for (const side of sides) {
    if (side.kind === 'stale-host') {
      return 'host 还是旧构建(既没有 /dsh-git/blob,也没有旧的 JSON 内容路由)—— 请重启 DSH Desktop。';
    }
  }
  for (const side of sides) {
    if (side.kind === 'unavailable') {
      return '拿不到图片内容,已退回二进制视图。';
    }
  }
  return null;
}

/**
 * 组装一次图片 diff(Changes 与 History 共用)。
 *
 * @param repoPath - 仓库绝对路径。
 * @param file - 已构造好的 `ChangedFile`(决定 `oldPath`)。
 * @param kind - 文件状态(与 `stageLines` 用同一套)。
 * @param commitish - 新侧修订;**`undefined` ⇒ 新侧读工作区磁盘**(Changes 侧)。
 * @param parentCommitish - 旧侧修订(第一父提交;根提交传空串)。
 * @returns `view` 或原因;两者互斥。
 */
export async function loadImageView(
  repoPath: string,
  file: ChangedFile,
  kind: FileStatusKind,
  commitish: string | undefined,
  parentCommitish: string,
): Promise<IImageViewLoad> {
  const readsCurrent = kind !== 'deleted';
  const readsPrevious = kind !== 'new' && kind !== 'untracked' && kind !== 'deleted'
    && parentCommitish !== '';
  const oldPath = getOldPathOrDefault(file);
  const [currentSide, previousSide] = await Promise.all([
    readsCurrent
      ? (commitish === undefined
        ? readSide(repoPath, undefined, file.path)
        : readSide(repoPath, commitish, file.path))
      : Promise.resolve<SideRead>({ kind: 'none' }),
    readsPrevious
      ? readSide(repoPath, parentCommitish, oldPath)
      : Promise.resolve<SideRead>({ kind: 'none' }),
  ]);
  // 删除的文件:旧侧用 `parentCommitish`(上游 `lib/git/diff.ts:680-686` 就是这么做的)。
  const deletedPrevious = kind === 'deleted' && parentCommitish !== ''
    ? await readSide(repoPath, parentCommitish, oldPath)
    : ({ kind: 'none' } as SideRead);

  const current = currentSide.kind === 'ok' ? currentSide.image : undefined;
  const previousSide2 = previousSide.kind === 'ok'
    ? previousSide
    : (deletedPrevious.kind === 'ok' ? deletedPrevious : previousSide);
  const previous = previousSide2.kind === 'ok' ? previousSide2.image : undefined;
  const sides = [currentSide, previousSide2, deletedPrevious];
  const view = pickImageView(current, previous, currentSide, previousSide2);
  if (view === null) {
    return { view: null, reason: reasonOf(sides), size: null, limit: null };
  }
  const tooBig = sides.find((side) => side.kind === 'too-big');
  return {
    view,
    reason: null,
    size: tooBig !== undefined && tooBig.kind === 'too-big' ? tooBig.size : null,
    limit: tooBig !== undefined && tooBig.kind === 'too-big' ? tooBig.limit : null,
  };
}

/**
 * 「哪几侧能画」的判定(**纯函数,便于逐条核对**)。
 *
 * 上游 `Diff.renderImage`(`ui/diff/index.tsx:160-181`)是拿**文件状态**判的:
 * `current && previous` → Modified;`current && (New|Untracked)` → New;
 * `previous && Deleted` → Deleted;其余 `null`。
 *
 * 这里改成拿**两侧实际存不存在**判,差别只有一处、而且是因为前者在本插件里会判错:
 * 状态来自客户端 store,而 store 对「未跟踪」的判据是 porcelain 的 `??` ——
 * 文件一旦被 `git add`(`A.`)就不再是 `??`,`kind` 变成 `new`,**这是对的**;
 * 但如果哪一层把这类文件报成 `modified`(或将来别的路径产生同样的组合),
 * 上游的规则会直接 `null` ⇒ 用户看到「二进制文件已改变」而那张图**明明是新的**。
 *
 * 判据换成「另一侧**确实不存在**(`none`)」之后:
 *  - 单侧视图**只**在另一侧真的没有时出现 ⇒ 「Added」/「Deleted」的标签永远是真的;
 *  - 另一侧是 `too-big` / `unavailable` / `stale-host` 时**仍然**返回 `null` +
 *    原因(`reasonOf`)⇒ 不会把一张改过的图标成「Added」。
 *
 * 父代理的实测也支持这条:上游三个分支**单侧是合法输入**(`NewImageDiff` 只收
 * `current`,`DeletedImageDiff` 只收 `previous`)。
 * @param current - 新侧(不存在时为 `undefined`)。
 * @param previous - 旧侧(不存在时为 `undefined`)。
 * @param currentSide - 新侧的原始读取结果(`none` = 确实不存在)。
 * @param previousSide - 旧侧的原始读取结果(**实际生效的那一份**,删除文件时是
 *   `parentCommitish` 的那次读取)。
 */
export function pickImageView(
  current: IBlobImage | undefined,
  previous: IBlobImage | undefined,
  currentSide: SideRead,
  previousSide: SideRead,
): IImageView | null {
  if (current !== undefined && previous !== undefined) {
    return { previous, current };
  }
  if (current !== undefined && previousSide.kind === 'none') {
    return { current };
  }
  if (previous !== undefined && currentSide.kind === 'none') {
    return { previous };
  }
  return null;
}
