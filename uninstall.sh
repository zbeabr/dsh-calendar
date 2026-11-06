#!/bin/zsh
# DSH 日历 · 卸载脚本
#
#   ./uninstall.sh                      逐项确认后清理
#   ./uninstall.sh --yes                全部清理（不含日历数据）
#   ./uninstall.sh --yes --discard-pending
#                                       连「还没同步到日历」的待发日程也一起删
#
# 只删本程序自己装的东西。已经写进 iCloud 日历的日程一条都不会动 ——
# 那些在苹果服务器上，删本地文件跟它们无关。
#
# 但**没同步出去**的不一样：断网时建的日程只在本地队列里，删掉就真没了。
# 所以配置目录那一项会单独检查队列，队列非空时额外要一次确认，并先备份一份。
set -uo pipefail

SHARE="$HOME/.local/share/dsh-cal"
RUNNER="$HOME/.local/libexec/dsh-cal-run"
BINDIR_FILE="$HOME/.local/bin/dsh-cal"
APPDIR="$HOME/Applications/DSH 日历.app"
CONFIGDIR="$HOME/.config/dsh-cal"
KEYCHAIN_SERVICE="dsh-cal"
PENDING_FILE="$CONFIGDIR/pending.json"
DEAD_FILE="$CONFIGDIR/pending.dead.json"

ASSUME_YES=0
DISCARD_PENDING=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --discard-pending) DISCARD_PENDING=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
done

say() { printf '%s\n' "$*"; }

# 删除前统一确认：默认什么都不删
confirm() { # $1 目标描述
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  printf '删除 %s ？[y/N] ' "$1"
  read -r reply
  case "$reply" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# 队列里还有几条没发出去的日程。优先用 node 准确计数（App 本来就要 node），
# 没有 node 时退化成数 "id" 字段，宁可高估也不要低估。
pending_count() {
  [ -f "$PENDING_FILE" ] || { echo 0; return; }
  if command -v node >/dev/null 2>&1; then
    node -e '
      try {
        const fs = require("fs");
        const raw = fs.readFileSync(process.argv[1], "utf8");
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed) ? parsed : (parsed && parsed.items) || [];
        process.stdout.write(String(Array.isArray(items) ? items.length : 0));
      } catch { process.stdout.write("0"); }
    ' "$PENDING_FILE" 2>/dev/null || echo 0
  else
    grep -c '"id"' "$PENDING_FILE" 2>/dev/null || echo 0
  fi
}

# 把待发日程的标题列出来，用户才知道自己要丢的是什么
list_pending() {
  command -v node >/dev/null 2>&1 || return 0
  node -e '
    try {
      const fs = require("fs");
      const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const items = Array.isArray(parsed) ? parsed : (parsed && parsed.items) || [];
      for (const item of items.slice(0, 10)) {
        const when = item.start ? new Date(item.start).toLocaleString("zh-CN", { hour12: false }) : "时间未知";
        process.stdout.write(`    · ${when}  ${item.title ?? "(无标题)"}\n`);
      }
      if (items.length > 10) process.stdout.write(`    · …还有 ${items.length - 10} 条\n`);
    } catch { /* 坏文件就不列了，上面已经提示过 */ }
  ' "$PENDING_FILE" 2>/dev/null
}

# 先退出正在运行的 App，否则删不干净
if pgrep -f "DSH 日历.app/Contents/MacOS/DSHCalendar" >/dev/null 2>&1; then
  say "▸ 关闭正在运行的 App"
  pkill -f "DSH 日历.app/Contents/MacOS/DSHCalendar" 2>/dev/null
  sleep 1
fi

if [ -d "$APPDIR" ] && confirm "$APPDIR"; then
  # 走废纸篓而不是 rm：真删错了还能捞回来
  osascript -e "tell application \"Finder\" to delete POSIX file \"$APPDIR\"" >/dev/null 2>&1 \
    || rm -rf "$APPDIR"
  say "✓ 已移除 App"
fi

if [ -f "$BINDIR_FILE" ] && confirm "$BINDIR_FILE"; then
  rm -f "$BINDIR_FILE"; say "✓ 已移除命令 dsh-cal"
fi

if [ -f "$RUNNER" ] && confirm "$RUNNER"; then
  rm -f "$RUNNER"; say "✓ 已移除启动器"
fi

if [ -d "$SHARE" ] && confirm "$SHARE（后端代码）"; then
  rm -rf "$SHARE"; say "✓ 已移除后端"
fi

if [ -d "$CONFIGDIR" ]; then
  PENDING_N="$(pending_count)"
  PENDING_N="${PENDING_N:-0}"
  QUEUE_OK=1

  if [ "$PENDING_N" -gt 0 ] 2>/dev/null; then
    say ""
    say "⚠ 本机还有 $PENDING_N 条日程没有同步到日历（断网时建的，只在本地队列里）。"
    list_pending
    say ""
    # 不管最后删不删，先备份一份，别让一个手滑变成永久丢失
    BACKUP="$HOME/dsh-cal-待同步-$(date +%Y%m%d-%H%M%S).json"
    if cp "$PENDING_FILE" "$BACKUP" 2>/dev/null; then
      say "  已先备份到：$BACKUP"
      [ -f "$DEAD_FILE" ] && cp "$DEAD_FILE" "${BACKUP%.json}-死信.json" 2>/dev/null \
        && say "  另有死信备份：${BACKUP%.json}-死信.json"
    else
      say "  ！备份失败，下面这一项建议选 N，先把队列处理掉再卸载。"
    fi
    say ""
    say "  删掉配置目录会连同这些待发日程一起删除。它们不在苹果服务器上，删了就找不回来。"
    say "  想保留的话：先联网打开一次 App 让它自动补发，或者把上面的备份文件留着。"
    if [ "$DISCARD_PENDING" != "1" ]; then
      # --yes 也不跳过这里：批量确认 ≠ 同意销毁没同步的数据
      printf '确实要连同这 %s 条一起删除？[y/N] ' "$PENDING_N"
      read -r reply
      case "$reply" in [yY]*) ;; *) QUEUE_OK=0 ;; esac
    fi
  fi

  if [ "$QUEUE_OK" = "0" ]; then
    say "▸ 已跳过配置目录（待发日程还在，App 重新装回来就能继续补发）"
  elif confirm "$CONFIGDIR（含 Apple ID 邮箱与偏好，不含密码）"; then
    rm -rf "$CONFIGDIR"; say "✓ 已移除配置"
  fi
fi

# 密码在钥匙串里，跟上面这些是分开的
if security find-generic-password -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1; then
  if confirm "钥匙串里的 $KEYCHAIN_SERVICE 密码"; then
    while security find-generic-password -s "$KEYCHAIN_SERVICE" -g 2>&1 | grep -q '"acct"'; do
      acct="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -g 2>&1 | sed -n 's/.*"acct"<blob>="\([^"]*\)".*/\1/p')"
      [ -z "$acct" ] && break
      security delete-generic-password -s "$KEYCHAIN_SERVICE" -a "$acct" >/dev/null 2>&1 || break
    done
    say "✓ 已清理钥匙串条目"
  fi
fi

say ""
say "卸载完成。已经写进日历的日程不在本机，没有被改动。"
