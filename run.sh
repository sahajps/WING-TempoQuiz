#!/usr/bin/env bash
#
# TempoQuiz control script. This is the only command you need.
#
#   ./run.sh              start the server and the public tunnel
#   ./run.sh stop         stop both
#   ./run.sh status       what is running, and where
#   ./run.sh url          print just the public URL
#   ./run.sh logs         follow the logs
#   ./run.sh doctor       diagnose a problem
#   ./run.sh passwd       change the console password
#   ./run.sh backup       snapshot the database now
#   ./run.sh test         run the test suite
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

RUN_DIR="run"
LOG_DIR="logs"
SERVER_PID="$RUN_DIR/server.pid"
NGROK_PID="$RUN_DIR/ngrok.pid"
SERVER_LOG="$LOG_DIR/server.log"
NGROK_LOG="$LOG_DIR/ngrok.log"
URL_FILE="$RUN_DIR/public-url"
NGROK_API="http://127.0.0.1:4040/api/tunnels"

NODE_MIN_MAJOR=22
NODE_MIN_MINOR=5

mkdir -p "$RUN_DIR" "$LOG_DIR"

# --- output -----------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; X=$'\033[0m'
else
  B=""; DIM=""; R=""; G=""; Y=""; C=""; X=""
fi

info() { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$X" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$X" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$R" "$X" "$*"; }
die()  { printf '\n%sError:%s %s\n\n' "$R" "$X" "$*" >&2; exit 1; }
rule() { printf '%s\n' "────────────────────────────────────────────────────────────────"; }

NODE_BIN="${NODE_BIN:-node}"
NODE_FLAGS=(--experimental-sqlite --no-warnings)

# --- helpers ----------------------------------------------------------------

# True when $1 holds the pid of a process that is still alive.
pid_alive() {
  local file="$1"
  [ -f "$file" ] || return 1
  local pid
  pid="$(cat "$file" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

stop_pidfile() {
  local file="$1" name="$2"
  if ! pid_alive "$file"; then
    rm -f "$file"
    return 1
  fi
  local pid
  pid="$(cat "$file")"
  kill "$pid" 2>/dev/null
  # Give it a moment to close listening sockets before forcing the issue.
  for _ in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null
    warn "$name did not exit cleanly; forced."
  else
    ok "$name stopped."
  fi
  rm -f "$file"
  return 0
}

# Starts a long-running process in its own session, so that logging out of SSH
# leaves it running. $1 is the pid file, $2 the log file, the rest the command.
spawn_detached() {
  local pidfile="$1" logfile="$2"
  shift 2
  local quoted=""
  local arg
  for arg in "$@"; do
    quoted+=" $(printf '%q' "$arg")"
  done
  # The child writes its own pid before exec, so the file always names the
  # process that is actually running rather than a wrapper that has exited.
  setsid bash -c "echo \$\$ > $(printf '%q' "$pidfile"); exec$quoted" \
    >>"$logfile" 2>&1 < /dev/null &
  # Give the child a moment to record its pid.
  local waited=0
  while [ ! -s "$pidfile" ] && [ $waited -lt 50 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
}

require_node() {
  command -v "$NODE_BIN" >/dev/null 2>&1 || die \
"Node.js is not installed, or is not on PATH.

  TempoQuiz needs Node ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} or newer.
  Install it from https://nodejs.org (choose the LTS build), or with nvm:

      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
      nvm install 22"

  local version major minor
  version="$($NODE_BIN --version 2>/dev/null | sed 's/^v//')"
  major="${version%%.*}"
  minor="$(printf '%s' "$version" | cut -d. -f2)"

  if [ "${major:-0}" -lt "$NODE_MIN_MAJOR" ] ||
     { [ "${major:-0}" -eq "$NODE_MIN_MAJOR" ] && [ "${minor:-0}" -lt "$NODE_MIN_MINOR" ]; }; then
    die \
"Node $version is too old. TempoQuiz needs ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} or newer.

  It relies on Node's built-in SQLite, which arrived in 22.5. That is also
  why there is nothing to compile: no native modules, no build tools.

      nvm install 22 && nvm use 22"
  fi
}

DEPS_STAMP="$RUN_DIR/.deps-installed"

install_deps() {
  # A stamp file rather than comparing mtimes against node_modules: npm does
  # not reliably touch that directory, so the mtime test reinstalls every run.
  if [ -d node_modules ] && [ -f "$DEPS_STAMP" ] && [ "$DEPS_STAMP" -nt package.json ]; then
    return 0
  fi
  info "Installing dependencies..."
  npm install --no-audit --no-fund --loglevel=error || die \
"npm install failed.

  Check your network, then try again. If you are behind a proxy:
      npm config set proxy http://your-proxy:port"
  touch "$DEPS_STAMP"
  ok "Dependencies installed."
}

# Is anything listening on this port? Uses bash's own /dev/tcp, because ss and
# lsof are both absent on plenty of minimal server images.
port_in_use() {
  local port="$1"
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null || return 1
  exec 3<&- 2>/dev/null
  exec 3>&- 2>/dev/null
  return 0
}

# Best-effort description of whatever holds the port, for the error message.
port_owner() {
  local port="$1"
  port_in_use "$port" || return 0

  if command -v ss >/dev/null 2>&1; then
    local found
    found="$(ss -ltnp 2>/dev/null | awk -v p=":$port\$" '$4 ~ p {print $NF; exit}')"
    [ -n "$found" ] && { printf '%s' "$found"; return 0; }
  fi
  if command -v lsof >/dev/null 2>&1; then
    local found
    found="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"; exit}')"
    [ -n "$found" ] && { printf '%s' "$found"; return 0; }
  fi
  # Identify it as ours if it answers like TempoQuiz.
  if curl -s --max-time 2 "http://127.0.0.1:$port/api/ping" 2>/dev/null | grep -q tempoquiz; then
    printf 'another TempoQuiz instance'
  else
    printf 'another process'
  fi
}

# This machine's address on the local network, for when there is no tunnel.
lan_address() {
  local ip=""
  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(10|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.' | head -1)"
  fi
  if [ -z "$ip" ] && command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '{split($4,a,"/"); print a[1]; exit}')"
  fi
  printf '%s' "$ip"
}

load_config() {
  local exported
  exported="$($NODE_BIN "${NODE_FLAGS[@]}" server/cli/init.js --export 2>/dev/null)"
  if [ -z "$exported" ]; then
    return 1
  fi
  eval "$exported"
  # Environment wins over the file, so a one-off run can override the domain
  # or port without editing config: NGROK_DOMAIN=x.ngrok-free.app ./run.sh
  [ -n "${NGROK_DOMAIN:-}" ] && TQ_NGROK_DOMAIN="${NGROK_DOMAIN#https://}"
  [ -n "${PORT:-}" ] && TQ_PORT="$PORT"
  return 0
}

# Waits for the ngrok agent to publish a tunnel, then prints its https URL.
read_tunnel_url() {
  local tries="${1:-40}"
  for _ in $(seq 1 "$tries"); do
    local url
    url="$(curl -s --max-time 2 "$NGROK_API" 2>/dev/null \
      | grep -o '"public_url":"https://[^"]*"' | head -1 | cut -d'"' -f4)"
    if [ -n "$url" ]; then
      printf '%s' "$url"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

ngrok_error_hint() {
  local log="$1"
  if grep -qi 'ERR_NGROK_105\|authentication failed\|invalid.*authtoken' "$log" 2>/dev/null; then
    bad "ngrok rejected the authtoken."
    info "     Copy it again from https://dashboard.ngrok.com/get-started/your-authtoken"
    info "     and put it in config/tempoquiz.yml under ngrok.authtoken"
  elif grep -qi 'ERR_NGROK_108\|simultaneous.*sessions\|limited to 1 simultaneous' "$log" 2>/dev/null; then
    bad "Your ngrok account already has a tunnel open somewhere else."
    info "     Free accounts allow one at a time. Close the other session at"
    info "     https://dashboard.ngrok.com/agents, or run: pkill ngrok"
  elif grep -qi 'ERR_NGROK_313\|not authorized.*domain\|domain.*not found' "$log" 2>/dev/null; then
    bad "That domain is not on your ngrok account."
    info "     Check the spelling in config/tempoquiz.yml under ngrok.domain,"
    info "     or claim it at https://dashboard.ngrok.com/domains"
  elif grep -qi 'address already in use\|bind: address' "$log" 2>/dev/null; then
    bad "ngrok could not open its local API port (4040)."
    info "     Another ngrok is already running. Try: pkill ngrok"
  else
    bad "ngrok did not start. Last lines of $NGROK_LOG:"
    tail -n 6 "$log" 2>/dev/null | sed 's/^/     /'
  fi
}

# --- commands ---------------------------------------------------------------

cmd_start() {
  require_node
  install_deps

  if pid_alive "$SERVER_PID"; then
    warn "TempoQuiz is already running."
    info ""
    cmd_status
    return 0
  fi

  # Creates config/tempoquiz.yml on a fresh clone and explains what to edit.
  $NODE_BIN "${NODE_FLAGS[@]}" server/cli/init.js
  local rc=$?
  [ $rc -eq 0 ] || exit $rc

  load_config || die "Could not read configuration. Run: ./run.sh doctor"

  if port_in_use "$TQ_PORT"; then
    die \
"Port $TQ_PORT is already in use by $(port_owner "$TQ_PORT").

  If that is a TempoQuiz left over from an earlier run:
      ./run.sh stop

  Otherwise stop that process, or change server.port in config/tempoquiz.yml"
  fi

  : > "$SERVER_LOG"
  : > "$NGROK_LOG"
  rm -f "$URL_FILE"

  local public_url="$TQ_PUBLIC_URL"

  # The tunnel comes up first so the server can be told its public address,
  # which is what makes the QR code point somewhere a phone can reach.
  if [ "$TQ_NGROK_ENABLED" = "1" ]; then
    command -v ngrok >/dev/null 2>&1 || die \
"ngrok is not installed, or is not on PATH.

  Install it from https://ngrok.com/download, or:
      curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \\
        | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null \\
        && echo 'deb https://ngrok-agent.s3.amazonaws.com buster main' \\
        | sudo tee /etc/apt/sources.list.d/ngrok.list \\
        && sudo apt update && sudo apt install ngrok

  To run without a public tunnel, set ngrok.enabled: false in
  config/tempoquiz.yml"

    if pgrep -x ngrok >/dev/null 2>&1 && ! pid_alive "$NGROK_PID"; then
      warn "Another ngrok agent is already running; reusing its tunnel if possible."
    fi

    local args=(http "$TQ_PORT" --log stdout --log-format logfmt)
    [ -n "$TQ_NGROK_DOMAIN" ] && args+=(--domain "$TQ_NGROK_DOMAIN")
    [ -n "$TQ_NGROK_REGION" ] && args+=(--region "$TQ_NGROK_REGION")

    info "Opening the public tunnel..."
    # setsid puts it in its own session so closing the SSH connection does not
    # take the tunnel down with it. The inner shell records its own pid and
    # then execs, so the pid file holds the real process, not a short-lived
    # wrapper. The authtoken travels through the environment rather than argv,
    # so it does not appear in `ps` output for other users on the machine.
    spawn_detached "$NGROK_PID" "$NGROK_LOG" \
      env NGROK_AUTHTOKEN="$TQ_NGROK_TOKEN" ngrok "${args[@]}"

    local tunnel
    tunnel="$(read_tunnel_url 40)"
    if [ -z "$tunnel" ]; then
      ngrok_error_hint "$NGROK_LOG"
      stop_pidfile "$NGROK_PID" "ngrok" >/dev/null 2>&1
      die "Could not open the tunnel. Fix the above, or set ngrok.enabled: false to run locally."
    fi
    public_url="$tunnel"
    printf '%s' "$public_url" > "$URL_FILE"
    ok "Tunnel open."
  fi

  info "Starting TempoQuiz..."
  spawn_detached "$SERVER_PID" "$SERVER_LOG" \
    env PUBLIC_URL="$public_url" PORT="$TQ_PORT" HOST="$TQ_BIND" \
    "$NODE_BIN" "${NODE_FLAGS[@]}" server/index.js

  # Wait for the port to actually answer before claiming success.
  local up=""
  for _ in $(seq 1 60); do
    if curl -s --max-time 1 "http://127.0.0.1:$TQ_PORT/api/ping" >/dev/null 2>&1; then
      up=1
      break
    fi
    if ! pid_alive "$SERVER_PID"; then
      break
    fi
    sleep 0.25
  done

  if [ -z "$up" ]; then
    bad "The server did not come up. Last lines of $SERVER_LOG:"
    tail -n 15 "$SERVER_LOG" | sed 's/^/     /'
    stop_pidfile "$NGROK_PID" "ngrok" >/dev/null 2>&1
    rm -f "$SERVER_PID"
    die "Startup failed. Run ./run.sh doctor for a full check."
  fi

  ok "Server running."

  # Surface first-run credentials, which the server prints only once.
  if grep -q 'password  ' "$SERVER_LOG" 2>/dev/null; then
    info ""
    sed -n '/Temporary administrator/,/^$/p' "$SERVER_LOG" | sed 's/^/  /'
  fi

  info ""
  rule
  printf '  %sTempoQuiz is running%s\n' "$B" "$X"
  rule
  if [ -n "$public_url" ]; then
    printf '  Students   %s%s%s\n' "$C" "$public_url" "$X"
    printf '  Console    %s%s/admin%s\n' "$C" "$public_url" "$X"
  else
    # No tunnel, so students must reach this machine directly. localhost is
    # useless to them; show the address their phones can actually open.
    local lan
    lan="$(lan_address)"
    if [ -n "$lan" ]; then
      printf '  Students   %shttp://%s:%s%s  %s(same Wi-Fi only)%s\n' "$C" "$lan" "$TQ_PORT" "$X" "$DIM" "$X"
      printf '  Console    %shttp://%s:%s/admin%s\n' "$C" "$lan" "$TQ_PORT" "$X"
    else
      printf '  Console    %shttp://localhost:%s/admin%s\n' "$C" "$TQ_PORT" "$X"
      printf '  %sNo LAN address found; students cannot reach this machine.%s\n' "$DIM" "$X"
    fi
    printf '  %sngrok.enabled is false — set it true for a public link.%s\n' "$DIM" "$X"
  fi
  printf '  Local      http://localhost:%s\n' "$TQ_PORT"
  rule
  printf '  %sStop with ./run.sh stop   ·   logs with ./run.sh logs%s\n' "$DIM" "$X"
  info ""
}

cmd_stop() {
  local any=1
  stop_pidfile "$SERVER_PID" "Server" && any=0
  stop_pidfile "$NGROK_PID" "Tunnel" && any=0
  rm -f "$URL_FILE"
  [ $any -eq 0 ] || info "  Nothing was running."
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  rule
  printf '  %sTempoQuiz status%s\n' "$B" "$X"
  rule

  if load_config; then
    printf '  Config     config/tempoquiz.yml (port %s)\n' "$TQ_PORT"
  else
    printf '  Config     %snot ready — run ./run.sh%s\n' "$Y" "$X"
    TQ_PORT=3000
  fi

  if pid_alive "$SERVER_PID"; then
    ok "Server running (pid $(cat "$SERVER_PID"))"
    local health
    health="$(curl -s --max-time 2 "http://127.0.0.1:$TQ_PORT/api/ping" 2>/dev/null)"
    if [ -n "$health" ]; then
      ok "Responding on port $TQ_PORT"
    else
      bad "Not responding on port $TQ_PORT — check ./run.sh logs"
    fi
  else
    bad "Server not running"
  fi

  if pid_alive "$NGROK_PID"; then
    ok "Tunnel running (pid $(cat "$NGROK_PID"))"
  else
    warn "Tunnel not running"
  fi

  local url
  url="$(read_tunnel_url 1 2>/dev/null)"
  [ -z "$url" ] && [ -f "$URL_FILE" ] && url="$(cat "$URL_FILE")"
  if [ -n "$url" ]; then
    printf '  Public     %s%s%s\n' "$C" "$url" "$X"
  fi

  if [ -f data/tempoquiz.db ]; then
    printf '  Database   data/tempoquiz.db (%s)\n' "$(du -h data/tempoquiz.db 2>/dev/null | cut -f1)"
  fi
  rule
}

# Just the public URL, nothing else — convenient in scripts and for pasting.
cmd_url() {
  local url
  url="$(read_tunnel_url 2 2>/dev/null)"
  if [ -z "$url" ] && [ -f "$URL_FILE" ]; then
    url="$(cat "$URL_FILE")"
  fi
  if [ -z "$url" ]; then
    if load_config && ! pid_alive "$SERVER_PID"; then
      printf 'Not running. Start it with ./run.sh\n' >&2
    else
      printf 'No public tunnel (ngrok.enabled may be false).\n' >&2
    fi
    return 1
  fi
  printf '%s\n' "$url"
}

cmd_logs() {
  local files=()
  [ -f "$SERVER_LOG" ] && files+=("$SERVER_LOG")
  [ -f "$NGROK_LOG" ] && files+=("$NGROK_LOG")
  [ ${#files[@]} -eq 0 ] && die "No logs yet. Start with ./run.sh"
  info "Following ${files[*]} — Ctrl-C to stop."
  tail -n 40 -f "${files[@]}"
}

cmd_doctor() {
  rule
  printf '  %sTempoQuiz diagnostics%s\n' "$B" "$X"
  rule

  # Node
  if command -v "$NODE_BIN" >/dev/null 2>&1; then
    local v major minor
    v="$($NODE_BIN --version | sed 's/^v//')"
    major="${v%%.*}"; minor="$(printf '%s' "$v" | cut -d. -f2)"
    if [ "${major:-0}" -gt "$NODE_MIN_MAJOR" ] ||
       { [ "${major:-0}" -eq "$NODE_MIN_MAJOR" ] && [ "${minor:-0}" -ge "$NODE_MIN_MINOR" ]; }; then
      ok "Node $v"
    else
      bad "Node $v is too old — need ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}+ (nvm install 22)"
    fi
  else
    bad "Node is not installed"
  fi

  # Built-in SQLite
  if $NODE_BIN "${NODE_FLAGS[@]}" -e 'require("node:sqlite")' 2>/dev/null; then
    ok "Built-in SQLite available"
  else
    bad "node:sqlite unavailable — Node is too old"
  fi

  # Dependencies
  if [ -d node_modules ]; then ok "Dependencies installed"; else warn "Dependencies missing — ./run.sh will install them"; fi

  # ngrok binary
  if command -v ngrok >/dev/null 2>&1; then
    ok "ngrok $(ngrok version 2>/dev/null | head -1 | awk '{print $3}')"
  else
    warn "ngrok not installed — needed unless ngrok.enabled is false"
  fi

  # Config
  if [ -f config/tempoquiz.yml ]; then
    if $NODE_BIN "${NODE_FLAGS[@]}" server/cli/init.js --check 2>/dev/null; then
      ok "Configuration valid"
    else
      bad "Configuration incomplete:"
      $NODE_BIN "${NODE_FLAGS[@]}" server/cli/init.js 2>&1 | sed 's/^/     /'
    fi
    local perms
    perms="$(stat -c '%a' config/tempoquiz.yml 2>/dev/null || stat -f '%Lp' config/tempoquiz.yml 2>/dev/null)"
    if [ "$perms" = "600" ]; then
      ok "Config permissions $perms"
    else
      warn "Config permissions $perms — tighten with: chmod 600 config/tempoquiz.yml"
    fi
  else
    warn "No config yet — ./run.sh will create it"
  fi

  # Port
  if load_config; then
    if ! port_in_use "$TQ_PORT"; then
      ok "Port $TQ_PORT free"
    elif pid_alive "$SERVER_PID"; then
      ok "Port $TQ_PORT held by this TempoQuiz"
    else
      bad "Port $TQ_PORT held by $(port_owner "$TQ_PORT") — not started by this script"
      info "     Stop it, or change server.port in config/tempoquiz.yml"
    fi
  fi

  # Database
  if [ -f data/tempoquiz.db ]; then
    local integrity
    integrity="$($NODE_BIN "${NODE_FLAGS[@]}" -e '
      const {DatabaseSync}=require("node:sqlite");
      try{
        const d=new DatabaseSync("data/tempoquiz.db",{readOnly:true});
        process.stdout.write(String(Object.values(d.prepare("PRAGMA integrity_check").get())[0]));
        d.close();
      }catch(e){process.stdout.write("unreadable: "+e.message);}' 2>/dev/null)"
    if [ "$integrity" = "ok" ]; then
      ok "Database integrity ok"
    else
      bad "Database problem: $integrity"
      info "     Restore the newest snapshot from data/backups/ — see the README."
    fi
    local dperms
    dperms="$(stat -c '%a' data/tempoquiz.db 2>/dev/null || stat -f '%Lp' data/tempoquiz.db 2>/dev/null)"
    [ "$dperms" = "600" ] && ok "Database permissions $dperms" || warn "Database permissions $dperms (expected 600)"
  else
    warn "No database yet — created on first start"
  fi

  # Backups
  if [ -d data/backups ]; then
    local n
    n="$(find data/backups -name '*.db' 2>/dev/null | wc -l | tr -d ' ')"
    [ "$n" -gt 0 ] && ok "$n backup snapshot(s)" || warn "No backups yet"
  fi

  # Disk
  local avail
  avail="$(df -Pk . 2>/dev/null | awk 'NR==2 {print $4}')"
  if [ -n "$avail" ] && [ "$avail" -lt 102400 ]; then
    bad "Low disk space: $((avail / 1024)) MB free"
  else
    ok "Disk space $(df -Ph . 2>/dev/null | awk 'NR==2 {print $4}') free"
  fi

  # Secrets not committed
  if command -v git >/dev/null 2>&1 && [ -d .git ]; then
    if git check-ignore -q config/tempoquiz.yml 2>/dev/null; then
      ok "config/tempoquiz.yml is git-ignored"
    else
      bad "config/tempoquiz.yml is NOT git-ignored — your password could be committed"
    fi
    if git ls-files --error-unmatch config/tempoquiz.yml >/dev/null 2>&1; then
      bad "config/tempoquiz.yml is TRACKED by git. Remove it:"
      info "     git rm --cached config/tempoquiz.yml"
    fi
  fi

  # Live processes
  pid_alive "$SERVER_PID" && ok "Server process alive" || warn "Server not running"
  pid_alive "$NGROK_PID" && ok "Tunnel process alive" || warn "Tunnel not running"

  rule
}

cmd_passwd() {
  require_node
  if pid_alive "$SERVER_PID"; then
    warn "Changing the password will sign out every browser."
  fi
  $NODE_BIN "${NODE_FLAGS[@]}" server/cli/passwd.js
}

cmd_backup() {
  require_node
  $NODE_BIN "${NODE_FLAGS[@]}" server/cli/backup.js
}

cmd_test() {
  require_node
  install_deps
  $NODE_BIN "${NODE_FLAGS[@]}" --test test/*.test.js
}

cmd_help() {
  cat <<'EOF'

  TempoQuiz — live classroom quizzes

    ./run.sh              start the server and the public tunnel
    ./run.sh stop         stop both
    ./run.sh restart      stop, then start
    ./run.sh status       what is running, and where
    ./run.sh url          print just the public URL
    ./run.sh logs         follow the logs (Ctrl-C to stop)
    ./run.sh doctor       check everything and explain what is wrong
    ./run.sh passwd       change the console username and password
    ./run.sh backup       snapshot the database now
    ./run.sh test         run the test suite

  Configuration lives in config/tempoquiz.yml, created on first run.

EOF
}

case "${1:-start}" in
  start)    cmd_start ;;
  stop)     cmd_stop ;;
  restart)  cmd_restart ;;
  status)   cmd_status ;;
  url)      cmd_url ;;
  logs)     cmd_logs ;;
  doctor)   cmd_doctor ;;
  passwd)   cmd_passwd ;;
  backup)   cmd_backup ;;
  test)     cmd_test ;;
  -h|--help|help) cmd_help ;;
  *)
    printf '\nUnknown command: %s\n' "$1"
    cmd_help
    exit 1
    ;;
esac
