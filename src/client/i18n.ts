/**
 * 本插件的语言注册表 —— 与 `references/dsh-context/src/client/i18n.ts` 同形。
 *
 * 键集真源在 `./i18nZh.ts`(`DictKey` 从它推导),英文在 `./i18nEn.ts`
 * (`satisfies Record<DictKey, string>`,少一条就编译不过)。
 * 缺键时落回宿主自己的语言链(当前语言 → en → common → 键名本身)。
 *
 * @module dsh-git/client/i18n
 */

/**
 * 本插件的**文案命名空间**(`ctx.locale.register` / `bind` 的那个 `ns`)。
 *
 * ⚠️ 它与 `settings-controller.ts` 的 `DSH_GIT_NS` **取值相同、含义不同**:那一个是宿主
 * Loader 条目的 `options.id`(设置文档的命名空间 / `cordis.patch.yml` 的行 id),
 * 这一个是语言服务的命名空间。两者恰好都叫 `dsh-git`,但分别注册在**两个不同的服务**里。
 */
export const LOCALE_NS = 'dsh-git';

/**
 * 翻译函数。
 *
 * 键类型是**裸 `string`** 而不是 `DictKey` 联合:调用点会在运行期拼键
 * (例如按行 id 拼 `settings.<row>`),把它们逐个收窄只会在每个调用点换来一次断言。
 * 键集仍然被钉住 —— 钉在**字典**那一侧(`i18nEn.ts` 的 `satisfies`)。
 */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

export { DICT_ZH, type DictKey } from './i18nZh';
export { DICT_EN } from './i18nEn';
