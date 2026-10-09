/**
 * **dsh-git 手写替身(host 半)** —— 上游 `lib/app-shell.ts`(64 行)。
 *
 * ## 上游那份为什么不能沿用
 *
 * 它 `import { shell as electronShell } from 'electron'` 并且把
 * `showItemInFolder` / `showFolderContents` / `openExternal` / `moveItemToTrash`
 * 指向 `../ui/main-process-proxy`(全是 ipcRenderer)。两样宿主半都没有。
 *
 * ## 谁真的需要它
 *
 * 整片 host 镜像里对它只有 **2 个名字**(实测):
 *
 * | 名字 | 引用方 | 用途 |
 * |---|---|---|
 * | `IAppShell` | `lib/stores/git-store.ts:27`、`git-store-cache.ts:3` | **构造参数的类型** |
 * | `shell` | `lib/stores/sign-in-store.ts:20` | 值(上游用它打开浏览器做 OAuth) |
 *
 * ⚠️ `GitStore` **一次都没有用过它注入的 `shell`**
 * (`grep -n 'this\.shell' lib/stores/git-store.ts` = **0 处**)—— 它只在
 * `IErrorMetadata` 里往下传。所以宿主接线的这条链上,`shell` 是不是真的
 * **不影响任何行为**;但**必须**是「用了会响」的东西,否则将来有人接一个
 * 「打开外链」的按钮时会**静默无反应**。
 *
 * ## 本替身的选择:抛错,不是空实现
 *
 * 每一个方法都 `throw` 一句能指到病根的话。理由:宿主半**没有**这些能力,
 * 一个返回 `Promise.resolve()` 的空实现会把「没接」伪装成「做成」——
 * 那正是本仓反复付过学费的一类假绿。
 *
 * ## 退役条件
 *
 * 宿主提供「打开外链 / 在文件管理器里显示 / 移到废纸篓」中的**任意一项**时,
 * 把对应方法换成真实现(走 DSH 的宿主能力或 `child_process`),
 * 其余保持抛错。判据:一次真点击能把 `revealInFileManager` 的目标交给系统。
 *
 * @module dsh-git/host-mirror/lib/app-shell
 */

/**
 * 上游 `lib/app-shell.ts:11` 的 `IAppShell`,**逐字**保留(宿主半只把它当类型用)。
 */
export interface IAppShell {
  readonly moveItemToTrash: (path: string) => Promise<void>;
  readonly beep: () => void;
  readonly openExternal: (path: string) => Promise<boolean>;
  /**
   * Reveals the specified file using the operating
   * system default application.
   * Do not use this method with non-validated paths.
   *
   * @param path - The path of the file to open
   */
  readonly openPath: (path: string) => Promise<string>;
  /**
   * Reveals the specified file on the operating system
   * default file explorer. If a folder is passed, it will
   * open its parent folder and preselect the passed folder.
   *
   * @param path - The path of the file to show
   */
  readonly showItemInFolder: (path: string) => void;
  /**
   * Reveals the specified folder on the operating
   * system default file explorer.
   * Do not use this method with non-validated paths.
   *
   * @param path - The path of the folder to open
   */
  readonly showFolderContents: (path: string) => void;
}

/** 抛出的错统一措辞:`能力` 是哪一个方法,以及它是「宿主没有」而不是「调用错了」。 */
function unsupported(capability: string): Error {
  return new Error(
    `dsh-git host:不提供 ${capability}(上游走 Electron \`shell\` / ipcRenderer;` +
      '宿主半没有这两个面)。见 src/host/mirror/lib/app-shell.ts 的文件头。'
  );
}

/**
 * 上游 `lib/app-shell.ts:36` 的 `shell` 常量,宿主半是**会抛错的**替身(见文件头)。
 */
export const shell: IAppShell = {
  moveItemToTrash: () => Promise.reject(unsupported('moveItemToTrash')),
  beep: () => {
    process.stdout.write('\u0007');
  },
  openExternal: () => Promise.reject(unsupported('openExternal')),
  showItemInFolder: () => {
    throw unsupported('showItemInFolder');
  },
  showFolderContents: () => {
    throw unsupported('showFolderContents');
  },
  openPath: () => Promise.reject(unsupported('openPath')),
};
