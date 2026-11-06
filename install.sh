#!/bin/zsh
# DSH 日历 · 安装脚本
#
#   ./install.sh              装后端 + 编译并安装 App
#   ./install.sh --cli-only   只装命令行 / MCP 后端，不装 App
#   ./install.sh --app-only   只编译 App（后端已在）
#
# 会往这些地方写东西（都不需要 sudo）：
#   ~/.local/share/dsh-cal/    后端（cli.mjs + src/）
#   ~/.local/libexec/          启动器（找不到 node 时由它兜底）
#   ~/.local/bin/dsh-cal       命令行入口
#   ~/Applications/DSH 日历.app
# 不会碰：你的日历数据、~/.config/dsh-cal/config.json（已有则原样保留）、钥匙串。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SHARE="$HOME/.local/share/dsh-cal"
LIBEXEC="$HOME/.local/libexec"
BINDIR="$HOME/.local/bin"
APP_NAME="DSH 日历"

MODE="all"
case "${1:-}" in
  --cli-only) MODE="cli" ;;
  --app-only) MODE="app" ;;
  "") ;;
  *) echo "未知参数：$1（可用：--cli-only / --app-only）" >&2; exit 2 ;;
esac

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# ── 0. 系统版本
os_major="$(sw_vers -productVersion | cut -d. -f1)"
if [ "$os_major" -lt 14 ]; then
  die "需要 macOS 14 或更新（当前 $(sw_vers -productVersion)）"
fi

# ── 1. 找 node（后端只依赖 Node 标准库，不需要 npm install）
NODE="${DSH_CAL_NODE:-}"
if [ -z "$NODE" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE="$(command -v node)"
  else
    for c in /opt/homebrew/bin/node /usr/local/bin/node; do
      [ -x "$c" ] && NODE="$c" && break
    done
  fi
fi

if [ -n "$NODE" ]; then
  node_major="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$node_major" -lt 18 ]; then
    die "Node 版本太旧（$("$NODE" -v)），需要 18 或更新。用 Homebrew：brew install node"
  fi
  say "▸ Node $("$NODE" -v)  $NODE"
else
  say "⚠ 没找到 node。App 会用系统日历以外的方式提示你，命令行也跑不起来。"
  say "  装一下：brew install node     （或 https://nodejs.org）"
  say "  装完可以重跑本脚本，或者设置 DSH_CAL_NODE=/path/to/node 再跑。"
fi

# ── 2. 后端
if [ "$MODE" != "app" ]; then
  [ -n "$NODE" ] || die "装后端需要 node"
  say "▸ 安装后端到 $SHARE"
  mkdir -p "$SHARE"
  # 只覆盖代码，不动用户配置（配置在 ~/.config/dsh-cal，本来就不在这里）
  rm -rf "$SHARE/src"
  /bin/cp "$HERE/cal-mcp/cli.mjs" "$HERE/cal-mcp/mcp-server.mjs" "$HERE/cal-mcp/package.json" "$SHARE/"
  /bin/cp -R "$HERE/cal-mcp/src" "$SHARE/src"

  say "▸ 安装启动器到 $LIBEXEC/dsh-cal-run"
  mkdir -p "$LIBEXEC"
    cat > "$LIBEXEC/dsh-cal-run" <<'RUNNER'
#!/bin/sh
# dsh-cal runner — 不依赖 PATH 找 node（GUI 应用的环境变量很干净，没有 shell 配置）。
# 安装时探测到的 node 路径已经烘焙在下一行；换掉 node 也能靠下面的 fallback 兜住。
: "${DSH_CAL_NODE:=__DSH_CAL_NODE_HINT__}"
resolve_node() {
  if [ -n "$DSH_CAL_NODE" ] && [ -x "$DSH_CAL_NODE" ]; then printf '%s' "$DSH_CAL_NODE"; return 0; fi
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "$HOME"/.workbuddy/binaries/node/versions/*/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.volta/bin/node \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
    "$HOME"/Library/Application\ Support/fnm/node-versions/*/installation/bin/node
  do
    if [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}
NODE=$(resolve_node)
if [ -z "$NODE" ]; then
  echo '{"ok":false,"error":"找不到 node，请安装 Node 18+ 或设置 DSH_CAL_NODE"}'
  exit 1
fi
exec "$NODE" "$HOME/.local/share/dsh-cal/cli.mjs" "$@"
RUNNER
  # 把安装时看到的 node 绝对路径写进启动器。访达启动的 App 没有 shell 的 PATH，
  # 只靠 /opt/homebrew、/usr/local 这几个位置找不到 nvm/workbuddy 这类装的 node。
  NODE_FOUND="$(command -v node 2>/dev/null || true)"
  sed -i '' "s|__DSH_CAL_NODE_HINT__|${NODE_FOUND}|" "$LIBEXEC/dsh-cal-run"
  if [ -n "$NODE_FOUND" ]; then
    say "  记住 node 位置：$NODE_FOUND"
  else
    say "  警告：当前 PATH 里没有 node，App 启动时可能找不到。装好 Node 18+ 后重跑一次本脚本。"
  fi
  chmod +x "$LIBEXEC/dsh-cal-run"

  say "▸ 安装命令 $BINDIR/dsh-cal"
  mkdir -p "$BINDIR"
  cat > "$BINDIR/dsh-cal" <<'WRAPPER'
#!/bin/sh
# dsh-cal — 自然语言日历（CalDAV 后端）
exec "$HOME/.local/libexec/dsh-cal-run" "$@"
WRAPPER
  chmod +x "$BINDIR/dsh-cal"

  case ":$PATH:" in
    *":$BINDIR:"*) ;;
    *) say "  提示：$BINDIR 不在 PATH 里，加一行到 ~/.zshrc："
       say "        export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
fi

# ── 3. App
# 两种来源，按目录里有什么自动判断：
#   a) 发行版 zip：根目录直接放着「DSH 日历.app」，拷过去即可，不需要 Xcode / CLT
#   b) git clone：调 cal-app/build.sh 现场编译（需要 swiftc）
if [ "$MODE" != "cli" ]; then
  APP_SRC="$HERE/$APP_NAME.app"
  if [ -d "$APP_SRC" ]; then
    TARGET_APP="$HOME/Applications/$APP_NAME.app"
    say "▸ 安装预编译 App 到 $TARGET_APP"
    mkdir -p "$HOME/Applications"
    # 覆盖旧版：只动我们自己这个 bundle
    [ -d "$TARGET_APP" ] && rm -rf "$TARGET_APP"
    /usr/bin/ditto "$APP_SRC" "$TARGET_APP"
    # 浏览器下载的包带 quarantine 标记，而这个 App 只有本地 ad-hoc 签名、没有 Apple 公证，
    # 不去掉的话双击只会看到「无法验证开发者」。安装脚本替用户摘掉这个标记。
    xattr -dr com.apple.quarantine "$TARGET_APP" 2>/dev/null || true
    if codesign -v "$TARGET_APP" >/dev/null 2>&1; then
      say "  ✓ 签名完整（ad-hoc，未经 Apple 公证）"
    else
      say "  ⚠ 签名校验没通过，App 可能起不来"
    fi
  elif [ -x "$HERE/cal-app/build.sh" ]; then
    say "▸ 编译 App（arm64 + x86_64，首次约一分钟）"
    "$HERE/cal-app/build.sh"
  else
    die "既没有预编译的「$APP_NAME.app」，也没有 cal-app/build.sh"
  fi
fi

say ""
say "✓ 装好了"
if [ "$MODE" != "app" ]; then
  say ""
  say "下一步：连上你的日历（只做一次）"
  say "  1) 打开 https://appleid.apple.com  →  登录与安全  →  App 专用密码  →  生成"
  say "     注意：要的是「App 专用密码」，不是 Apple ID 的登录密码，且账号需已开启双重认证"
  say "  2) dsh-cal login"
  say "  3) dsh-cal doctor       # 检查连通性，应该能列出你的日历"
fi
if [ "$MODE" != "cli" ]; then
  say ""
  say "  open \"\$HOME/Applications/$APP_NAME.app\""
fi
