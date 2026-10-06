/**
 * 安装态自检:一条命令回答「插件装好了吗、跑起来了吗、跑的是不是当前构建」。
 *
 * 为什么要它:host 半**不能热重载**(loader 用不带 cache-busting 的 `import(url)`,
 * 重新加载拿到的是同一份缓存模块),所以「构建成功」和「应用里生效」是两件事。
 * 我此前每轮都手工 grep 日志、比对构建戳,脚本化之后一次说清。
 *
 * 检查六项:
 *  1. profile 里有没有指向本仓库的符号链接(装了没);
 *  2. `~/.dsh/storages/<domain>.json` 是否存在且内容结构正确(存储通没通);
 *  2b. 通用状态域里**没有**明文的 GitHub 令牌(令牌搬没搬走);
 *  2c. 宿主的凭据域(`~/.dsh/.credentials.yaml`)里**取得到** `GITHUB_TOKEN`,
 *      且文件是 owner-only(令牌搬过去没有、保不保得住);
 *  3. 当前构建戳(读 lib/client.js 里的 __BUILD_STAMP__);
 *  4. host 日志里最后一次 `已注册` 的构建戳 —— **与当前不一致就说明需要重启**。
 *
 * ⚠️ 本脚本**只读**,而且**永远不打印令牌值** —— 只报「在不在」与长度。
 *
 * 用法:`node scripts/verify-install.mjs`(不写任何东西,只读)
 * @module dsh-git/scripts/verify-install
 */

import { readFile, readdir, stat, readlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const PROFILE = join(homedir(), '.dsh', 'profiles', 'desktop');
const DOMAIN_FILE = join(homedir(), '.dsh', 'storages', 'dsh_git.json');
/** 宿主凭据域:`@deepseek-ai/dsh-credentials-local` 的默认文件(0600)。 */
const CREDENTIALS_FILE = join(homedir(), '.dsh', '.credentials.yaml');
const LOG_DIR = join(homedir(), 'Library', 'Application Support', 'DSH Desktop', 'logs', 'host');

/** 打印一行检查结果。 */
function line(ok, label, detail) {
  console.log(`  ${ok === true ? '✓' : ok === false ? '✗' : '·'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

/**
 * 读某个产物里的构建戳。
 *
 * ⚠️ **必须读对产物**:host 日志里的「已注册 (build …)」是 `lib/index.js`(host 半)
 * 里那个 `__BUILD_STAMP__`,而 `lib/client.js`(浏览器半)有**自己的**同名戳。
 * 两者只在**同一次构建**里相等 —— 分开构建过就会永久错开,于是拿 client 的戳去比
 * host 的日志会**永远报错**(实测:2026-10-06 那次「重启后仍然报需要重启」就是这么来的)。
 * @param {string} bundle - `lib/` 下的文件名(`index.js` = host,`client.js` = 浏览器)。
 */
async function stampOf(bundle) {
  try {
    const text = await readFile(join(REPO, 'lib', bundle), 'utf8');
    // esbuild 的 `define` 直接把 __BUILD_STAMP__ 换成字面量,所以产物里
    // **没有变量名**,只有形如 "2026-10-05 18:24:51" 的字符串。按字面量找。
    const all = [...text.matchAll(/["'](\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})["']/g)].map((m) => m[1]);
    return all.length === 0 ? null : all[all.length - 1];
  } catch {
    return null;
  }
}

/** 当前 **host** 构建戳(`lib/index.js`)—— 与日志里的「已注册」行同源。 */
async function currentStamp() {
  return stampOf('index.js');
}

/** 读 host 日志里最后一次 `已注册` 的构建戳与状态片段。 */
async function lastRegistration() {
  let files;
  try {
    files = (await readdir(LOG_DIR)).filter((n) => n.endsWith('.log')).sort().reverse();
  } catch {
    return null;
  }
  for (const name of files) {
    let text;
    try {
      text = await readFile(join(LOG_DIR, name), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n').filter((l) => l.includes('[dsh-git]') && l.includes('已注册'));
    if (lines.length > 0) {
      const last = lines[lines.length - 1];
      const stamp = /build ([\d-]+ [\d:]+) UTC/.exec(last);
      const at = /^([\d-]+ [\d:]+)/.exec(last);
      return { stamp: stamp === null ? null : stamp[1], at: at === null ? null : at[1], raw: last.trim(), file: name };
    }
  }
  return null;
}

/**
 * 读最新一份 host 日志,**从后往前**找令牌来源的证据。
 *
 * 为什么不能只看「已注册」那一行:那一行先于 `startTokenHome()` 完成,那时还没有
 * 值可报。真正的结算行是 `[dsh-git] GitHub 令牌来源 <层>(引用 GITHUB_TOKEN)`,
 * 由 `startTokenHome()` 在 `bootstrap()` **之后**记出。
 * @returns 来源层与它所在的那一行;日志里没有就把 `source` 留空。
 */
async function tokenSourceEvidence() {
  let files;
  try {
    files = (await readdir(LOG_DIR)).filter((n) => n.endsWith('.log')).sort().reverse();
  } catch {
    return { source: null, raw: null };
  }
  for (const name of files) {
    let text;
    try {
      text = await readFile(join(LOG_DIR, name), 'utf8');
    } catch {
      continue;
    }
    const rows = text.split('\n').filter((l) => l.includes('[dsh-git]'));
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const settled = /GitHub 令牌来源 (\S+?)\(引用 GITHUB_TOKEN\)/.exec(rows[i]);
      if (settled !== null) {
        return { source: settled[1], raw: rows[i].trim() };
      }
      if (rows[i].includes('还没接上 credentials 服务')) {
        return { source: 'memory', raw: rows[i].trim() };
      }
    }
  }
  return { source: null, raw: null };
}

console.log(`dsh-git 安装态自检(${REPO})`);
console.log('');

// 1) profile 链接
let linked = false;
try {
  const link = join(PROFILE, 'node_modules', 'dsh-git');
  const target = await readlink(link);
  linked = resolve(PROFILE, 'node_modules', target) === REPO;
  line(linked, 'profile 符号链接', linked ? `→ ${REPO}` : `指向别处: ${target}`);
  if (!existsSync(join(REPO, 'lib', 'index.js'))) {
    line(false, '构建产物', 'lib/index.js 不存在 —— 先跑 npm run build');
  }
} catch (error) {
  line(false, 'profile 符号链接', error instanceof Error ? error.message : String(error));
}

// 2) 存储文件
try {
  const raw = await readFile(DOMAIN_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  const ok = parsed?.unit?.name === 'dsh_git' && Array.isArray(parsed?.global?.entries);
  const n = Array.isArray(parsed?.global?.entries) ? parsed.global.entries.length : 0;
  line(ok, '存储文件', ok
    ? `${DOMAIN_FILE}(${n} 个仓库,lastSelected=${parsed.global.lastSelected ? '有' : '无'})`
    : '结构不对: unit.name 不是 dsh_git 或 entries 不是数组');
} catch {
  line(null, '存储文件', '不存在 —— 首次成功运行后才会创建(重启后应出现)');
}

// 2b) 通用状态域里不该有明文令牌。这是本插件的**设计不变量**(令牌只在宿主凭据缝,
//     或退一步只在进程内存里),不是一次性动作的结果:任何非空值都说明有东西把明文
//     写进了那份 90 KB 的通用 JSON。
try {
  const raw = await readFile(DOMAIN_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  const stray = parsed?.global?.githubToken;
  const stillPlaintext = typeof stray === 'string' && stray !== '';
  line(!stillPlaintext, '存储里没有明文令牌', stillPlaintext
    ? 'global.githubToken 仍有非空值 → **一份明文令牌躺在通用状态域里**'
    : 'global.githubToken 不存在或为空');
} catch {
  line(null, '存储里没有明文令牌', '存储文件读不到,无法判断');
}

// 2c) 令牌在宿主的凭据域里取得到,且文件是 owner-only。
//     ⚠️ 只报「在不在」与长度;**永远不打印值**。
try {
  const text = await readFile(CREDENTIALS_FILE, 'utf8');
  const attr = await stat(CREDENTIALS_FILE);
  const ownerOnly = (attr.mode & 0o077) === 0;
  let stored = '';
  for (const row of text.split('\n')) {
    const hit = /^\s*GITHUB_TOKEN:\s*(\S.*)$/.exec(row);
    if (hit !== null) {
      stored = hit[1].trim();
      break;
    }
  }
  line(stored !== '', '宿主凭据域里的 GITHUB_TOKEN', stored === ''
    ? `没有这一项(${CREDENTIALS_FILE})—— 应用还没重启,或迁移没跑完`
    : `已存,长度 ${stored.length}(值不打印)`);
  line(ownerOnly, '凭据文件权限', ownerOnly
    ? 'owner-only —— 宿主自己保证(0600,group/other 位为 0)'
    : `mode ${(attr.mode & 0o777).toString(8)} 有 group/other 位:宿主会**拒绝加载**它`);
} catch {
  line(null, '宿主凭据域里的 GITHUB_TOKEN', `${CREDENTIALS_FILE} 不存在或读不到`);
}

// 3) 当前构建戳 —— **host**(`lib/index.js`)为主,浏览器半单独报一行
const stamp = await currentStamp();
line(stamp !== null, '当前 host 构建戳', stamp === null
  ? '读不到(lib/index.js 里没有 __BUILD_STAMP__)'
  : `${stamp}(与「已注册」行同源)`);
const clientStamp = await stampOf('client.js');
line(clientStamp !== null, '当前浏览器构建戳', clientStamp === null
  ? '读不到(lib/client.js 里没有 __BUILD_STAMP__)'
  : `${clientStamp}${clientStamp === stamp ? '' : '(浏览器半可刷新即生效,host 半必须重启)'}`);

// 4) 运行中的 host 是什么构建
const reg = await lastRegistration();
console.log('');
if (reg === null) {
  line(null, 'host 运行记录', `日志里没有 dsh-git 的「已注册」行(${LOG_DIR})`);
} else {
  const same = stamp !== null && reg.stamp === stamp;
  line(same, '运行中的 host 构建', same
    ? `${reg.stamp} —— 与当前构建一致`
    : `日志里是 ${reg.stamp},当前是 ${stamp ?? '?'} → **需要重启 DSH Desktop**`);
  const storage = /存储 (持久化|仅内存[^)]*)/.exec(reg.raw);
  if (storage !== null) line(storage[1] === '持久化', '上次运行时的存储状态', storage[1]);
  if (/自检问题/.test(reg.raw)) line(false, '启动自检', '日志里有「自检问题」');
}

// 5) 令牌来源层(`credentials-file` / `env` / `dotenv` / `memory` / `none`)。
//    `plugin-storage` 是**不可能再出现的值**:当前代码没有任何路径把令牌写进
//    插件的通用状态域,所以读到它就是「运行中的 host 是旧构建」。
{
  const evidence = await tokenSourceEvidence();
  if (evidence.source === null) {
    line(null, '上次运行时的令牌来源', '日志里没有这一行 —— 运行中的 host 是**旧构建**,重启后才会出现');
  } else {
    line(evidence.source !== 'plugin-storage', '上次运行时的令牌来源',
      `${evidence.source}${evidence.source === 'plugin-storage' ? '(旧构建:仍在插件 storage 的明文位置)' : ''}`);
  }
}

console.log('');
console.log('说明:host 半不热重载 —— 只要「运行中的 host 构建」不是当前构建,');
console.log('      就说明改动的代码还没在应用里生效,必须重启 DSH Desktop。');
