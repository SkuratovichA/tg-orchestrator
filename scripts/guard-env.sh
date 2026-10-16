# Sourced by the launchd guard wrappers (dm-guard.sh, gh-guard.sh). launchd's PATH is
# /usr/bin:/bin — a daemon's PATH is a configuration choice, not an inheritance
# (LEARNING.md): `claude` lives in ~/.local/bin, `gh` in /opt/homebrew/bin, wake.sh
# mirrors into the event log with node.
NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2> /dev/null | sort -V | tail -1)"
export PATH="$HOME/.local/bin:${NODE_BIN:+$NODE_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
# `claude` finds its login in the keychain by user name; a stripped env has none.
export USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}"
export TELEGRAM_MCP_DIR="${TELEGRAM_MCP_DIR:-$HOME/git/telegram-mcp}"
# The telegram-mcp venv python: dm-guard needs its telethon, and every guard needs
# >= 3.10 (`str | None`), while /usr/bin/python3 is 3.9.
GUARD_PYTHON="$TELEGRAM_MCP_DIR/.venv/bin/python"
