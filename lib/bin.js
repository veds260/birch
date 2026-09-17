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

const ROOT = path.join(__dirname, '..');

const DIRS = isWindows ? [
  // anything Birch downloaded for itself, then the usual places a Windows install lands
  path.join(ROOT, 'vendor', 'ffmpeg', 'bin'),
  path.join(ROOT, 'vendor', 'bin'),
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'),
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd'),
  'C:\\ProgramData\\chocolatey\\bin',
] : [
  path.join(os.homedir(), '.local/bin'),
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  '/snap/bin', '/var/lib/flatpak/exports/bin',
  path.join(os.homedir(), '.npm-global/bin'),
  path.join(os.homedir(), '.linuxbrew/bin'), '/home/linuxbrew/.linuxbrew/bin',
  '/opt/local/bin',
  path.join(ROOT, 'vendor', 'bin'),
];

// Windows programs come with an extension, and a .cmd or .bat is as good as an .exe
const SUFFIX = isWindows ? ['.exe', '.cmd', '.bat', ''] : [''];

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
  if (seen !== undefined && fs.existsSync(seen)) return seen;
  let hit = fromConfig(name);
  if (!hit) outer: for (const d of DIRS) for (const s of SUFFIX) {
    const p = path.join(d, name + s);
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) { hit = p; break outer; } } catch {}
  }
  if (!hit) {
    // whatever the shell would use, for anything installed somewhere unusual
    try {
      const out = execFileSync(isWindows ? 'where' : 'which', [name], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim().split(/\r?\n/)[0].trim();
      if (out && fs.existsSync(out)) hit = out;
    } catch {}
  }
  // Only a real find is worth remembering. Caching a miss means something installed a
  // minute ago stays "missing" for as long as the server runs.
  if (hit) { cache.set(name, hit); return hit; }
  return name;                           // fall back to the bare name, so PATH still gets a go
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
// and where there is no system python3 at all (Windows).
function python() {
  const own = path.join(ROOT, 'venv', isWindows ? 'Scripts/python.exe' : 'bin/python3');
  if (fs.existsSync(own)) return own;
  const cfg = fromConfig('python');
  if (cfg) return cfg;
  // otherwise whatever `python3` means in this shell, which is the one with the
  // packages on it. Guessing a path picks the wrong python on machines with several.
  if (!isWindows) return 'python3';
  // Windows ships python3.exe as a Store stub that pops the Store open when it runs,
  // so anything under WindowsApps is not a python Birch can use
  const vendor = path.join(ROOT, 'vendor', 'python', 'python.exe');
  if (fs.existsSync(vendor)) return vendor;
  const py = find('python');
  // naming the folder Birch will put one in means anything asking gets a clean
  // "not there" instead of a Store window
  return py === 'python' || /WindowsApps/i.test(py) ? vendor : py;
}

// Speech to words. whisper.cpp is the one Birch has always used and stays first
// where it exists. Windows needs a C++ compiler to build it, which a newcomer
// does not have, so there the same job runs through faster-whisper in Birch's
// python environment. Both answer the same flags and write the same JSON.
function whisper() {
  const cli = find('whisper-cli');
  if (cli !== 'whisper-cli') return { cmd: cli, args: [], engine: 'whisper.cpp' };
  return { cmd: python(), args: [path.join(__dirname, 'whisper_py.py')], engine: 'faster-whisper' };
}
// true once something can transcribe, whichever of the two it is
function canTranscribe() {
  if (find('whisper-cli') !== 'whisper-cli') return 'whisper.cpp';
  try {
    execFileSync(python(), ['-c', 'import faster_whisper'], { stdio: 'ignore', timeout: 60000 });
    return 'faster-whisper';
  } catch { return null; }
}

module.exports = { find, forget, fromConfig, python, whisper, canTranscribe, openUrl, reveal,
  isMac, isWindows, isWSL, DIRS, ROOT };
// resolved when asked, not when this file loads, so a tool installed during setup
// is picked up without restarting the server
for (const [k, n] of [['FFMPEG', 'ffmpeg'], ['FFPROBE', 'ffprobe'], ['WHISPER', 'whisper-cli']])
  Object.defineProperty(module.exports, k, { enumerable: true, get: () => find(n) });
