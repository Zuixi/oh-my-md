#!/bin/bash
# Gate dangerous shell commands behind a Cursor approval prompt.
# Delimiter is "::" because "|" appears inside several regexes.

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
)

for rule in "${rules[@]}"; do
  pattern="${rule%%::*}"
  reason="${rule#*::}"
  if [[ "$command" =~ $pattern ]]; then
    "$JQ" -n --arg r "$reason" '{
      permission: "ask",
      user_message: ("危险命令（" + $r + "），请确认后执行"),
      agent_message: ("Hook 拦截：命中「" + $r + "」规则，等待用户批准")
    }'
    exit 0
  fi
done

printf '%s\n' '{"permission":"allow"}'
exit 0
