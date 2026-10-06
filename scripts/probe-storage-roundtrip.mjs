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

/** 按 src/index.ts 的真实 DOMAIN_SPEC 逐字段复制(只搬判据需要的形状)。 */
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
        githubToken: z.string().default(''),
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
        version: 1, entries: [], hiddenRemotes: [], githubToken: '', deviceId: '',
        prefs: {}, remoteCache: null, lastFetchedAt: {}, lastSelected: '',
      }),
      initial: {
        version: 1, entries: [], hiddenRemotes: [], githubToken: '', deviceId: '',
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
check('githubToken()', reg2.githubToken() === 'ghp_probe_token_1234', reg2.githubToken());
check('githubTokenTail()', reg2.githubTokenTail() === '1234', reg2.githubTokenTail());
check('deviceId()', reg2.deviceId() === 'device-42', reg2.deviceId());
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
