#!/usr/bin/env bash
# deploy.sh —— 把本仓库里已验证的改动同步到沙箱外的 DSH 安装目录。
#
# 背景：本仓库（dsh-deck-remote-exec 的版本化副本）在 DSH 会话 workspace 内可写，
#   而真正生效的安装目录（~/.dsh/...）被 DSH 文件沙箱拦着写不进去。
#   这个脚本把「workspace 源 → 线上目标」的同步固化下来，幂等、带备份、可干跑。
#
# 用法：
#   ./deploy.sh --check    # 只报告差异，不写任何文件
#   ./deploy.sh            # 备份 + 同步 + 校验（已一致则跳过）
#
# 说明：沙箱会话里直接跑会因写不进 ~/.dsh 而失败；需要用 DSH 的一次性提权
#   （danger-full-access）执行本脚本，或在沙箱外的普通终端里跑。
set -euo pipefail

CHECK=0
if [[ "${1:-}" == "--check" ]]; then CHECK=1; fi
if [[ $# -gt 1 || ( $# -eq 1 && $CHECK -eq 0 ) ]]; then
  echo "用法: $0 [--check]" >&2; exit 2
fi

# 源路径按本脚本所在目录推导，换机器/换 workspace 也能用。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS="$(cd "$HERE/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-desktop}"

PLUGIN_SRC="$HERE/lib/services.js"
PLUGIN_DST="$DSH_HOME/deck-patch-bug-004/plugin/lib/services.js"
BRIDGE_SRC="$WS/dsh-remote/lib/deck-bridge.js"
BRIDGE_DST="$DSH_HOME/profiles/$PROFILE/node_modules/dsh-remote/lib/deck-bridge.js"
PKG_DST="$DSH_HOME/profiles/$PROFILE/node_modules/dsh-remote/package.json"

PAIRS=("$PLUGIN_SRC|$PLUGIN_DST" "$BRIDGE_SRC|$BRIDGE_DST")
fail=0
for pair in "${PAIRS[@]}"; do
  src="${pair%%|*}"; dst="${pair##*|}"
  if [[ ! -f "$src" ]]; then echo "缺源文件: $src"; fail=1; continue; fi
  if cmp -s "$src" "$dst" 2>/dev/null; then
    echo "一致（跳过）: $dst"
  else
    echo "差异: $src -> $dst"
    fail=1
    if [[ $CHECK -eq 0 ]]; then
      if [[ -f "$dst" ]]; then
        cp -p "$dst" "$dst.before-deploy.$(date +%Y%m%d-%H%M%S)" || { echo "备份失败: $dst"; exit 1; }
      fi
      cp "$src" "$dst" || { echo "写入失败: $dst（沙箱会话需 danger-full-access 提权）"; exit 1; }
      cmp -s "$src" "$dst" && echo "  已同步: $dst" || { echo "  校验失败: $dst"; exit 1; }
    fi
  fi
done

# dsh-remote 的 package.json 登记 ./deck-bridge（幂等：已有就跳过）
if [[ $CHECK -eq 1 ]]; then
  grep -q '"./deck-bridge"' "$PKG_DST" 2>/dev/null && echo "exports 已登记: ./deck-bridge" || { echo "exports 未登记: ./deck-bridge"; fail=1; }
else
  if grep -q '"./deck-bridge"' "$PKG_DST"; then
    echo "exports 已登记（跳过）: ./deck-bridge"
  else
    cp -p "$PKG_DST" "$PKG_DST.before-deploy.$(date +%Y%m%d-%H%M%S)" || { echo "备份失败: $PKG_DST"; exit 1; }
    python3 - "$PKG_DST" <<'PY'
import sys, json, io
p = sys.argv[1]
with io.open(p, encoding='utf-8') as f:
    data = json.load(f)
data.setdefault('exports', {})['./deck-bridge'] = './lib/deck-bridge.js'
with io.open(p, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write('\n')
print('  exports 已登记: ./deck-bridge')
PY
  fi
fi

# 语法/格式校验
# 语法检查用 stdin + --input-type=module，避免受目标 package.json 的 type 字段影响
node --input-type=module --check < "$PLUGIN_DST" || exit 1
node --input-type=module --check < "$BRIDGE_DST" || exit 1
node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$PKG_DST" || exit 1

if [[ $CHECK -eq 1 ]]; then
  if [[ $fail -ne 0 ]]; then echo "检查完成：有差异（上面标出），需跑 ./deploy.sh 同步"; else echo "检查完成：全部一致"; fi
  exit $fail
fi
echo "部署完成；改动通常在重启 DSH 后生效。"
