/**
 * **dsh-git 手写替身(shim)** —— 上游 `lib/git/config.ts`(297 行)。
 *
 * ## 上游那份为什么不能直接沿用
 *
 * 上游**每一支都走 `dugite`**(`import { git } from './core'` ⇒
 * `lib/git/core.ts:1 import { exec, … } from 'dugite'`),并且直接
 * `import { isAbsolute, normalize } from 'path'`、`import { realpath } from 'fs/promises'`。
 * `lib/git/**` 正是宿主**已经取代**的那一层(目标文档 §2.4:56 条路由 +
 * `git-service.ts` + `git-argv.ts`),浏览器半也不能有 `dugite`/`fs`(§2.3)。
 * 所以按 §10.3 归入「**由 host 取代**」:不沿用实现,**保留上游导出名与签名**,
 * 把读写接到宿主已有的 `config-get` / `config-set` 路由上。
 *
 * ## 为什么这个 shim 现在必须存在(不是为 Preferences 一家)
 *
 * 两个**已在镜像里**的 Changes 面文件早就 import 它,而它一直不存在
 * (构建之所以没红,是因为 esbuild 只编译可达文件,而那两条路径当时没接线):
 *
 * | 调用点 | 上游位置 | 用途 |
 * |---|---|---|
 * | `ui/changes/commit-message-avatar.tsx:142-143` | `getConfigValue(repository, 'user.name'/'user.email', true)` | 本地作者身份 |
 * | `ui/changes/commit-message.tsx:797` | `setGlobalConfigValue('user.email', email)` | 记住提交邮箱 |
 *
 * ## host 契约(已存在,不是本轮新开路由)
 *
 * - `src/host/routes.ts:537` `config-get` → `{ key, scope }` ⇒ `{ value: string \| null }`
 * - `src/host/routes.ts:543` `config-set` → `{ key, value, scope }` ⇒ `{ ok: true }`
 * - `src/client/api.ts:197-198` 的 `api.configGet` / `api.configSet` 是它们的客户端包装
 *
 * ## 本 shim 刻意省略的名字
 *
 * `getGlobalBooleanConfigValue`、`getGlobalConfigPath`、`addGlobalConfigValue`、
 * `addSafeDirectory`、`addGlobalConfigValueIfMissing`、`removeConfigValue`、
 * `removeGlobalConfigValue` —— 上游这些各自有宿主侧语义(安全目录白名单、
 * 追加式写入、类型规范化),我们没有对应的路由,**不假装实现**。
 * 需要时按 §2.4 补路由(host 改动需重启应用)。
 * @module dsh-git/core/desktop/lib/git/config
 */

import type { Repository } from '../../models/repository'
/*
 * ⚠️ 相对路径是**四层** `../`,不是三层(2026-10 修)。
 *
 * 本文件在 `src/core/desktop/lib/git/`,想拿到的是 `src/client/api.ts`:
 *   `..` → `src/core/desktop/lib` → `../..` → `src/core/desktop`
 *   → `../../..` → `src/core` → `../../../..` → `src/`,再进 `client/api`。
 * 原先写的是三层 ⇒ 解析成 **`src/core/client/api`(这个目录不存在)**。
 * 它一直没炸,只是因为整个 `lib/git/config.ts` 从来**没被编译过**:
 * 唯一的 import 方 `ui/changes/commit-message-avatar.tsx` 当时不在渲染路径上,
 * 而 esbuild 只编译可达文件。2026-10 接线那张卡时它才第一次进闭包,
 * esbuild 报 `Could not resolve "../../../client/api"` —— 这就是那次修复的由来。
 * 本文件是 `scripts/verify-mirror.mjs:201` 已登记的**手写替身**(不要求与上游
 * 字节一致),所以可以改。
 */
import { api } from '../../../../client/api'

/**
 * 上游 `:14` —— 读**某个仓库**的配置值。
 *
 * 上游的 `onlyLocal` 决定加不加 `--local`(`repository.path` 存在时默认走仓库作用域)。
 * 宿主的 `config-get` 只接受 `scope: 'local' | 'global'`,所以这里:
 *  - `onlyLocal === true` ⇒ `local`(上游同义);
 *  - `onlyLocal === false` ⇒ `local`(上游在给了 path 时也是 local,只有 path 为 null
 *    才升到 global —— 而本函数的签名保证 path 一定在)。
 * @param repository - 目标仓库(取 `repository.path`)。
 * @param name - 配置键,如 `user.name`。
 * @param onlyLocal - 见上;上游默认 `false`。
 */
export async function getConfigValue(
  repository: Repository,
  name: string,
  onlyLocal: boolean = false
): Promise<string | null> {
  return getConfigValueInPath(name, repository.path, onlyLocal)
}

/**
 * 上游 `:23` —— 读**全局**配置值(`user.name` / `user.email` /
 * `init.defaultBranch`)。宿主的 `config-get` 在 `scope: 'global'` 下从任何
 * 已登记的仓库路径执行(`git config --global --get`),所以 `path` 只当工作目录用。
 * @param name - 配置键。
 * @param env - 上游用它覆盖 `HOME`;宿主侧由 `git-service` 决定 HOME,故忽略。
 */
export function getGlobalConfigValue(
  name: string,
  env?: { HOME: string }
): Promise<string | null> {
  void env
  return getConfigValueInPath(name, null, false)
}

/**
 * 上游 `:41` —— 读某个仓库里的**布尔**配置值。
 *
 * 上游把规范化交给 `git config --type=bool`。宿主路由**没有** `type` 参数,
 * 所以这里按 Git 自己的布尔口径在客户端规范化
 * (`git-config(1)` 的「Boolean」一节:`true`/`yes`/`on`/`1`/非零数为真,
 * `false`/`no`/`off`/`0`/空串为假)。
 * @param repository - 目标仓库。
 * @param name - 配置键。
 * @param onlyLocal - 是否只用仓库作用域。
 * @param env - 同 `getGlobalConfigValue`,忽略。
 */
export async function getBooleanConfigValue(
  repository: Repository,
  name: string,
  onlyLocal: boolean = false,
  env?: { HOME: string }
): Promise<boolean | null> {
  void env
  const value = await getConfigValueInPath(name, repository.path, onlyLocal)
  return value === null ? null : gitBoolean(value)
}

/**
 * 上游 `:64` —— 读全局的布尔配置值。
 * @param name - 配置键。
 * @param env - 忽略(见 `getGlobalConfigValue`)。
 */
export async function getGlobalBooleanConfigValue(
  name: string,
  env?: { HOME: string }
): Promise<boolean | null> {
  const value = await getGlobalConfigValue(name, env)
  return value === null ? null : gitBoolean(value)
}

/**
 * Git 的布尔口径(`git-config(1)`,「Boolean」一节)。
 * `key` 后面没有任何 `=value` 时 `git config --get` 返回空串 ⇒ 为真;
 * 这里的 `true` 分支正是那个语义。
 * @param value - `git config --get` 的原始文本。
 */
function gitBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (normalized === '' || normalized === 'true' || normalized === 'yes') {
    return true
  }
  if (normalized === 'on') {
    return true
  }
  const asNumber = Number.parseInt(normalized, 10)
  if (!Number.isNaN(asNumber)) {
    return asNumber !== 0
  }
  return false
}

/**
 * 上游 `:143` —— 写**某个仓库**的配置值。
 * @param repository - 目标仓库(取 `repository.path`)。
 * @param name - 配置键。
 * @param value - 值。
 */
export async function setConfigValue(
  repository: Repository,
  name: string,
  value: string
): Promise<void> {
  await setConfigValueInPath(name, value, repository.path)
}

/**
 * 上游 `:155` —— 写**全局**配置值。
 *
 * 宿主 `config-set` 在 `scope: 'global'` 下执行 `git config --global`。
 * `path` 只当工作目录;拿不到 cwd 时用 `'.'`(宿主会把它解析成当前工作区)。
 * @param name - 配置键。
 * @param value - 值。
 * @param env - 忽略(见 `getGlobalConfigValue`)。
 */
export async function setGlobalConfigValue(
  name: string,
  value: string,
  env?: { HOME: string }
): Promise<void> {
  void env
  await setConfigValueInPath(name, value, null)
}

/**
 * 上游 `:133` 的 `getConfigValueInPath`(未导出)的替身。
 *
 * `scope` 取值依据(不是猜的):宿主 `git-service.ts:709` 的 `config(path, key, scope)`
 * 在 `local` 下执行的是**不带 `--local`** 的 `git config --get`(即在那个工作目录里
 * 走完整配置链 system → global → local),`global` 才加 `--global`。
 * 于是:
 *  - 有 `path` ⇒ `local`(上游给了 path 也是这个位置;`onlyLocal` 只影响加不加
 *    `--local`,而两种情况下**读到的都是合并后的值**,所以这里不区分 —— 如实记录
 *    这处比上游**略宽**的语义,而不是假装精确);
 *  - `path === null` ⇒ `global`。
 * @param name - 配置键。
 * @param path - 仓库工作目录;`null` = 只用全局配置。
 * @param onlyLocal - 上游的 `--local` 开关(见上,本替身不区分)。
 */
async function getConfigValueInPath(
  name: string,
  path: string | null,
  onlyLocal: boolean
): Promise<string | null> {
  void onlyLocal
  const scope: 'local' | 'global' = path === null ? 'global' : 'local'
  const result = await api.configGet(path ?? '.', name, scope)
  if (!result.ok) {
    return null
  }
  return result.value.value
}

/**
 * 上游写路径(未导出的内部函数)的替身。
 * @param name - 配置键。
 * @param value - 值。
 * @param path - 仓库工作目录;`null` = 全局。
 */
async function setConfigValueInPath(
  name: string,
  value: string,
  path: string | null
): Promise<void> {
  const scope: 'local' | 'global' = path === null ? 'global' : 'local'
  await api.configSet(path ?? '.', name, value, scope)
}
