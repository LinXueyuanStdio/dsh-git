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
- **Findable in settings** — there are cards both in the sidebar's Plugins page and under Settings ▸ Built-in plugins.

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

By default a Personal Access Token is all you need (a fine-grained token needs Contents R / Issues RW / Pull requests RW / Actions RW; a classic token needs `repo`). If you want device-code sign-in, put the Client ID of a GitHub OAuth App into the profile's `cordis.patch.yml`:

```yaml
- id: dsh-git
  name: '@linxueyuan/dsh-git'
  config:
    # Create your own OAuth App — it is free and does not need Copilot:
    # https://github.com/settings/developers → New OAuth App
    # Tick "Enable Device Flow"; the Callback URL can be blank or anything.
    # The device flow needs no client secret, so a bare Client ID leaks nothing.
    clientId: 'Iv1.xxxxxxxx'
```

Without a Client ID, settings simply offer Personal Access Token sign-in only — you lose a step, not a feature.

Where the token lives and what protects it:

- **It lives in the host only; the browser never sees the full value.** It hangs off the host credential seam `ctx.credentials` as `GITHUB_TOKEN` (`$DSH_HOME/.credentials.yaml`), and the UI only shows the last 4 digits. git receives it through the environment — never through argv or `.git/config`.
- **It is not in the plugin's general storage domain.** Reading, writing, exporting and backing up that whole domain would carry it along — so the token stays out of it.
- **`GITHUB_TOKEN=… dsh` is a read-only override** (writing it is rejected), so rotating a token needs no code change.
- **At rest it is plaintext plus file permissions (`0600` file / `0700` directory); there is no encryption.** There is no `safeStorage` / `keytar` anywhere in this repository; the host's own `credentials-local` README says its OS keychain providers are "deferred" and that "none is shipped", and its own account token sits in plaintext in that same `$DSH_HOME/.credentials.yaml`. `0600` keeps other users out; it does not keep out processes running as you, backup tools, or cloud sync.

## Known limits (M1)

- Remote tabs are GitHub-only. And the Code tree is the remote's view: local commits that have not been pushed do not show up there as files.

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
