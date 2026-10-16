# Shell helpers shared by the agent-home scripts (migrate-agent-homes.sh,
# install-curator.sh). Sourced, never run. The caller sets AGENTS = the agents
# root (<config dir>/agents).

say() { printf '%s\n' "$*"; }

# make_home <name>: the skeleton, settings.json with the absolute memory dir, CLAUDE.md.
make_home() {
  local home="$AGENTS/$1"
  local d
  for d in memory skills-drafts .claude/rules .claude/skills; do
    if [ ! -d "$home/$d" ]; then
      mkdir -p "$home/$d" && say "created $home/$d"
    fi
  done
  if [ -e "$home/.claude/settings.json" ]; then
    say "kept    $home/.claude/settings.json"
  else
    printf '{\n  "autoMemoryDirectory": "%s"\n}\n' "$home/memory" >"$home/.claude/settings.json"
    say "wrote   $home/.claude/settings.json"
  fi
  if [ -e "$home/CLAUDE.md" ]; then
    say "kept    $home/CLAUDE.md"
  else
    cat >"$home/CLAUDE.md" <<'EOF'
# Standing rules

Rules this agent learned in operation. The approval gate manages this file:
a change arrives as a proposal in the learning topic and is applied from there.
A turn never edits it by hand — propose a rule instead.
EOF
    say "wrote   $home/CLAUDE.md"
  fi
}

# env_file_value <file> <KEY>: the last KEY=value in an env file, one layer of
# surrounding quotes stripped; empty when the file or the key is missing. Read,
# not sourced: the env file is data, and a value with spaces must not run.
env_file_value() {
  [ -f "$1" ] || return 0
  sed -n "s/^[[:space:]]*$2=//p" "$1" | tail -1 | sed -E "s/^[\"'](.*)[\"']$/\\1/"
}
