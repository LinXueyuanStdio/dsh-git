/**
 * **dsh-git 手写替身(host 半)** —— 上游 `lib/resolve-git-proxy.ts`(43 行)。
 *
 * ## 上游那份为什么不能沿用
 *
 * 上游是 `resolveProxy(url)`(`../ui/main-process-proxy`,即 **Electron 主进程 IPC**)
 * 拿到 PAC 字符串,再用 `./parse-pac-string` 折成一串代理。宿主半**没有 Electron
 * 主进程**,而 `ui/main-process-proxy.ts` 整个文件都是 ipcRenderer —— 抄进来只会
 * 得到一份两个半都跑不了的文件。
 *
 * ## 宿主半今天是怎么走代理的(这不是「少了功能」)
 *
 * git 自己就读 `http_proxy` / `https_proxy` / `all_proxy`(大小写都认)。
 * 上游那份 `lib/git/environment.ts` 的 `envForProxy`(本镜像**逐字**保留)已经把
 * 「用户已经在环境里配了代理 ⇒ 我们绝不覆盖」这条规则写死了,并且
 * `ALL_PROXY` 存在时直接返回 —— 也就是说,**只剩「环境里没有代理、需要去问
 * 操作系统(PAC)」这一档**落到本文件。
 *
 * 我们在这一档上返回 `undefined`:**「没有解析到代理」,不是「直连」**。
 * 后果与今天的宿主实现**逐字相同** —— `src/host/git-service.ts` 与
 * `git-runner.ts` 今天**没有**任何代理解析(全仓 `grep resolveGitProxy` = 0 处),
 * 所以这不是新增的行为缺失,而是「上游有、我们从来没有过」的一条。
 *
 * ## 退役条件
 *
 * 宿主提供「按 url 解析系统代理」的能力时(读环境 → 系统代理设置 → PAC),
 * 把本文件换回上游原文。判据:一个真仓库 + 一个 `http_proxy` 指向本地假代理的
 * 场景,能观察到 `git fetch` 真的走了那个代理。
 *
 * @module dsh-git/host-mirror/lib/resolve-git-proxy
 */

/**
 * 解析某个 url 该用的代理。
 *
 * 宿主半**不做 PAC 解析**,恒返回 `undefined`(「没有解析到」)。
 * 环境变量那一档由上游 `lib/git/environment.ts` 的 `envForProxy` 负责,
 * 它在调用本函数**之前**就已经退出了。
 *
 * @param _url - 待解析的远端 url(上游签名的一部分,宿主半不使用)。
 * @returns 恒为 `undefined`。
 */
export async function resolveGitProxy(
  _url: string
): Promise<string | undefined> {
  return undefined;
}
