#!/bin/bash
# Gate dangerous shell commands. Cursor 3.15 does not enforce permission:"ask",
# so matches return deny. Delimiter is "::" because "|" appears in several regexes.

find_jq() {
  if command -v jq >/dev/null 2>&1; then
    command -v jq
    return 0
  fi
  local candidate
  for candidate in /opt/homebrew/bin/jq /usr/local/bin/jq; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

JQ=$(find_jq) || {
  printf '%s\n' '{"permission":"deny","user_message":"Dangerous-command hook could not find jq; the command was blocked.","agent_message":"Hook failed closed: jq is not available."}'
  exit 0
}

input=$(cat)
command=$(printf '%s' "$input" | "$JQ" -r '.command // empty')
if [ -z "$command" ]; then
  printf '%s\n' '{"permission":"allow"}'
  exit 0
fi

# pattern::reason  — POSIX ERE (bash =~), unanchored so chained commands still match.
rules=(
  'rm[[:space:]]+-[a-zA-Z]*[rf].*/::递归强制删除'
  'git[[:space:]]+push[[:space:]].*(--force|[[:space:]]-f([[:space:]]|$))::强制推送覆盖远端历史'
  'git[[:space:]]+reset[[:space:]]+--hard::丢弃未提交修改'
  'git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*f::删除未跟踪文件'
  'git[[:space:]]+checkout[[:space:]]+--([[:space:]]|$)::丢弃工作区修改'
  'git[[:space:]]+branch[[:space:]]+-D::强制删除分支'
  '(^|[^[:alnum:]_])sudo([^[:alnum:]_]|$)::提权操作'
  'kill[[:space:]]+-9|(^|[^[:alnum:]_])pkill([^[:alnum:]_]|$)|(^|[^[:alnum:]_])killall([^[:alnum:]_]|$)::强制终止进程'
  'curl[^|]*\|[[:space:]]*(ba)?sh|wget[^|]*\|[[:space:]]*(ba)?sh::远程脚本管道执行'
  '(^|[^[:alnum:]_])mkfs([^[:alnum:]_]|$)|diskutil[[:space:]]+erase|dd[[:space:]].*of=/dev::磁盘级操作'
  'chmod[[:space:]]+-R[[:space:]]+777|chown[[:space:]]+-R::递归改权限/属主'
  'while[[:space:]]+(:|true)([[:space:]]*;|[[:space:]]+do)::CPU死循环占满机器'
  ':[[:space:]]*\(\)[[:space:]]*\{::fork炸弹'
  '(^|[^[:alnum:]_])(stress|stress-ng)([^[:alnum:]]|$)::CPU压力测试工具'
)

for rule in "${rules[@]}"; do
  pattern="${rule%%::*}"
  reason="${rule#*::}"
  if [[ "$command" =~ $pattern ]]; then
    "$JQ" -nc --arg r "$reason" '{
      permission: "deny",
      user_message: ("已拦截危险命令（" + $r + "）。若确认要执行，请在集成终端中自行运行（人工终端不会触发 hook）。"),
      agent_message: ("Hook 已拒绝该命令：命中「" + $r + "」。不要绕过 hook；等待用户在集成终端自行执行，或请用户明确改写命令。")
    }'
    exit 0
  fi
done

printf '%s\n' '{"permission":"allow"}'
exit 0
