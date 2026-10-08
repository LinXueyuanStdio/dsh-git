#!/usr/bin/env bash
# 盯一次 CI 运行,跑完把「结论 + 失败现场 + 截图 artifact」打出来。
#
# 为什么要有它:部署测试一轮要几分钟,靠人肉反复 `gh run view` 既慢又容易漏掉
# 中间态。把它挂在后台 job 上,运行结束时会**唤醒会话**,于是下一步能立刻接上。
#
# 用法:
#   scripts/watch-ci.sh              # 盯当前 HEAD 最近一次运行
#   scripts/watch-ci.sh <run-id>     # 盯指定运行
#   scripts/watch-ci.sh <run-id> 10  # 自定义轮询间隔(秒)
# 退出码:运行 success ⇒ 0;否则 1(方便直接串在 `&&` 后面)。
set -uo pipefail
REPO_SLUG="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)"
RUN="${1:-$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')}"
INTERVAL="${2:-20}"

echo "盯 run ${RUN}(仓库 ${REPO_SLUG},每 ${INTERVAL}s 轮询)"
STATUS=""; CONCLUSION=""
for _ in $(seq 1 240); do
  LINE="$(gh run view "${RUN}" --json status,conclusion --jq '"\(.status) \(.conclusion // "-")"')"
  STATUS="${LINE%% *}"; CONCLUSION="${LINE##* }"
  printf '  [%s] %s %s\n' "$(date +%H:%M:%S)" "${STATUS}" "${CONCLUSION}"
  [ "${STATUS}" = "completed" ] && break
  sleep "${INTERVAL}"
done

echo
echo "=== 各 job ==="
gh run view "${RUN}" --json jobs --jq '.jobs[] | "  \(.name): \(.status) \(.conclusion // "-")"'

if [ "${CONCLUSION}" = "success" ]; then
  echo
  echo "全部通过 ✓"
  echo "截图 artifact:"
  gh api "repos/${REPO_SLUG}/actions/runs/${RUN}/artifacts" \
    --jq '.artifacts[] | "  \(.name)  \(.size_in_bytes) bytes"' 2>/dev/null
  exit 0
fi

echo
echo "=== 失败现场(已滤掉 peer 噪音;只留结论行/错误/诊断)==="
gh run view "${RUN}" --log-failed 2>&1 \
  | grep -vE "missing peer|✕|├─|└─|│" \
  | grep -E "✓ |! |Error|控件清单|弹层 HTML|截图|添加到|提交|exit=|浏览器控制台|页面文本|\[info\]|\[error\]|\[warning\]|\[pageerror\]" \
  | tail -40
exit 1
