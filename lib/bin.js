'use strict';
// Finding programs and opening things, on whatever machine this is. Homebrew, Linux
// package managers and WSL all put things in different places, and a server started
// from a launcher may not have the shell's PATH.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const isWSL = process.platform === 'linux' && (() => {
  try { return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; }
})();

const DIRS = [
  path.join(os.homedir(), '.local/bin'),
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  '/snap/bin', '/var/lib/flatpak/exports/bin',
  path.join(os.homedir(), '.npm-global/bin'),
  path.join(os.homedir(), '.linuxbrew/bin'), '/home/linuxbrew/.linuxbrew/bin',
  '/opt/local/bin',
];

// a tool Birch built for itself (whisper on Linux) wins over nothing at all
function fromConfig(name) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.birch.json'), 'utf8'));
    const p = c.tools && c.tools[name];
    return p && fs.existsSync(p) ? p : null;
  } catch { return null; }
}

const cache = new Map();
// after installing something, the old answer is stale
function forget() { cache.clear(); }

function find(name) {
  // a remembered path can go away when something is uninstalled or moved
  const seen = cache.get(name);
  if (seen !== undefined && (seen === name || fs.existsSync(seen))) return seen;
  let hit = fromConfig(name);
  if (!hit) for (const d of DIRS) {
    const p = path.join(d, name + (isWindows ? '.exe' : ''));
    try { if (fs.existsSync(p)) { hit = p; break; } } catch {}
  }
  if (!hit) {
    // whatever the shell would use, for anything installed somewhere unusual
    try {
      const out = execFileSync(isWindows ? 'where' : 'which', [name], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')[0];
      if (out && fs.existsSync(out)) hit = out;
    } catch {}
  }
  const r = hit || name;                 // fall back to the bare name, so PATH still gets a go
  cache.set(name, r);
  return r;
}

// open a link, a file or a folder in whatever the desktop uses
function openUrl(target) {
  const cmd = isMac ? ['open', [target]]
    : isWSL ? (find('wslview') !== 'wslview' ? ['wslview', [target]] : ['cmd.exe', ['/c', 'start', '', target]])
    : isWindows ? ['cmd', ['/c', 'start', '', target]]
    : ['xdg-open', [target]];
  execFile(cmd[0], cmd[1], () => {});
}

// show a finished file in the file manager, where that is a thing
function reveal(file) {
  if (isMac) return execFile('open', ['-R', file], () => {});
  if (isWindows) return execFile('explorer', ['/select,' + file], () => {});
  openUrl(path.dirname(file));
}

// Birch keeps its own python environment where system python is locked down (Linux)
function python() {
  const own = path.join(__dirname, '..', 'venv', isWindows ? 'Scripts/python.exe' : 'bin/python3');
  if (fs.existsSync(own)) return own;
  // otherwise whatever `python3` means in this shell, which is the one with the
  // packages on it. Guessing a path picks the wrong python on machines with several.
  return fromConfig('python') || 'python3';
}

module.exports = { find, forget, fromConfig, python, openUrl, reveal, isMac, isWindows, isWSL, DIRS,
  FFMPEG: find('ffmpeg'), FFPROBE: find('ffprobe'), WHISPER: find('whisper-cli') };
