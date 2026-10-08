/**
 * 把文件推到 **`ci-assets` 分支**,换回可以在 markdown 里直接嵌的 raw URL。
 *
 * ## 为什么要有它
 *
 * GitHub job summary 里的 `![](url)` 要求图片是**可公开访问的 URL** —— artifact 的下载
 * 链接做不到这件事(要登录、且不是图片内容类型)。所以截图先提交到一个专门的
 * `ci-assets` 分支,再用 `raw.githubusercontent.com/.../ci-assets/<dir>/<file>` 嵌进
 * summary,于是**跑完就能在 Actions 页面直接看到每一步的截图**(参考 viben 的
 * `scripts/lib/upload-ci-assets.sh`,同一套做法:Git Data API 的 blob → tree → commit → 更新 ref)。
 *
 * ## 为什么走 Git Data API 而不是 clone + push
 *
 * 这个函数跑在 E2E 脚本里,而 checkout 的工作区里可能有别的分支/未提交改动;
 * 用 API 只动远端那一个 ref,绝不碰本地工作树。
 *
 * `/repos/<repo>/git/...` 这组接口在本机 `api.github.com` 可达(网络受限时 git/curl
 * 走 SSH 也照样能用,两者互不影响)。
 *
 * @module dsh-git/scripts/lib/ci-assets
 */

import { readFile } from 'node:fs/promises';

const API = 'https://api.github.com';
/** 截图/产物落点分支名(与 viben 一致)。 */
export const CI_ASSETS_BRANCH = 'ci-assets';

/**
 * 调 GitHub API,失败时抛带响应体的错误(否则只看状态码根本不知道为什么失败)。
 * @param path - API 路径(以 `/repos/...` 开头)。
 * @param token - 具有 contents:write 的令牌。
 * @param init - fetch 选项。
 * @returns 解析后的 JSON。
 */
async function api(path, token, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status}: ${text.slice(0, 300)}`);
  }
  return text === '' ? {} : JSON.parse(text);
}

/**
 * 把若干文件推到 `ci-assets` 分支的 `dir` 目录下。
 *
 * 并发(多条 CI 同时推)时最后一步「更新 ref」可能撞车:GitHub 会返回非 2xx,
 * 这里重取 base 再试一次 —— 与 viben 的 `upload_to_ci_assets_with_retry` 同义。
 *
 * @param options - 见下。
 * @param options.repo - `owner/repo`。
 * @param options.token - contents:write 令牌。
 * @param options.dir - 分支内的目录,例如 `e2e/123456`。
 * @param options.files - 本地文件绝对路径列表。
 * @param options.attempts - 最多尝试次数(默认 3)。
 * @returns `[{ name, url }]`,url 为 raw.githubusercontent.com 上的直链。
 */
export async function uploadToCiAssets({ repo, token, dir, files, attempts = 3 }) {
  if (token === undefined || token === '') {
    throw new Error('没有 GITHUB_TOKEN:ci-assets 上传需要 contents:write');
  }
  if (files.length === 0) {
    return [];
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await pushOnce({ repo, token, dir, files });
    } catch (error) {
      lastError = error;
      console.warn(`[ci-assets] 第 ${attempt} 次失败:${String(error).split('\n')[0]}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}

/**
 * 一次完整的 blob → tree → commit → 更新 ref。
 * @param options - 同 {@link uploadToCiAssets}。
 * @returns 上传结果。
 */
async function pushOnce({ repo, token, dir, files }) {
  const ref = await api(`/repos/${repo}/git/ref/heads/${CI_ASSETS_BRANCH}`, token);
  const baseSha = ref.object?.sha;
  if (typeof baseSha !== 'string') {
    throw new Error(`拿不到 ${CI_ASSETS_BRANCH} 的 head(分支建了吗?)`);
  }
  const baseCommit = await api(`/repos/${repo}/git/commits/${baseSha}`, token);

  const tree = [];
  const uploaded = [];
  for (const file of files) {
    const bytes = await readFile(file);
    const name = file.split('/').pop();
    const blob = await api(`/repos/${repo}/git/blobs`, token, {
      method: 'POST',
      body: JSON.stringify({ content: bytes.toString('base64'), encoding: 'base64' }),
    });
    tree.push({ path: `${dir}/${name}`, mode: '100644', type: 'blob', sha: blob.sha });
    uploaded.push({
      name,
      url: `https://raw.githubusercontent.com/${repo}/${CI_ASSETS_BRANCH}/${dir}/${name}`,
    });
  }

  const created = await api(`/repos/${repo}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
  });
  const commit = await api(`/repos/${repo}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({
      message: `ci-assets: ${dir}(${uploaded.length} 个文件)`,
      tree: created.sha,
      parents: [baseSha],
    }),
  });
  await api(`/repos/${repo}/git/refs/heads/${CI_ASSETS_BRANCH}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return uploaded;
}
