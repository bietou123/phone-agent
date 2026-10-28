#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

echo "==> [1/6] 更新 Termux 软件包"
pkg update -y >/dev/null 2>&1 || true
pkg install -y nodejs-lts git ripgrep openssh termux-api

echo "==> [2/6] 安装服务依赖与 Claude Code（第一次会比较慢）"
NPM_MIRROR="${AGENT_NPM_MIRROR:-https://registry.npmmirror.com}"
npm install --omit=dev --no-audit --no-fund --registry="$NPM_MIRROR"
# 2.1.110 是最后一个带纯 JS cli.js 的版本；更新的版本只发原生二进制且没有 Android 构建
npm install -g @anthropic-ai/claude-code@2.1.110 --no-audit --no-fund --registry="$NPM_MIRROR"

echo "==> [3/6] 初始化配置"
mkdir -p "$HOME/.phone-agent" "$HOME/agent" "$HOME/bin"
if [ ! -f "$HOME/.phone-agent/config.json" ]; then
  cp "$HERE/config.example.json" "$HOME/.phone-agent/config.json"
  chmod 600 "$HOME/.phone-agent/config.json"
fi
if [ ! -f "$HOME/agent/CLAUDE.md" ]; then
  cp "$HERE/CLAUDE.md" "$HOME/agent/CLAUDE.md"
fi
chmod +x "$HERE/start.sh" "$HERE/stop.sh"

echo "==> [4/6] 生成终端环境变量"
node - "$HOME" <<'NODE'
const fs = require('fs');
const path = require('path');
const home = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(path.join(home, '.phone-agent/config.json'), 'utf8'));
const q = (s) => JSON.stringify(String(s || ''));
const lines = [
  `export ANTHROPIC_BASE_URL=${q(cfg.baseUrl)}`,
  `export ANTHROPIC_AUTH_TOKEN=${q(cfg.authToken)}`,
  `export ANTHROPIC_MODEL=${q(cfg.model)}`,
  `export ANTHROPIC_SMALL_FAST_MODEL=${q(cfg.smallModel || cfg.model)}`,
  'export USE_BUILTIN_RIPGREP=0',
  '',
].join('\n');
fs.writeFileSync(path.join(home, '.phone-agent/env.sh'), lines);
NODE
grep -q '.phone-agent/env.sh' "$HOME/.bashrc" 2>/dev/null || echo 'source ~/.phone-agent/env.sh' >> "$HOME/.bashrc"

echo "==> [5/6] 接入共享记忆"
if [ -n "${AGENT_MEMORY_REMOTE:-}" ] && [ ! -d "$HOME/agent-memory/.git" ]; then
  git clone "$AGENT_MEMORY_REMOTE" "$HOME/agent-memory" || echo "!! 记忆仓库克隆失败，稍后可在设置里重试"
fi
if [ ! -d "$HOME/agent-memory/.git" ]; then
  mkdir -p "$HOME/agent-memory/tools"
  cp "$HERE/tools/mem-sync.mjs" "$HOME/agent-memory/tools/" 2>/dev/null || true
  ( cd "$HOME/agent-memory" && git init -q && printf '*.md merge=union\n' > .gitattributes )
fi
PROJ_KEY="-data-data-com-termux-files-home-agent"
mkdir -p "$HOME/.claude/projects/$PROJ_KEY"
if [ -d "$HOME/agent-memory" ] && [ ! -e "$HOME/.claude/projects/$PROJ_KEY/memory" ]; then
  ln -s "$HOME/agent-memory" "$HOME/.claude/projects/$PROJ_KEY/memory"
fi
mkdir -p "$HOME/.config"
if [ -d "$HOME/agent-memory/cross-model" ] && [ ! -e "$HOME/.config/agent-memory" ]; then
  ln -s "$HOME/agent-memory/cross-model" "$HOME/.config/agent-memory"
fi
if [ ! -f "$HOME/.claude/CLAUDE.md" ]; then
  cat > "$HOME/.claude/CLAUDE.md" <<'EOF'
# 用户共享记忆
@/data/data/com.termux/files/home/.config/agent-memory/MEMORY.md
EOF
fi

echo "==> [6/6] 完成"
echo ""
echo "安装完成。回到「随身 Agent」App 点「启动服务」即可。"
echo "也可以手动启动：bash ~/phone-agent/start.sh"
