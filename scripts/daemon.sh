#!/bin/bash
# Long-lived background process manager for bot sessions. Claude Code calls this
# from a session to run a dev server / tunnel that must OUTLIVE the current
# turn (a `claude -p` run exits when it replies, taking its `&` jobs with it).
#
#   daemon.sh start <name> <cwd> <cmd...>   # start, detached; prints nothing on success
#   daemon.sh stop  <name>                  # kill it
#   daemon.sh list                          # name  pid  status  cwd  cmd
#   daemon.sh logs  <name> [lines]          # tail its output (default 40)
#   daemon.sh stop-under <dir>              # stop every daemon whose cwd is under <dir>
#
# State: pidfiles + logs under $DAEMON_DIR (default ~/tg-claude-agent/data/daemons).
# Survives the turn (setsid) and a bot restart (the service uses KillMode=process).

set -u
DAEMON_DIR="${DAEMON_DIR:-$HOME/tg-claude-agent/data/daemons}"
mkdir -p "$DAEMON_DIR"

slug() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

cmd_start() {
  local name cwd
  name="$(slug "${1:?name}")"; shift
  cwd="${1:?cwd}"; shift
  [ $# -ge 1 ] || { echo "no command given" >&2; exit 2; }
  [ -d "$cwd" ] || { echo "cwd not a directory: $cwd" >&2; exit 2; }

  local pf="$DAEMON_DIR/$name.pid" lf="$DAEMON_DIR/$name.log" mf="$DAEMON_DIR/$name.meta"
  if [ -f "$pf" ] && alive "$(cat "$pf" 2>/dev/null)"; then
    echo "already running: $name (pid $(cat "$pf"))" >&2
    exit 1
  fi

  : > "$lf"
  printf '%s\t%s\n' "$cwd" "$*" > "$mf"

  local runner
  if command -v setsid >/dev/null 2>&1; then
    runner='setsid'
  else
    runner='nohup'   # fallback where setsid is absent
  fi
  $runner bash -c 'cd "$1" && shift && exec "$@"' _ "$cwd" "$@" \
    >>"$lf" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" > "$pf"
  disown "$pid" 2>/dev/null || true
  sleep 0.7
  alive "$pid" || {
    echo "process exited immediately:" >&2
    tail -n 20 "$lf" >&2
    rm -f "$pf" "$mf"
    exit 1
  }
  echo "started $name (pid $pid)"
}

cmd_stop() {
  local name pf pid
  name="$(slug "${1:?name}")"
  pf="$DAEMON_DIR/$name.pid"
  [ -f "$pf" ] || { echo "no such daemon: $name" >&2; exit 1; }
  pid="$(cat "$pf" 2>/dev/null)"
  if alive "$pid"; then
    # kill the whole process group setsid created
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    sleep 1
    alive "$pid" && { kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null; }
  fi
  rm -f "$pf" "$DAEMON_DIR/$name.meta"
  echo "stopped $name"
}

cmd_list() {
  shopt -s nullglob
  local any=0
  for pf in "$DAEMON_DIR"/*.pid; do
    any=1
    local name pid status cwd cmd
    name="$(basename "$pf" .pid)"
    pid="$(cat "$pf" 2>/dev/null)"
    if alive "$pid"; then status=running; else status=dead; fi
    if [ -f "$DAEMON_DIR/$name.meta" ]; then
      IFS=$'\t' read -r cwd cmd < "$DAEMON_DIR/$name.meta"
    fi
    printf '%s\tpid=%s\t%s\t%s\t%s\n' "$name" "${pid:-?}" "$status" "${cwd:-?}" "${cmd:-?}"
    [ "$status" = dead ] && rm -f "$pf" "$DAEMON_DIR/$name.meta"
  done
  [ "$any" = 1 ] || echo "(no daemons)"
}

cmd_logs() {
  local name lines
  name="$(slug "${1:?name}")"
  lines="${2:-40}"
  local lf="$DAEMON_DIR/$name.log"
  [ -f "$lf" ] || { echo "no logs for $name" >&2; exit 1; }
  tail -n "$lines" "$lf"
}

cmd_stop_under() {
  local base
  base="$(realpath -m "${1:?dir}")"
  shopt -s nullglob
  for mf in "$DAEMON_DIR"/*.meta; do
    local name cwd
    name="$(basename "$mf" .meta)"
    IFS=$'\t' read -r cwd _ < "$mf"
    cwd="$(realpath -m "$cwd" 2>/dev/null || echo "$cwd")"
    case "$cwd/" in
      "$base"/*) cmd_stop "$name" ;;
    esac
  done
}

case "${1:-}" in
  start)      shift; cmd_start "$@" ;;
  stop)       shift; cmd_stop "$@" ;;
  list)       cmd_list ;;
  logs)       shift; cmd_logs "$@" ;;
  stop-under) shift; cmd_stop_under "$@" ;;
  *) echo "usage: daemon.sh {start <name> <cwd> <cmd...>|stop <name>|list|logs <name> [n]|stop-under <dir>}" >&2; exit 2 ;;
esac
