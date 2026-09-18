'use strict';
// First run, from the browser. Every check is something Birch can fix itself with a
// button, except signing in to Claude, which only the user can do.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile, spawn } = require('child_process');
const BIN = require('./bin');
const LLM = require('./llm');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, '.birch.json');
const MODEL = path.join(ROOT, 'models', 'ggml-small.en.bin');
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin';
const MODEL_BYTES = 487601967;
const REPO = 'veds260/birch';
const OWNER = 'veds260';
const TOOLS = ['scenevision', 'talkers', 'personmask'];
const MAC = process.platform === 'darwin';
const WIN = process.platform === 'win32';

// Windows has no whisper.cpp anyone can install, so speech goes through
// faster-whisper, which wants the same model in CTranslate2 form.
const FW_DIR = path.join(ROOT, 'models', 'faster-whisper-small.en');
const FW_BASE = 'https://huggingface.co/Systran/faster-whisper-small.en/resolve/main/';
const FW_FILES = ['config.json', 'tokenizer.json', 'vocabulary.txt', 'model.bin'];
const FW_BYTES = 483545366;                       // model.bin, the only big one
// a static ffmpeg that unzips into Birch's own folder, so nothing needs a password
const FFMPEG_ZIP = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
// a self-contained python, for the very likely case that Windows has none
const PY_TAG = '20260901';
const PY_FILE = `cpython-3.12.14+${PY_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz`;
const PY_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PY_TAG}/${PY_FILE}`;
const VENDOR = path.join(ROOT, 'vendor');
// what to paste in a terminal when a Linux box is missing the basics
// mesa and glib are here because the face packages load them even when they only
// use the processor, and a server install of Linux has neither
const LINUX_PKGS = [
  { has: 'apt-get', cmd: 'sudo apt-get install -y ffmpeg cmake build-essential python3-pip python3-venv libegl1 libgl1 libgles2 libglib2.0-0' },
  { has: 'dnf', cmd: 'sudo dnf install -y ffmpeg cmake gcc-c++ make python3-pip mesa-libEGL mesa-libGL mesa-libGLES glib2' },
  { has: 'pacman', cmd: 'sudo pacman -S --needed ffmpeg cmake base-devel python-pip mesa glib2' },
  { has: 'zypper', cmd: 'sudo zypper install -y ffmpeg cmake gcc-c++ make python3-pip Mesa-libEGL1 Mesa-libGL1 Mesa-libGLESv2-2 glib2' },
];

const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
const writeConfig = c => fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2));
const sh = (cmd, args, opts = {}) => new Promise(res => execFile(cmd, args, { timeout: 20000, ...opts },
  (err, out, errOut) => res({ ok: !err, out: String(out || ''), err: String(errOut || (err && err.message) || '') })));
const exists = p => { try { return fs.statSync(p).size > 0; } catch { return false; } };

async function which(name) {
  const p = BIN.find(name);
  if (p !== name) return p;
  if (WIN) return null;                    // BIN.find already asked `where`
  const r = await sh('/bin/sh', ['-lc', 'command -v ' + name]);
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

async function status() {
  const cfg = readConfig();
  const [ffmpeg, whisperCpp, brew, gh] = await Promise.all(['ffmpeg', 'whisper-cli', 'brew', 'gh'].map(which));
  const [pil, ai] = await Promise.all([sh(BIN.python(), ['-c', 'import PIL']), LLM.status()]);
  // whisper.cpp where it can be installed, faster-whisper where it cannot
  const fw = whisperCpp ? null : await sh(BIN.python(), ['-c', 'import faster_whisper'], { timeout: 60000 });
  const engine = whisperCpp ? 'whisper.cpp' : (fw && fw.ok ? 'faster-whisper' : null);
  const whisper = !!engine;
  // on Linux and Windows the face work is done by python, on a Mac by the built Swift tools
  const looker = MAC ? { ok: TOOLS.every(t => exists(path.join(ROOT, 'tools', t))) }
    : await sh(BIN.python(), ['-c', 'import cv2, mediapipe, PIL']);
  // listing MCP servers health-checks every one of them and takes seconds, so read the configs
  const home = require('os').homedir();
  const mcp = { claude: false, codex: false };
  try { mcp.claude = !!JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers?.birch; } catch {}
  try { mcp.codex = /^\[mcp_servers\.birch\]/m.test(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')); } catch {}
  let ghLogin = null;
  if (gh && !cfg.github) { const r = await sh(gh, ['api', 'user', '-q', '.login'], { timeout: 5000 }); if (r.ok) ghLogin = r.out.trim() || null; }
  // the model file to look for depends on which engine will read it
  const wantFw = !whisperCpp;
  const modelFile = wantFw ? path.join(FW_DIR, 'model.bin') : MODEL;
  const modelTotal = wantFw ? FW_BYTES : MODEL_BYTES;
  const modelSize = exists(modelFile) ? fs.statSync(modelFile).size : 0;
  const needs = MAC || WIN ? null : await linuxCommand();
  const steps = {
    github: { done: !!cfg.github, login: cfg.github || null, suggest: ghLogin, canClick: !!ghLogin },
    tools: { done: !!ffmpeg && whisper, ffmpeg: !!ffmpeg, whisper, engine, brew: !!brew, mac: MAC, win: WIN, command: needs },
    model: { done: modelSize > modelTotal * 0.98, have: modelSize, total: modelTotal, engine },
    vision: { done: !!looker.ok && pil.ok, pillow: pil.ok, mac: MAC, win: WIN },
    ai: { done: !!ai.active, optional: true, active: ai.active, claude: ai.claude, codex: ai.codex },
    motion: { done: !!cfg.motionReady, optional: true },
    mcp: { done: (!ai.claude.installed || mcp.claude) && (!ai.codex.installed || mcp.codex) && (mcp.claude || mcp.codex),
      optional: true, possible: ai.claude.installed || ai.codex.installed, claude: mcp.claude, codex: mcp.codex },
  };
  const ready = ['github', 'tools', 'model', 'vision'].every(k => steps[k].done);
  return { ready, steps, dir: ROOT, repo: REPO, owner: OWNER, platform: process.platform };
}

// ----- the GitHub gate: a star on the repo and a follow -----
function gh(url) {
  return new Promise(resolve => {
    https.get(url, { headers: { 'User-Agent': 'birch-setup', Accept: 'application/vnd.github+json' } }, res => {
      let body = ''; res.on('data', d => body += d);
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch {} resolve({ status: res.statusCode, json }); });
    }).on('error', () => resolve({ status: 0, json: null }));
  });
}
async function checkGithub(login) {
  login = String(login || '').trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9-]{1,39}$/i.test(login)) return { ok: false, why: 'That doesn\'t look like a GitHub username.' };
  const user = await gh(`https://api.github.com/users/${login}`);
  if (user.status === 404) return { ok: false, why: `There's no GitHub account called ${login}.` };
  if (user.status !== 200) return { ok: false, why: 'GitHub didn\'t answer. Try again in a minute.' };
  // starred newest first, so a star from a minute ago is on the first page
  const [stars, follow] = await Promise.all([
    gh(`https://api.github.com/users/${login}/starred?sort=created&direction=desc&per_page=100`),
    gh(`https://api.github.com/users/${login}/following/${OWNER}`),
  ]);
  if (stars.status === 403 || follow.status === 403) return { ok: false, why: 'GitHub is rate limiting this network. Try again in a few minutes.' };
  const self = user.json.login.toLowerCase() === OWNER;
  const starred = self || (Array.isArray(stars.json) && stars.json.some(r => (r.full_name || '').toLowerCase() === REPO));
  // you can't follow yourself, so the maintainer's own install passes
  const following = self || follow.status === 204;
  if (!starred || !following) return { ok: false, starred, following, login: user.json.login };
  const cfg = readConfig(); cfg.github = user.json.login; cfg.githubAt = new Date().toISOString(); writeConfig(cfg);
  return { ok: true, starred, following, login: user.json.login };
}
// with the GitHub CLI signed in, one click does both
async function starAndFollow() {
  const g = await which('gh');
  if (!g) return { ok: false, why: 'The GitHub CLI isn\'t installed.' };
  const me = await sh(g, ['api', 'user', '-q', '.login']);
  if (!me.ok) return { ok: false, why: 'The GitHub CLI isn\'t signed in.' };
  await sh(g, ['api', '-X', 'PUT', `/user/starred/${REPO}`]);
  await sh(g, ['api', '-X', 'PUT', `/user/following/${OWNER}`]);
  return checkGithub(me.out.trim());
}

// ----- the fixable steps, each reporting progress -----
function run(step, progress) {
  if (step === 'tools') return (async () => {
    // Windows: both halves come down as files into ~/.birch. ffmpeg is a static
    // build, and speech runs on faster-whisper because whisper.cpp would need
    // Visual Studio, which nobody installs to cut a video.
    if (WIN) {
      if (!(await which('ffmpeg'))) await ffmpegForWindows(progress);
      BIN.forget();
      if (!(await which('ffmpeg'))) throw new Error('ffmpeg came down but Birch cannot run it. Delete the vendor folder in ' + ROOT + ' and press this again.');
      progress(55, 'setting up python for the speech and face work');
      await ensurePython(progress);
      await pythonPackages(['faster-whisper'], progress, 70);
      const ok = await sh(BIN.python(), ['-c', 'import faster_whisper'], { timeout: 120000 });
      if (!ok.ok) throw new Error('The speech package did not import: ' + ok.err.slice(-160));
      return;
    }
    const brew = await which('brew');
    if (MAC || brew) {
      if (!brew) throw new Error('Homebrew is needed first. Install it from https://brew.sh (it asks for your Mac password), then press this again.');
      const want = [];
      if (!(await which('ffmpeg'))) want.push('ffmpeg');
      if (!(await which('whisper-cli'))) want.push('whisper-cpp');
      if (want.length) {
        progress(5, 'brew install ' + want.join(' '));
        await streamed(brew, ['install', ...want], line => progress(null, line));
        BIN.forget();
      }
      if (await which('ffmpeg') && await which('whisper-cli')) return;
      if (MAC) throw new Error('Homebrew finished but ffmpeg or whisper is still missing. Try brew doctor.');
      // a Homebrew on Linux that did not deliver: carry on the Linux way
    }
    // Linux: ffmpeg comes from the package manager, which needs a password Birch
    // does not ask for. whisper is not packaged anywhere, so Birch builds it here.
    if (!(await which('ffmpeg'))) throw new Error('Paste this in a terminal first: ' + (await linuxCommand()));
    if (await which('whisper-cli')) return;
    for (const tool of ['cmake', 'make']) {
      if (!(await which(tool))) throw new Error('Building whisper needs ' + tool + '. Paste this in a terminal first: ' + (await linuxCommand()));
    }
    await buildWhisper(progress);
  })();

  if (step === 'model') return (async () => {
    // faster-whisper reads the same small.en in a different format, so which one
    // comes down depends on what will be doing the listening
    if (!(await which('whisper-cli'))) {
      fs.mkdirSync(FW_DIR, { recursive: true });
      for (const name of FW_FILES) {
        const dst = path.join(FW_DIR, name);
        if (exists(dst) && (name !== 'model.bin' || fs.statSync(dst).size > FW_BYTES * 0.98)) continue;
        await download(FW_BASE + name, dst, (got, total) =>
          name === 'model.bin' && progress(Math.floor(got / total * 100), `${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB`));
      }
      return;
    }
    fs.mkdirSync(path.dirname(MODEL), { recursive: true });
    await download(MODEL_URL, MODEL, (got, total) =>
      progress(Math.floor(got / total * 100), `${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB`));
  })();

  if (step === 'vision') return (async () => {
    if (MAC) {
      for (const [i, t] of TOOLS.entries()) {
        if (exists(path.join(ROOT, 'tools', t))) continue;
        progress(Math.round(i / TOOLS.length * 70), 'building ' + t);
        const r = await sh('swiftc', ['-O', path.join(ROOT, 'tools', t + '.swift'), '-o', path.join(ROOT, 'tools', t)], { timeout: 300000 });
        if (!r.ok) throw new Error('Building ' + t + ' needs the Xcode command line tools. Run xcode-select --install, then press this again.');
      }
      await pythonPackages(['Pillow'], progress, 80);
      return;
    }
    // Only macOS has the Vision framework, so everywhere else the faces, lips and
    // cut-out come from python
    if (WIN) await ensurePython(progress);
    await pythonPackages(['Pillow', 'numpy', 'opencv-python-headless', 'mediapipe'], progress, 5);
    const ok = await sh(BIN.python(), ['-c', 'import cv2, mediapipe, PIL'], { timeout: 60000 });
    if (!ok.ok) {
      // the usual one: mediapipe pulls in graphics libraries a server install lacks
      if (/libEGL|libGL|libgthread|libglib/i.test(ok.err)) {
        throw new Error('The face packages need a few system libraries. Paste this in a terminal, then press this again: ' + (await linuxCommand()));
      }
      throw new Error('The face packages did not import: ' + ok.err.slice(-160));
    }
    // fetch the face models now, so the first clip does not stop to download them
    progress(85, 'fetching the face models');
    const pre = await sh(BIN.python(), ['-c',
      'import sys; sys.path.insert(0, ' + JSON.stringify(path.join(ROOT, 'lib')) + ');'
      + ' import vision_fallback as v; [v.model(n) for n in v.MODELS]'], { timeout: 600000 });
    if (!pre.ok) throw new Error('Could not fetch the face models: ' + pre.err.slice(-160));
  })();

  // animated inserts render through HyperFrames, which needs its package and a Chrome
  if (step === 'motion') return (async () => {
    progress(10, 'fetching HyperFrames');
    const env = { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1' };
    const npx = BIN.find('npx');            // npx.cmd on Windows, which execFile needs spelled out
    let r = await sh(npx, ['--yes', 'hyperframes', '--version'], { timeout: 300000, env });
    if (!r.ok) throw new Error('Could not fetch HyperFrames: ' + r.err.slice(-160));
    progress(55, 'finding a Chrome to render with');
    r = await sh(npx, ['--yes', 'hyperframes', 'browser', 'ensure'], { timeout: 600000, env });
    if (!r.ok) throw new Error('HyperFrames could not get a Chrome: ' + r.err.slice(-160));
    const cfg = readConfig(); cfg.motionReady = true; writeConfig(cfg);
  })();

  // Birch as a tool inside Claude Code and Codex, with the full path so it works
  // even when the birch command isn't on PATH yet
  if (step === 'mcp') return (async () => {
    // bin/birch has a shebang, which Windows does not read, so there it is run by node
    const cmd = WIN ? [process.execPath, path.join(ROOT, 'bin', 'birch'), 'mcp']
      : [path.join(ROOT, 'bin', 'birch'), 'mcp'];
    const claude = LLM.bin('claude'), codex = LLM.bin('codex');
    if (!claude && !codex) throw new Error('Install Claude Code or Codex first.');
    const errors = [];
    if (claude) {
      const r = await sh(claude, ['mcp', 'add', '--scope', 'user', 'birch', '--', ...cmd], { timeout: 30000 });
      if (!r.ok && !/already exists/i.test(r.err + r.out)) errors.push('Claude Code: ' + (r.err || r.out).slice(-160));
    }
    if (codex) {
      const r = await sh(codex, ['mcp', 'add', 'birch', '--', ...cmd], { timeout: 30000 });
      if (!r.ok && !/already exists/i.test(r.err + r.out)) errors.push('Codex: ' + (r.err || r.out).slice(-160));
    }
    if (errors.length) throw new Error(errors.join(' '));
  })();

  // sign in to Claude or ChatGPT in the browser, then prove it with a tiny real prompt
  if (step === 'login-claude' || step === 'login-codex') return (async () => {
    const which = step.slice(6);
    progress(10, 'finish signing in in the browser tab that opened');
    await LLM.login(which);
    progress(80, 'checking it works');
    const t = await LLM.test(which);
    if (!t.ok) throw new Error(t.error || 'Signed in, but a test prompt didn\'t come back.');
    LLM.choose(which);
  })();
  if (step === 'test-claude' || step === 'test-codex') return (async () => {
    const which = step.slice(5);
    progress(30, 'sending a tiny test prompt');
    const t = await LLM.test(which);
    if (!t.ok) throw new Error(t.error || 'No answer came back.');
    LLM.choose(which);
  })();

  return Promise.reject(new Error('unknown step'));
}

// Python packages go in Birch's own environment, so nothing system-wide changes and
// a locked-down system python (most Linux distributions now) is not a problem.
async function pythonPackages(pkgs, progress, base = 5) {
  const missing = [];
  for (const p of pkgs) {
    const mod = { Pillow: 'PIL', 'opencv-python-headless': 'cv2', numpy: 'numpy', mediapipe: 'mediapipe',
      'faster-whisper': 'faster_whisper' }[p] || p;
    const r = await sh(BIN.python(), ['-c', 'import ' + mod], { timeout: 120000 });
    if (!r.ok) missing.push(p);
  }
  if (!missing.length) return;
  const venv = path.join(ROOT, 'venv');
  const venvPy = path.join(venv, WIN ? 'Scripts' : 'bin', WIN ? 'python.exe' : 'python3');
  let py = BIN.python();
  const tryInstall = async () => sh(py, ['-m', 'pip', 'install', '--quiet', ...missing], { timeout: 1800000 });
  progress(base, 'installing ' + missing.join(', '));
  let r = await tryInstall();
  if (!r.ok && !exists(venvPy)) {
    progress(base + 10, 'making a python environment for Birch');
    const mk = await sh(py, ['-m', 'venv', venv], { timeout: 300000 });
    if (!mk.ok) throw new Error('Could not make a python environment: ' + mk.err.slice(-160));
    py = venvPy;
    r = await tryInstall();
  }
  if (!r.ok) throw new Error('Could not install ' + missing.join(', ') + ': ' + (r.err || r.out).slice(-200));
}

// ----- Windows, where nothing Birch needs is on the machine already -----

// one file, with a progress callback, following redirects
function download(url, dst, onBytes) {
  return new Promise((resolve, reject) => {
    const tmp = dst + '.part';
    const get = (u, hops = 0) => https.get(u, { headers: { 'User-Agent': 'birch-setup' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 8) {
        res.resume(); return get(new URL(res.headers.location, u).href, hops + 1);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download failed (${res.statusCode}) for ${path.basename(dst)}.`)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0, last = -1;
      const out = fs.createWriteStream(tmp);
      res.on('data', d => {
        got += d.length;
        const pc = total ? Math.floor(got / total * 100) : 0;
        if (onBytes && pc !== last) { last = pc; onBytes(got, total || got); }
      });
      res.pipe(out);
      out.on('finish', () => { try { fs.rmSync(dst, { force: true }); } catch {} fs.renameSync(tmp, dst); resolve(); });
      res.on('error', reject); out.on('error', reject);
    }).on('error', reject);
    get(url);
  });
}

// Windows 10 and 11 ship tar, which reads zip and tar.gz, so nothing else is needed
async function unpack(archive, into) {
  fs.mkdirSync(into, { recursive: true });
  const r = await sh('tar', ['-xf', archive, '-C', into], { timeout: 600000 });
  if (!r.ok) throw new Error('Could not unpack ' + path.basename(archive) + ': ' + r.err.slice(-160));
}

async function ffmpegForWindows(progress) {
  const zip = path.join(VENDOR, 'ffmpeg.zip');
  fs.mkdirSync(VENDOR, { recursive: true });
  progress(5, 'downloading ffmpeg');
  await download(FFMPEG_ZIP, zip, (got, total) =>
    progress(5 + Math.floor(got / total * 30), `ffmpeg, ${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB`));
  progress(38, 'unpacking ffmpeg');
  const tmp = path.join(VENDOR, 'ffmpeg-unpack');
  fs.rmSync(tmp, { recursive: true, force: true });
  await unpack(zip, tmp);
  // the zip holds one folder, and the programs are in its bin
  const inner = fs.readdirSync(tmp).map(d => path.join(tmp, d)).find(d => fs.existsSync(path.join(d, 'bin', 'ffmpeg.exe')));
  if (!inner) throw new Error('The ffmpeg download did not contain ffmpeg.exe.');
  const dest = path.join(VENDOR, 'ffmpeg');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(inner, dest);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  const cfg = readConfig();
  cfg.tools = { ...(cfg.tools || {}) };
  for (const n of ['ffmpeg', 'ffprobe', 'ffplay']) {
    const p = path.join(dest, 'bin', n + '.exe');
    if (exists(p)) cfg.tools[n] = p;
  }
  writeConfig(cfg);
  BIN.forget();
  const v = await sh(path.join(dest, 'bin', 'ffmpeg.exe'), ['-version'], { timeout: 30000 });
  if (!v.ok) throw new Error('ffmpeg came down but would not run: ' + v.err.slice(-160));
  progress(50, v.out.split('\n')[0].slice(0, 80));
}

// Windows almost never has a python that pip works in. This one is a folder, not an
// installer, so it needs no password and touches nothing outside ~/.birch.
async function ensurePython(progress) {
  const dest = path.join(VENDOR, 'python');
  const exe = path.join(dest, 'python.exe');
  if (exists(exe)) { rememberPython(exe); return exe; }
  if (!process.env.BIRCH_VENDOR_PYTHON) {
    const have = BIN.python();
    const r = await sh(have, ['-m', 'pip', '--version'], { timeout: 60000 });
    if (r.ok) return have;                      // a real python is already here
  }
  fs.mkdirSync(VENDOR, { recursive: true });
  const tgz = path.join(VENDOR, 'python.tar.gz');
  progress(58, 'downloading python');
  await download(PY_URL, tgz, (got, total) =>
    progress(58 + Math.floor(got / total * 6), `python, ${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB`));
  const tmp = path.join(VENDOR, 'python-unpack');
  fs.rmSync(tmp, { recursive: true, force: true });
  await unpack(tgz, tmp);
  const inner = path.join(tmp, 'python');
  if (!exists(path.join(inner, 'python.exe'))) throw new Error('The python download did not contain python.exe.');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(inner, dest);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tgz, { force: true });
  const v = await sh(exe, ['-V'], { timeout: 30000 });
  if (!v.ok) throw new Error('python came down but would not run: ' + v.err.slice(-160));
  rememberPython(exe);
  progress(66, (v.out + v.err).trim().slice(0, 40));
  return exe;
}

function rememberPython(exe) {
  const cfg = readConfig();
  cfg.tools = { ...(cfg.tools || {}), python: exe };
  writeConfig(cfg);
  BIN.forget();
}

// the package line for whatever Linux this is
async function linuxCommand() {
  for (const p of LINUX_PKGS) if (await which(p.has)) return p.cmd;
  return 'install ffmpeg, cmake and a C++ compiler with your package manager';
}

// whisper.cpp is not in any distro's packages, so Birch clones and builds it into
// its own folder. No root, nothing installed outside ~/.birch.
async function buildWhisper(progress) {
  const dir = path.join(ROOT, 'vendor', 'whisper.cpp');
  if (!fs.existsSync(dir)) {
    progress(5, 'downloading whisper.cpp');
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const r = await sh('git', ['clone', '--depth', '1', 'https://github.com/ggml-org/whisper.cpp', dir], { timeout: 600000 });
    if (!r.ok) throw new Error('Could not download whisper.cpp: ' + r.err.slice(-160));
  }
  progress(25, 'building whisper, this takes a few minutes');
  await streamed('cmake', ['-B', path.join(dir, 'build'), '-S', dir, '-DCMAKE_BUILD_TYPE=Release', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON'], l => progress(null, l.slice(0, 120)));
  await streamed('cmake', ['--build', path.join(dir, 'build'), '--config', 'Release', '-j'], l => progress(null, l.slice(0, 120)));
  const built = ['build/bin/whisper-cli', 'build/bin/main'].map(p => path.join(dir, p)).find(p => exists(p));
  if (!built) throw new Error('whisper built but the program is not where Birch expected it.');
  const cfg = readConfig(); cfg.tools = { ...(cfg.tools || {}), 'whisper-cli': built }; writeConfig(cfg);
  BIN.forget();
}

function streamed(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' } });
    let tail = '';
    const feed = d => { tail = (tail + d).slice(-2000); String(d).split('\n').map(s => s.trim()).filter(Boolean).forEach(onLine); };
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('close', c => c === 0 ? resolve() : reject(new Error(tail.split('\n').filter(Boolean).slice(-2).join(' ').slice(-200))));
  });
}

module.exports = { status, run, checkGithub, starAndFollow, readConfig, ROOT };
