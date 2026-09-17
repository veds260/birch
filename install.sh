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
OS="$(uname -s)"

say()  { printf '\n  %s\n' "$1"; }
step() { printf '  %s\n' "$1"; }
die()  { printf '\n  %s\n\n' "$1" >&2; exit 1; }

say "Installing Birch"

case "$OS" in
  Darwin) ;;
  Linux) ;;
  *) die "Birch runs on macOS and Linux. On Windows, install it inside WSL2." ;;
esac

if [ "$OS" = Darwin ] && ! xcode-select -p >/dev/null 2>&1; then
  # a fresh Mac has a git placeholder that only works once Apple's command line tools are in
  xcode-select --install >/dev/null 2>&1 || true
  die "Apple's command line tools are needed first. A window just opened to install them (about 5 minutes). When it finishes, run this again."
fi

command -v git >/dev/null 2>&1 || die "git is missing. Install it first, then run this again."

if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    step "installing node with Homebrew, this can take a few minutes"
    brew install node
  elif command -v apt-get >/dev/null 2>&1; then
    die "Birch needs Node 18 or newer. Run: sudo apt-get install -y nodejs npm"
  elif command -v dnf >/dev/null 2>&1; then
    die "Birch needs Node 18 or newer. Run: sudo dnf install -y nodejs"
  elif command -v pacman >/dev/null 2>&1; then
    die "Birch needs Node 18 or newer. Run: sudo pacman -S nodejs npm"
  else
    die "Birch needs Node 18 or newer. Install it from https://nodejs.org, then run this again."
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
    *) for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
         [ -e "$rc" ] || continue
         printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
       done
       step "added ~/.local/bin to your PATH. Open a new terminal for it." ;;
  esac
fi
step "the birch command is in $LINKED"

say "Opening Birch. The setup page walks you through the rest."
"$DIR/bin/birch"

say "Next time, just type: birch"
step "To use it from Claude Code or ChatGPT, press Add Birch on the setup page."
printf '\n'
