#!/bin/zsh
# DSH 日历 · 卸载脚本
#
#   ./uninstall.sh            逐项确认后清理
#   ./uninstall.sh --yes      全部清理（不含日历数据）
#
# 只删本程序自己装的东西。你的 iCloud 日历里的日程一条都不会动 ——
# 那些在苹果服务器上，删本地文件跟它们无关。
set -uo pipefail

SHARE="$HOME/.local/share/dsh-cal"
RUNNER="$HOME/.local/libexec/dsh-cal-run"
BINDIR_FILE="$HOME/.local/bin/dsh-cal"
APPDIR="$HOME/Applications/DSH 日历.app"
CONFIGDIR="$HOME/.config/dsh-cal"
KEYCHAIN_SERVICE="dsh-cal"

ASSUME_YES=0
[ "${1:-}" = "--yes" ] && ASSUME_YES=1

say() { printf '%s\n' "$*"; }

# 删除前统一确认：默认什么都不删
confirm() { # $1 目标描述
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  printf '删除 %s ？[y/N] ' "$1"
  read -r reply
  case "$reply" in [yY]*) return 0 ;; *) return 1 ;; esac
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

if [ -d "$CONFIGDIR" ] && confirm "$CONFIGDIR（含 Apple ID 邮箱与偏好，不含密码）"; then
  rm -rf "$CONFIGDIR"; say "✓ 已移除配置"
fi

# 密码在钥匙串里，跟上面这些是分开的
if security find-generic-password -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1; then
  if confirm "钥匙串里的 dsh-cal 密码"; then
    while security find-generic-password -s "$KEYCHAIN_SERVICE" -g 2>&1 | grep -q '"acct"'; do
      acct="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -g 2>&1 | sed -n 's/.*"acct"<blob>="\([^"]*\)".*/\1/p')"
      [ -z "$acct" ] && break
      security delete-generic-password -s "$KEYCHAIN_SERVICE" -a "$acct" >/dev/null 2>&1 || break
    done
    say "✓ 已清理钥匙串条目"
  fi
fi

say ""
say "卸载完成。日历里的日程不在本机，没有被改动。"
