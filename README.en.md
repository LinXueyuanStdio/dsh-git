# @linxueyuan/dsh-git

[简体中文](./README.md) | **English**

[![CI](https://github.com/LinXueyuanStdio/dsh-git/actions/workflows/ci.yml/badge.svg)](https://github.com/LinXueyuanStdio/dsh-git/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@linxueyuan%2Fdsh-git?label=npm&color=4d6bfe)](https://www.npmjs.com/package/@linxueyuan/dsh-git)
[![License: MIT](https://img.shields.io/badge/license-MIT-4d6bfe.svg)](./LICENSE)

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%"
       alt="dsh-git: a local Git workbench plus GitHub remote tabs, living in the official DeepSeek Harness sidebar">
</p>

**Local Git, inside the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sidebar**: a multi-repo picker, local Changes / History work, Code / Issues / Pull requests / Actions tabs for the remote, and commit messages written by any model already configured in your DSH model list.

<p align="center">
  <img src="./assets/readme/Changes.png" width="49%"
       alt="Changes tab (real screenshot): repo picker showing dsh-git on branch main, a 'Push to origin' ahead-count toolbar, six tabs, 17 changed files with checkboxes, a line-by-line diff of README.md, and the commit area at the bottom (summary/description, ✨ generate, commit button)">
  <img src="./assets/readme/History.png" width="49%"
       alt="History tab (real screenshot): commit list on the left; top right shows the selected commit's message, short sha and +/− stats; below it the files that commit touched with their line-by-line diff">
</p>

## What you get

<p align="center">
  <img src="./assets/readme/section-tabs.svg" width="100%"
       alt="Six tabs: Changes does file-level staging plus diffs and model-written commit messages; History shows the commit log; Code shows the remote file tree and falls back to the local working tree when there is no remote; Issues lists and opens issues, with create, comment and close; Pull requests lists and opens PRs, with create; Actions lists workflow runs, with re-run and cancel">
</p>

These are shared by every tab:

- **Multi-repo picker** — the local repositories you explicitly added; once you sign in to GitHub it can also list remote repositories you have access to.
- **Sync and branches** — fetch / pull / push. A force push is only ever `--force-with-lease` (there is no bare `--force` anywhere). Switch, create and rename branches; check out a commit (detached HEAD) or cherry-pick it.
- **Usable without a remote** — on a local-only repository the Code tab degrades to a local working-tree view rather than an empty page; Issues / PR / Actions need a remote and say so in plain language instead of erroring.
- **Commit messages come from the model** — the host half reads the diff and goes through `ctx.llm`, so it uses whichever provider you already configured in DSH.
- **Findable in settings** — sidebar Plugins page ▸ Installed ▸ `@linxueyuan/dsh-git` ▸ the configuration section on its detail page: interface scale, diff check marks, notifications and a few confirmation prompts, plus the plugin's own config document (Pulls auto-refresh interval). The ported GitHub Desktop preference pages stay behind the gear in the right sidebar.

## How it works

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%"
       alt="One package, two halves: the browser half registers the official sidebar tab and only ever shows the last 4 digits of the token, reaching the host half over loopback-only /dsh-git/* routes; the host half runs git via ctx.subprocess, registers routes via ctx.webServer, stores the token via ctx.credentials and generates commit messages via ctx.llm, then connects to the local git repositories and the GitHub REST API">
</p>

One npm package contains two halves. The **browser half** only draws UI (it registers the official sidebar tab; local actions go over `/dsh-git/*`). The **host half** runs in the same process as dsh: it runs git, registers routes, holds the token, and calls the model. Remote tabs never talk to GitHub directly — the host half proxies them, so the token never enters the browser.

- `/dsh-git/*` accepts **loopback** requests only; LAN and remote access get a 403.
- git can only touch paths from the list of repositories **you explicitly added** (anything else returns `workspace-unknown`).
- `clone` disables `protocol.ext.*`.
- The token lives in the host only, with a single read / write / log site: `src/host/credential-bridge.ts`.

## Install

```bash
# from npm (the npm package name is scoped: @linxueyuan/dsh-git)
dsh plugin --profile <profile> add @linxueyuan/dsh-git

# from a local directory (development)
dsh plugin --profile <profile> add /path/to/dsh-git
```

Note it is `@linxueyuan/dsh-git`, not the unscoped `dsh-git` — the latter was taken by someone else (a 0.0.1 placeholder package whose repository link 404s).

After installing, restart DSH and hard-refresh the page (the host half is a Node module and does not reload with a page refresh).

## GitHub sign-in and tokens

Two ways to sign in: click **Sign in to GitHub.com** for device flow (works out of the box — the app ships with the package), or paste a **Personal Access Token** (a fine-grained token needs Contents R / Issues RW / Pull requests RW / Actions RW; a classic token needs `repo`).

> ⚠️ The built-in app is a **GitHub App**: [install it](https://github.com/apps/dsh-git-local/installations/new) on your account / organization first — without an installation you sign in successfully but see no repositories. Its user tokens expire after 8 hours; the plugin refreshes them automatically.

To bring your own app, set `clientId` in the profile's `cordis.patch.yml`, or provide the `DSH_GIT_CLIENT_ID` environment variable (`off` disables device flow).

```yaml
- id: dsh-git
  name: '@linxueyuan/dsh-git'
  config:
    clientId: 'Ov23li…'   # Client ID of your own app
```

The token lives in the host only, the browser sees just its last 4 digits, and at rest it is **plaintext with `0600` permissions** — no encryption.

## Known limits (M1)

- Remote tabs are GitHub-only. And the Code tree is the remote's view: local commits that have not been pushed do not show up there as files.
- **The built-in app is a GitHub App**, so its repository access requires installing it first, and its user tokens expire after 8 hours (the plugin refreshes them automatically). Bringing your own OAuth App avoids the install step.

## Development

```bash
npm install           # deps: esbuild (bundling) + typescript / eslint / sass (gates)
npm run build         # lib/index.js (host, esm) + lib/client.js (browser, ModuleLoader-wrapped)
npm run check         # artifact syntax check (node --check)
npm run lint          # ESLint
npm run typecheck     # type gate
npm run check:static  # every static gate in one command (check-all discovers and summarises)
```

**CI only checks the published artifact** (build → artifact syntax → package usability: manifest self-consistency, the host can load it, every runtime dependency is declared, and the tarball is complete and carries no source):

```bash
npm run build && npm run check && node scripts/verify-plugin.mjs
```

The gates below are **local source-hygiene tools, not CI** — they look at how this repository is written rather than at whether an install works, and some of them carry long-standing ratchet debt:

| Gate | Silent failure it catches |
|---|---|
| `check-integration` | artifact not promoted / mirror unreachable / missing class names |
| `check-generated` | generated files out of sync with sources (`npm run check:generated:rebuild` re-runs the build and compares byte for byte) |
| `check-base-recipes` | the class exists but its real style recipe is outside the compiled closure |
| `check-scope-roots` | a scope root appearing twice in one selector ⇒ it can never match |
| `check-sass-leaks` | an unencoded `$var` left in the artifact ⇒ browsers silently drop the whole declaration |
| `check-unreachable-ancestors` | the rule exists but the ancestor element it requires never renders |
| `check-lint` / `check-types` / `check-scripts-types` | ESLint / client types / types of `scripts/**` itself |

Exit-code contract: `0` = pass (registered ratchet debt is allowed), `1` = an **unregistered** defect, `2` = skipped.

## License

[MIT](./LICENSE) · third-party notices: [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)
