/**
 * 存储往返探针(验收用,不写仓库外的东西)。
 *
 * 回答三个问题,**用真实实现而不是读代码**:
 *  1. `RepoRegistry.persist()` 写失败时 `storageStatus()` 说什么?
 *  2. 写失败之后**再一次成功**的写入,能不能把状态清回「持久化」?
 *  3. 每一个持久化字段,经过**真实宿主后端**(dsh-storage-json 的 SingleJsonUnit)
 *     写盘 + 重新打开 + schema 解析之后,是否**逐字段**还在?
 *
 * 用真 `RepoRegistry`(src/host/repo-registry.ts,Node 25 原生剥类型)、
 * 真 `defineDomain`、真 `JsonStorageBackend`。写的是临时目录,不是 ~/.dsh。
 *
 * 用法:`node scripts/probe-storage-roundtrip.mjs`
 *
 * ## ⚠️ 已退役的判据(2026-10-07;依据 commit `7099eba`,不是「懒得维护」)
 *
 * 本探针原先有两条读回判据:`githubToken()`(明文令牌经真后端落盘、重开之后还在)
 * 与 `githubTokenTail()`(尾 4 位)。commit `7099eba`
 * (2026-10-06 20:48,「fix(token): 令牌只存宿主凭据缝,删掉迁移与明文兜底路径」)
 * **有意**删掉了「令牌进通用状态域」这条路径,原文:
 *
 * > - src/index.ts:zod schema 与 INITIAL_GLOBAL 去掉 `githubToken`(`z.object` 会 strip
 * >   未声明键 ⇒ 老文件里的键读进来即丢、此后也不会写回);去掉 legacy 接线。
 * > - repo-registry:删掉 `githubToken` 字段与 `legacyTokens()`;没有凭据服务时令牌只留在
 * >   内存副本里,并记一条不含值的诊断。
 *
 * 代码侧核对:`src/index.ts:161-200` 的 `DOMAIN_SPEC` 里已经没有 `githubToken`
 * (多了一个 `githubEndpoint`);`src/host/repo-registry.ts:348-362` 的 `githubToken()`
 * 只读凭据桥或 `memoryToken`,**不读** `state`;`setGithubToken`(`:403-415`)在
 * 没有凭据桥时只写 `memoryToken` + 持久化 `deviceId`。
 * ⇒ 那两条判据**按设计就该为假**,已从本文件**删除**(不是放宽、不是留成「已知的红」、
 * 更不是 `check(…, true)` 假绿)。
 *
 * | 删掉的判据 | 为什么它不再是判据 | 新家 |
 * |---|---|---|
 * | `githubToken()`(重开之后还读得到 `ghp_probe_token_1234`) | 令牌不再落通用状态域;`memoryToken` **本来就不跨重启**,所以「重启后读回」这件事在契约上已经不存在 | 本条下面新加的 `落盘 JSON 里没有明文令牌`;`docs/probes/credential-migration-probe.mjs`(读侧三条:+ `scripts/verify-install.mjs:158-170` 对**真 profile** 的同一条设计不变量) |
 * | `githubTokenTail()`(尾 4 位) | 同上;它只是上一条的派生读数 | 同上 |
 *
 * ⚠️ 顺带修了同一族的**夹具漂移**:本文件底下那份「按 `src/index.ts` 的真实 DOMAIN_SPEC
 * 逐字段复制」的 schema 里还留着 `githubToken`,而真的那份**已经换成** `githubEndpoint`
 * (`src/index.ts:181`)。夹具与真源不一致时,这个探针证明的是**它自己那份想象**。
 * 现在两份键集对齐。
 * @module dsh-git/scripts/probe-storage-roundtrip
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = new URL('..', import.meta.url);
const DSH = '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai';

const { RepoRegistry, DOMAIN_SPEC_HINT } = await import(new URL('src/host/repo-registry.ts', REPO));
// DOMAIN_SPEC 在 src/index.ts 里,但它 import cordis 的类型太多;这里按
// index.ts 的真实 spec **逐字段复制**并断言 descriptor 一致(见下面 checkSpec)。
const { defineDomain, descriptorOf } = await import(pathToFileURL(join(DSH, 'dsh-storage-domain/lib/index.js')).href);
const { JsonStorageBackend } = await import(pathToFileURL(join(DSH, 'dsh-storage-json/lib/index.js')).href);
const { z } = await import('zod');

const failures = [];
/** 断言并记账。 */
function check(label, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
}

// ---------- 1. 用真 RepoRegistry + 故障 domain 验 storageStatus ----------

/** 可编程的假 domain:`set` 的行为由 mode 决定。 */
function fakeDomain(mode) {
  return {
    global: {
      get: () => undefined,
      set: async () => {
        if (mode.failSet) throw new Error('EACCES: permission denied, open ~/.dsh/storages/dsh_git.json');
      },
    },
  };
}

console.log('1) storageStatus 的三种状态(真 RepoRegistry)');
{
  const reg = new RepoRegistry(fakeDomain({ failSet: false }));
  await reg.whenReady();
  const opened = reg.storageStatus();
  check('打开成功且未写失败 → 持久化', opened.persistent === true && opened.error === null, JSON.stringify(opened));

  await reg.setPrefs({ model: 'p/a' });
  const afterOkWrite = reg.storageStatus();
  check('一次成功写入后仍是持久化', afterOkWrite.persistent === true, JSON.stringify(afterOkWrite));
}
{
  const reg = new RepoRegistry(fakeDomain({ failSet: true }));
  await reg.whenReady();
  await reg.setPrefs({ model: 'p/a' });
  const failed = reg.storageStatus();
  check('写失败 → 报「仅内存」且带原因', failed.persistent === false && /写入失败/.test(failed.error ?? ''), JSON.stringify(failed));
}
{
  // 关键回归:一次瞬时失败**不能**把状态永久钉死。
  const mode = { failSet: true };
  const reg = new RepoRegistry(fakeDomain(mode));
  await reg.whenReady();
  await reg.setPrefs({ model: 'p/a' });
  const during = reg.storageStatus();
  mode.failSet = false;
  await reg.setPrefs({ model: 'p/b' });
  const after = reg.storageStatus();
  check('瞬时失败后一次成功写入 → 清回持久化', during.persistent === false && after.persistent === true, `${JSON.stringify(during)} → ${JSON.stringify(after)}`);
}

// ---------- 2. 真后端:DOMAIN_SPEC 的 schema + 真 SingleJsonUnit ----------

/**
 * 按 src/index.ts 的真实 DOMAIN_SPEC 逐字段复制(只搬判据需要的形状)。
 *
 * ⚠️ 2026-10-07:原先这里还留着 `githubToken`,而真源已经把它换成 `githubEndpoint`
 * (`src/index.ts:181`)—— 夹具漂移,已对齐。见文件头「已退役的判据」。
 */
function specLikeIndexTs() {
  return defineDomain({
    name: 'dsh_git',
    version: 1,
    tables: {},
    global: {
      schema: z.object({
        version: z.literal(1).default(1),
        entries: z.array(z.object({
          path: z.string().min(1),
          name: z.string().min(1),
          alias: z.string().optional(),
          remote: z.string().nullable(),
          addedAt: z.number(),
          missing: z.boolean().optional(),
          branch: z.string().optional(),
        })).default([]),
        hiddenRemotes: z.array(z.string()).default([]),
        githubEndpoint: z.string().default(''),
        deviceId: z.string().default(''),
        prefs: z.object({
          model: z.string().optional(),
          stagedOnly: z.boolean().optional(),
          systemPrompt: z.string().optional(),
        }).default({}),
        remoteCache: z.object({
          fetchedAt: z.number(),
          repos: z.array(z.object({
            fullName: z.string(),
            isPrivate: z.boolean(),
            pushedAt: z.string(),
            description: z.string().optional(),
          })),
        }).nullable().default(null),
        lastFetchedAt: z.record(z.string(), z.string()).default({}),
        lastSelected: z.string().default(''),
      }).default({
        version: 1, entries: [], hiddenRemotes: [], githubEndpoint: '', deviceId: '',
        prefs: {}, remoteCache: null, lastFetchedAt: {}, lastSelected: '',
      }),
      initial: {
        version: 1, entries: [], hiddenRemotes: [], githubEndpoint: '', deviceId: '',
        prefs: {}, remoteCache: null, lastFetchedAt: {}, lastSelected: '',
      },
    },
  });
}

const root = await mkdtemp(join(tmpdir(), 'dsh-git-probe-'));
const spec = specLikeIndexTs();
const descriptor = descriptorOf(spec);
console.log('\n2) 真后端往返(临时目录 ' + root + ')');
check('descriptor 与 verify-install 的期望一致', descriptor.name === 'dsh_git' && descriptor.version === 1 && descriptor.hasGlobal === true, JSON.stringify({ name: descriptor.name, version: descriptor.version, hasGlobal: descriptor.hasGlobal }));

/** 把一个 SingleJsonUnit 包成 RepoRegistry 需要的最小 domain(读已过 schema)。 */
function domainFromUnit(unit, schema) {
  return {
    global: {
      get: () => {
        const raw = unit.state.global;
        if (raw === undefined || raw === null) return undefined;
        return schema.parse(raw);
      },
      set: (value) => unit.setGlobal(schema.parse(value)),
    },
  };
}

const backend = new JsonStorageBackend(root);
const unit = await backend.kv.open(descriptor);
const snapshot = await unit.loadAll();
check('首次打开 global 是 null(从未写入的哨兵)', snapshot.global === null, JSON.stringify(snapshot.global));

{
  const reg = new RepoRegistry(domainFromUnit(unit, spec.global.schema));
  await reg.whenReady();
  await reg.add({
    path: '/tmp/probe-repo', name: 'probe-repo', remote: 'owner/probe',
    addedAt: 1791221862203, branch: 'main', missing: false,
  });
  await reg.rename('/tmp/probe-repo', '别名');
  await reg.setLastSelected('/tmp/probe-repo');
  await reg.setGithubToken('ghp_probe_token_1234', 'device-42');
  await reg.setPrefs({ model: 'prov/model-a', stagedOnly: false, systemPrompt: 'SYS' });
  await reg.setRemoteRepos([{ fullName: 'owner/probe', isPrivate: true, pushedAt: '2026-10-05T00:00:00Z', description: 'd' }]);
  await reg.markFetched('/tmp/probe-repo');
  await reg.hideRemote('someone/hidden');
  await reg.touch('/tmp/probe-repo', { branch: 'dev' });
  await reg.refreshMissing();
  check('全部写入后 storageStatus 仍是持久化', reg.storageStatus().persistent === true, JSON.stringify(reg.storageStatus()));
}

// 落盘内容(第一次落盘发生在上面的 setGlobal 里)
const fileText = await readFile(join(root, 'dsh_git.json'), 'utf8');
const onDisk = JSON.parse(fileText);
console.log('\n3) 磁盘上的实际内容(顶层键)');
console.log('  ' + Object.keys(onDisk.global).sort().join(', '));

// ---------- 3. 模拟「app 重启」:关掉单元,重开,读回,逐字段比对 ----------

await unit.close();
await backend.close();

const backend2 = new JsonStorageBackend(root);
const unit2 = await backend2.kv.open(descriptor);
const snap2 = await unit2.loadAll();
const parsed2 = spec.global.schema.parse(snap2.global);
const reg2 = new RepoRegistry(domainFromUnit(unit2, spec.global.schema));
await reg2.whenReady();

console.log('\n4) 重启后逐字段读回(真 RepoRegistry 的读取路径)');
const e = reg2.find('/tmp/probe-repo');
check('entries[].path', e?.path === '/tmp/probe-repo', String(e?.path));
check('entries[].alias', e?.alias === '别名', String(e?.alias));
check('entries[].name', e?.name === '别名', String(e?.name));
check('entries[].remote', e?.remote === 'owner/probe', String(e?.remote));
check('entries[].branch(touch 后)', e?.branch === 'dev', String(e?.branch));
check('entries[].missing(refreshMissing 后,/tmp/probe-repo 不存在)', e?.missing === true, String(e?.missing));
check('lastSelected()', reg2.lastSelected() === '/tmp/probe-repo', reg2.lastSelected());
/*
 * ⚠️ **已退役**:原先这里是 `check('githubToken()', reg2.githubToken() === 'ghp_probe_token_1234')`
 * 与 `check('githubTokenTail()', reg2.githubTokenTail() === '1234')` —— 它们断言
 * 「明文令牌经真后端落盘、重开之后还读得到」。那是 commit `7099eba` **有意**删掉的
 * 行为(令牌只存宿主凭据缝,不在通用状态域)。两条判据**删除**,理由与替代覆盖写在
 * 文件头的「已退役的判据」一节;**没有**改成 `check(…, true)`。
 *
 * 替代判据在下面那一条:同一份落盘文本里**没有**令牌明文,也没有 `githubToken` 键。
 * 它是**非空过**的 —— 文件确实写出来了(`deviceId` 就在同一份文档里),分母不是 0。
 */
check('落盘 JSON 里没有明文令牌(7099eba 之后的设计不变量)',
  !fileText.includes('ghp_probe_token_1234') && !Object.hasOwn(onDisk.global, 'githubToken'),
  `githubToken 键 ${Object.hasOwn(onDisk.global, 'githubToken') ? '在' : '不在'};`
  + ` 明文出现 ${fileText.includes('ghp_probe_token_1234') ? '是' : '否'}`);
check('deviceId()', reg2.deviceId() === 'device-42', reg2.deviceId());
/* 让报告里看得见退役这件事(惯例如 `docs/probes/toast-commit-button-probe.mjs` 文件头)。 */
console.log('  [已退役] githubToken() / githubTokenTail():明文令牌不再落通用状态域'
  + '(依据 7099eba);替代 = 上面那条「落盘 JSON 里没有明文令牌」');
check('prefModel()', reg2.prefModel() === 'prov/model-a', reg2.prefModel());
check('prefStagedOnly()', reg2.prefStagedOnly() === false, String(reg2.prefStagedOnly()));
check('prefSystemPrompt()', reg2.prefSystemPrompt() === 'SYS', reg2.prefSystemPrompt());
check('hidden()', JSON.stringify(reg2.hidden()) === JSON.stringify(['someone/hidden']), JSON.stringify(reg2.hidden()));
check('lastFetched()', typeof reg2.lastFetched('/tmp/probe-repo') === 'string', String(reg2.lastFetched('/tmp/probe-repo')));
check('cachedRemoteRepos()', (reg2.cachedRemoteRepos(Number.MAX_SAFE_INTEGER) ?? []).length === 1, JSON.stringify(reg2.cachedRemoteRepos(Number.MAX_SAFE_INTEGER)));

// ---------- 4. zod strip 自证:没在 schema 里声明的字段会被悄悄丢掉 ----------

console.log('\n5) zod strip 自证(schema 漏字段 = 静默丢数据)');
{
  const raw = { ...parsed2, lastSelected: '/tmp/x', extraNotInSchema: 'BOOM' };
  const out = spec.global.schema.parse(raw);
  check('未声明字段被 strip(所以接口/schema 必须同步)', out.extraNotInSchema === undefined, JSON.stringify(out.extraNotInSchema));
  check('已声明字段保留', out.lastSelected === '/tmp/x', String(out.lastSelected));
}

await unit2.close();
await backend2.close();
await rm(root, { recursive: true, force: true });

console.log('');
if (failures.length === 0) {
  console.log('存储探针:全部通过。');
  process.exit(0);
}
console.log(`存储探针:${failures.length} 项失败:`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
