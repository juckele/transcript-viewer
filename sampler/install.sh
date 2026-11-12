#!/usr/bin/env bash
# Installs the usage sampler to run every minute: a systemd user timer on Linux, a launchd agent on macOS.
# It copies the script to ~/.local/share/claude-usage-sampler, so the checkout can move or change afterwards.
# Run it again after pulling changes. `install.sh --uninstall` removes it (the data stays).
#
#   install.sh                  keep the data on this computer, in ~/.local/share/claude-usage
#   install.sh --repo <url>     also push it to a (private) git repo, cloned to ~/git/<repo name>, so several
#                               computers can combine their data. CLAUDE_USAGE_REPO in the environment does the same.
#   install.sh --dir <path>     put the data (or the clone) somewhere else. CLAUDE_USAGE_DIR does the same.
#
# The sampler pushes in the background, so the clone gets its GitHub credentials from the GitHub CLI's login
# (`gh auth git-credential`) when gh is installed, and otherwise from git's usual credential helper.
set -euo pipefail

NAME=claude-usage-sampler
LABEL=$NAME
SRC=$(cd "$(dirname "$0")/.." && pwd)
DEST=$HOME/.local/share/$NAME
LOGDIR=$HOME/.local/state/$NAME

unit_dir=$HOME/.config/systemd/user
plist=$HOME/Library/LaunchAgents/$LABEL.plist

REPO=${CLAUDE_USAGE_REPO:-}
DIR=${CLAUDE_USAGE_DIR:-}
UNINSTALL=
while [[ $# -gt 0 ]]; do
  case $1 in
    --uninstall) UNINSTALL=1 ;;
    --repo) REPO=${2:?--repo needs a URL}; shift ;;
    --dir) DIR=${2:?--dir needs a path}; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ -n $UNINSTALL ]]; then
  if [[ $(uname) == Darwin ]]; then
    launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
    rm -f "$plist"
  else
    systemctl --user disable --now "$NAME.timer" 2>/dev/null || true
    rm -f "$unit_dir/$NAME.service" "$unit_dir/$NAME.timer"
    systemctl --user daemon-reload
  fi
  rm -rf "$DEST"
  echo "Removed $NAME. Data and logs were left in place."
  exit 0
fi

NODE=$(command -v node) || { echo "node not found on PATH" >&2; exit 1; }
CLAUDE=$(command -v claude) || { echo "claude not found on PATH" >&2; exit 1; }
GH=$(command -v gh || true)
RUN_PATH="$(dirname "$NODE"):$(dirname "$CLAUDE"):${GH:+$(dirname "$GH"):}/usr/local/bin:/usr/bin:/bin"

if [[ -n $REPO ]]; then
  repo_name=$(basename "$REPO" .git)
  DIR=${DIR:-$HOME/git/$repo_name}
  if [[ ! -d $DIR/.git ]]; then
    # Only this clone uses the gh helper; the first, empty entry clears any global helpers for it.
    if [[ -n $GH ]]; then
      GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c "credential.helper=!$GH auth git-credential" clone "$REPO" "$DIR"
    else
      GIT_TERMINAL_PROMPT=0 git clone "$REPO" "$DIR"
    fi
  fi
  if [[ -n $GH ]]; then
    git -C "$DIR" config --replace-all credential.helper ''
    git -C "$DIR" config --add credential.helper "!$GH auth git-credential"
  fi
fi
DIR=${DIR:-$HOME/.local/share/claude-usage}
mkdir -p "$DIR"
CLAUDE_USAGE_DIR=$DIR

mkdir -p "$DEST/sampler" "$DEST/lib" "$LOGDIR"
cp "$SRC/sampler/sample-usage.js" "$DEST/sampler/"
cp "$SRC/lib/usage.js" "$DEST/lib/"
echo "Data: $DIR${REPO:+ (pushed to $REPO)}"

if [[ $(uname) == Darwin ]]; then
  mkdir -p "$(dirname "$plist")"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DEST/sampler/sample-usage.js</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$RUN_PATH</string><key>CLAUDE_BIN</key><string>$CLAUDE</string><key>CLAUDE_USAGE_DIR</key><string>$CLAUDE_USAGE_DIR</string></dict>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>$LOGDIR/sampler.log</string>
  <key>StandardOutPath</key><string>$LOGDIR/sampler.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "Installed launchd agent $LABEL. Log: $LOGDIR/sampler.log"
else
  mkdir -p "$unit_dir"
  cat > "$unit_dir/$NAME.service" <<EOF
[Unit]
Description=Record Claude plan usage percentages and token ledger

[Service]
Type=oneshot
Environment=PATH=$RUN_PATH
Environment=CLAUDE_BIN=$CLAUDE
Environment=CLAUDE_USAGE_DIR=$CLAUDE_USAGE_DIR
ExecStart=$NODE $DEST/sampler/sample-usage.js
Nice=10
EOF
  cat > "$unit_dir/$NAME.timer" <<EOF
[Unit]
Description=Run $NAME every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$NAME.timer"
  echo "Installed systemd user timer $NAME.timer. Log: journalctl --user -u $NAME"
fi
