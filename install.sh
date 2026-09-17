#!/bin/sh
# Birch installer.
#
#   curl -fsSL https://birch.video/install | sh
#
# Read it before you run it. It puts Birch in ~/.birch, adds a `birch` command,
# and opens the setup page in your browser, which does the rest with buttons.
# It never asks for a password and writes nothing outside ~/.birch except the
# one command link.

set -eu

DIR="${BIRCH_DIR:-$HOME/.birch}"
REPO="${BIRCH_REPO:-https://github.com/veds260/birch.git}"

say()  { printf '\n  %s\n' "$1"; }
step() { printf '  %s\n' "$1"; }
die()  { printf '\n  %s\n\n' "$1" >&2; exit 1; }

say "Installing Birch"

[ "$(uname -s)" = Darwin ] || die "Birch runs on macOS only, because it uses Apple's Vision framework to find faces."

# a fresh Mac has a git placeholder that only works once Apple's command line tools are in
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install >/dev/null 2>&1 || true
  die "Apple's command line tools are needed first. A window just opened to install them (about 5 minutes). When it finishes, run this again."
fi

if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    step "installing node with Homebrew, this can take a few minutes"
    brew install node
  else
    die "Birch needs Node 18 or newer. Install Homebrew from https://brew.sh (or Node from nodejs.org), then run this again."
  fi
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Birch needs Node 18 or newer. You have $(node -v)."

if [ -d "$DIR/.git" ]; then
  step "updating $DIR"
  git -C "$DIR" pull --ff-only --quiet || die "Could not update $DIR. Move it aside and run this again."
elif [ -e "$DIR" ]; then
  die "$DIR already exists and isn't Birch. Move it, or run with BIRCH_DIR=somewhere-else."
else
  step "downloading into $DIR"
  git clone --depth 1 --quiet "$REPO" "$DIR" || die "Could not download $REPO."
fi
chmod +x "$DIR/bin/birch"

# the command: somewhere already on PATH if we can write there, otherwise ~/.local/bin
LINKED=""
for d in ${BIRCH_BIN_DIR:-/opt/homebrew/bin /usr/local/bin}; do
  if [ -d "$d" ] && [ -w "$d" ]; then ln -sf "$DIR/bin/birch" "$d/birch"; LINKED="$d"; break; fi
done
if [ -z "$LINKED" ]; then
  mkdir -p "$HOME/.local/bin"
  ln -sf "$DIR/bin/birch" "$HOME/.local/bin/birch"
  LINKED="$HOME/.local/bin"
  case ":$PATH:" in
    *":$LINKED:"*) ;;
    *) printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.zshrc"
       step "added ~/.local/bin to your PATH in ~/.zshrc (open a new terminal for it)" ;;
  esac
fi
step "the birch command is in $LINKED"

say "Opening Birch. The setup page walks you through the rest."
"$DIR/bin/birch"

say "Next time, just type: birch"
step "To use it from Claude Code or ChatGPT, press Add Birch on the setup page."
printf '\n'
