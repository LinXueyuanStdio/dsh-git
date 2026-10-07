# 第三方声明 / Third-Party Notices

`@linxueyuan/dsh-git` 包含第三方代码。按各自许可的要求,在此列出**归属**与**许可全文**。

---

## 0. 许可全文

### MIT

下列条款适用于 §1 的 GitHub Desktop,以及 §2 表格中标注 `MIT` 的每个包 —— 各自的**版权行**
分别写在 §1 与 §2 表格的第四列(此处不重复,以免把某一家的版权误挂到别人身上)。

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ISC

适用于 §2 表格中的 `semver`,版权行见该行第四列。

```
The ISC License

Copyright (c) Isaac Z. Schlueter and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### BSD-3-Clause

适用于 §2 表格中的 `react-transition-group`,版权行见该行第四列。

```
BSD 3-Clause License

Copyright (c) 2018, React Community
Forked from React (https://github.com/facebook/react) Copyright 2013-present, Facebook, Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---

## 1. 对齐自 GitHub Desktop 的源码

`src/core/desktop/**`(模型、组件、状态接缝与 diff 视图那一层)对齐自
[GitHub Desktop](https://github.com/desktop/desktop)。上游的版权行:

```
Copyright (c) GitHub, Inc.
```

许可以为上文的 MIT 全文。

---

## 2. 打进产物的第三方包

`lib/index.js` 与 `lib/client.js` 是 esbuild 的**打包产物**:下表这些包(含传递依赖)的代码被
**内联**在产物里,共 **96** 个(MIT × 94, BSD-3-Clause × 1, ISC × 1),全部是宽松许可,**没有 copyleft**。

宿主在运行时提供、因此**不在**产物里的外部模块:`@deepseek-ai/*`(含 `@deepseek-ai/schemastery`)、
`react`、`react-dom`、`react/jsx-runtime`。

> **为什么 `package.json` 里没有 `dependencies`。** 上表这些包是**构建期**依赖:代码已经被
> esbuild 打进 `lib/*.js`,运行时不会再 `import` / `require` 它们,所以它们只能是
> `devDependencies`(否则每个用户的 profile 会白白再装一遍这 96 个包)。
> 判据不是惯例,而是**产物本身**:两个 bundle 里的外部 `import` / `require` 只有
> `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-client-ui-primitives`、`react`、
> `react-dom`、`react/jsx-runtime`(外加 node 内置),动态 `import()` 为 0 ——
> 所以宿主提供的这 4 个(jsx-runtime 属 react 的子路径)写进 `peerDependencies`:
> `@deepseek-ai/schemastery` 是必需的(host 半静态 import 它,缺了插件加载不起来),
> 其余三个标 `optional`(由宿主的 ModuleLoader 在运行时解析;标 optional 是为了避免
> pnpm 的 `auto-install-peers` 在用户 profile 里再装一份自己的 react)。

| # | 包 | 版本 | 许可 | 版权 |
|---:|---|---|---|---|
| 1 | `@babel/runtime` | 7.29.7 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors |
| 2 | `@floating-ui/core` | 1.7.3 | MIT | Copyright (c) 2021-present Floating UI contributors |
| 3 | `@floating-ui/dom` | 1.8.0 | MIT | Copyright (c) 2021-present Floating UI contributors |
| 4 | `@floating-ui/react-dom` | 2.1.6 | MIT | Copyright (c) 2021-present Floating UI contributors |
| 5 | `@floating-ui/utils` | 0.2.12 | MIT | Copyright (c) 2021-present Floating UI contributors |
| 6 | `array-buffer-byte-length` | 1.0.2 | MIT | Copyright (c) 2023 Inspect JS |
| 7 | `available-typed-arrays` | 1.0.7 | MIT | Copyright (c) 2020 Inspect JS |
| 8 | `call-bind` | 1.0.9 | MIT | Copyright (c) 2020 Jordan Harband |
| 9 | `call-bind-apply-helpers` | 1.0.2 | MIT | Copyright (c) 2024 Jordan Harband |
| 10 | `call-bound` | 1.0.4 | MIT | Copyright (c) 2024 Jordan Harband |
| 11 | `classnames` | 2.5.1 | MIT | Copyright (c) 2018 Jed Watson |
| 12 | `clsx` | 1.2.1 | MIT | Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com) |
| 13 | `csstype` | 3.2.3 | MIT | Copyright (c) 2017-2018 Fredrik Nicol |
| 14 | `date-fns` | 4.1.0 | MIT | Copyright (c) 2021 Sasha Koss and Lesha Koss https://kossnocorp.mit-license.org |
| 15 | `deep-equal` | 2.2.3 | MIT | Copyright (c) 2012, 2013, 2014 James Halliday <mail@substack.net>, 2009 Thomas Robinson <280north.com> |
| 16 | `define-data-property` | 1.1.4 | MIT | Copyright (c) 2023 Jordan Harband |
| 17 | `define-properties` | 1.2.1 | MIT | Copyright (C) 2015 Jordan Harband |
| 18 | `dom-helpers` | 5.2.1 | MIT | Copyright (c) 2015 Jason Quense |
| 19 | `dunder-proto` | 1.0.1 | MIT | Copyright (c) 2024 ECMAScript Shims |
| 20 | `es-define-property` | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband |
| 21 | `es-errors` | 1.3.0 | MIT | Copyright (c) 2024 Jordan Harband |
| 22 | `es-get-iterator` | 1.1.3 | MIT | Copyright (c) 2019 Jordan Harband |
| 23 | `es-object-atoms` | 1.1.2 | MIT | Copyright (c) 2024 Jordan Harband |
| 24 | `event-kit` | 2.5.0 | MIT | Copyright (c) 2014 GitHub Inc. |
| 25 | `focus-trap` | 7.6.5 | MIT | Copyright (c) 2015-2016 David Clark |
| 26 | `focus-trap-react` | 10.3.1 | MIT | Copyright (c) 2015 David Clark |
| 27 | `for-each` | 0.3.5 | MIT | Copyright (c) 2012 Raynos. |
| 28 | `function-bind` | 1.1.2 | MIT | Copyright (c) 2013 Raynos. |
| 29 | `functions-have-names` | 1.2.3 | MIT | Copyright (c) 2019 Jordan Harband |
| 30 | `fuzzaldrin-plus` | 0.6.0 | MIT | Copyright (c) 2015 Jean Christophe Roy |
| 31 | `get-intrinsic` | 1.3.0 | MIT | Copyright (c) 2020 Jordan Harband |
| 32 | `get-proto` | 1.0.1 | MIT | Copyright (c) 2025 Jordan Harband |
| 33 | `gopd` | 1.2.0 | MIT | Copyright (c) 2022 Jordan Harband |
| 34 | `has-bigints` | 1.1.0 | MIT | Copyright (c) 2019 Jordan Harband |
| 35 | `has-property-descriptors` | 1.0.2 | MIT | Copyright (c) 2022 Inspect JS |
| 36 | `has-symbols` | 1.1.0 | MIT | Copyright (c) 2016 Jordan Harband |
| 37 | `has-tostringtag` | 1.0.2 | MIT | Copyright (c) 2021 Inspect JS |
| 38 | `hasown` | 2.0.4 | MIT | Copyright (c) Jordan Harband and contributors |
| 39 | `internal-slot` | 1.1.0 | MIT | Copyright (c) 2019 Jordan Harband |
| 40 | `is-arguments` | 1.2.0 | MIT | Copyright (c) 2014 Jordan Harband |
| 41 | `is-array-buffer` | 3.0.5 | MIT | Copyright (c) 2015 Chen Gengyuan, Inspect JS |
| 42 | `is-bigint` | 1.1.0 | MIT | Copyright (c) 2018 Jordan Harband |
| 43 | `is-boolean-object` | 1.2.2 | MIT | Copyright (c) 2015 Jordan Harband |
| 44 | `is-callable` | 1.2.7 | MIT | Copyright (c) 2015 Jordan Harband |
| 45 | `is-date-object` | 1.1.0 | MIT | Copyright (c) 2015 Jordan Harband |
| 46 | `is-map` | 2.0.3 | MIT | Copyright (c) 2019 Inspect JS |
| 47 | `is-number-object` | 1.1.1 | MIT | Copyright (c) 2015 Jordan Harband |
| 48 | `is-regex` | 1.2.1 | MIT | Copyright (c) 2014 Jordan Harband |
| 49 | `is-set` | 2.0.3 | MIT | Copyright (c) 2019 Inspect JS |
| 50 | `is-shared-array-buffer` | 1.0.4 | MIT | Copyright (c) 2021 Inspect JS |
| 51 | `is-string` | 1.1.1 | MIT | Copyright (c) 2015 Jordan Harband |
| 52 | `is-symbol` | 1.1.1 | MIT | Copyright (c) 2015 Jordan Harband |
| 53 | `is-weakmap` | 2.0.2 | MIT | Copyright (c) 2019 Inspect JS |
| 54 | `is-weakset` | 2.0.4 | MIT | Copyright (c) 2019 Inspect JS |
| 55 | `isarray` | 2.0.5 | MIT | Copyright (c) 2013 Julian Gruber <julian@juliangruber.com> |
| 56 | `js-tokens` | 4.0.0 | MIT | Copyright (c) 2014, 2015, 2016, 2017, 2018 Simon Lydell |
| 57 | `lodash` | 4.17.21 | MIT | Copyright OpenJS Foundation and other contributors <https://openjsf.org/> |
| 58 | `loose-envify` | 1.4.0 | MIT | Copyright (c) 2015 Andres Suarez <zertosh@gmail.com> |
| 59 | `map-age-cleaner` | 0.1.3 | MIT | Copyright (c) Sam Verschueren <sam.verschueren@gmail.com> (github.com/SamVerschueren) |
| 60 | `math-intrinsics` | 1.1.0 | MIT | Copyright (c) 2024 ECMAScript Shims |
| 61 | `mem` | 4.3.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| 62 | `memoize-one` | 6.0.0 | MIT | Copyright (c) 2019 Alexander Reardon |
| 63 | `mimic-fn` | 2.1.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| 64 | `object-assign` | 4.1.1 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| 65 | `object-inspect` | 1.13.4 | MIT | Copyright (c) 2013 James Halliday |
| 66 | `object-is` | 1.1.6 | MIT | Copyright (c) 2014 Jordan Harband |
| 67 | `object-keys` | 1.1.1 | MIT | Copyright (C) 2013 Jordan Harband |
| 68 | `object.assign` | 4.1.7 | MIT | Copyright (c) 2014 Jordan Harband |
| 69 | `p-defer` | 1.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| 70 | `p-is-promise` | 2.1.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| 71 | `parse-dds` | 1.2.1 | MIT | Copyright (c) 2015 Jam3 |
| 72 | `possible-typed-array-names` | 1.1.0 | MIT | Copyright (c) 2024 Jordan Harband |
| 73 | `prop-types` | 15.8.1 | MIT | Copyright (c) 2013-present, Facebook, Inc. |
| 74 | `quick-lru` | 3.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| 75 | `react-css-transition-replace` | 4.0.5 | MIT | Copyright © 2015 Marnus Weststrate |
| 76 | `react-is` | 16.13.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| 77 | `react-lifecycles-compat` | 3.0.4 | MIT | Copyright (c) 2013-present, Facebook, Inc. |
| 78 | `react-transition-group` | 4.4.5 | BSD-3-Clause | Copyright (c) 2018, React Community |
| 79 | `react-virtualized` | 9.22.5 | MIT | Copyright (c) 2015 Brian Vaughn |
| 80 | `regexp.prototype.flags` | 1.5.4 | MIT | Copyright (C) 2014 Jordan Harband |
| 81 | `safe-regex-test` | 1.1.0 | MIT | Copyright (c) 2022 Jordan Harband |
| 82 | `semver` | 7.8.5 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| 83 | `set-function-length` | 1.2.2 | MIT | Copyright (c) Jordan Harband and contributors |
| 84 | `set-function-name` | 2.0.2 | MIT | Copyright (c) Jordan Harband and contributors |
| 85 | `side-channel` | 1.1.1 | MIT | Copyright (c) 2019 Jordan Harband |
| 86 | `side-channel-list` | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband |
| 87 | `side-channel-map` | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband |
| 88 | `side-channel-weakmap` | 1.0.2 | MIT | Copyright (c) 2019 Jordan Harband |
| 89 | `stop-iteration-iterator` | 1.1.0 | MIT | Copyright (c) 2023 Jordan Harband |
| 90 | `string-argv` | 0.3.2 | MIT | Copyright 2014 Anthony McCormick |
| 91 | `tabbable` | 6.5.0 | MIT | Copyright (c) 2015 David Clark |
| 92 | `textarea-caret` | 3.1.0 | MIT | Copyright (c) 2015 Jonathan Ong me@jongleberry.com |
| 93 | `which-boxed-primitive` | 1.1.1 | MIT | Copyright (c) 2019 Jordan Harband |
| 94 | `which-collection` | 1.0.2 | MIT | Copyright (c) 2019 Inspect JS |
| 95 | `which-typed-array` | 1.1.24 | MIT | Copyright (c) 2015 Jordan Harband |
| 96 | `zod` | 4.6.5 | MIT | Copyright (c) 2025 Colin McDonnell |

---

## 3. 这份清单怎么复现

从 `package-lock.json` 出发:取根包的 `dependencies`(排除宿主提供的外部模块
`@deepseek-ai/*`、`react`、`react-dom`、`react/jsx-runtime`),沿
`dependencies` / `optionalDependencies` 递归展开 —— 得到的就是 esbuild 会内联的第三方集合。
版权行取自各包自己的 `LICENSE` 文件。
