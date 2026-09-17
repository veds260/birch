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

const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
const writeConfig = c => fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2));
const sh = (cmd, args, opts = {}) => new Promise(res => execFile(cmd, args, { timeout: 20000, ...opts },
  (err, out, errOut) => res({ ok: !err, out: String(out || ''), err: String(errOut || (err && err.message) || '') })));
const exists = p => { try { return fs.statSync(p).size > 0; } catch { return false; } };

async function which(name) {
  const p = BIN.find(name);
  if (p !== name) return p;
  const r = await sh('/bin/zsh', ['-lc', 'command -v ' + name]);
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

async function status() {
  const cfg = readConfig();
  const [ffmpeg, whisper, brew, gh] = await Promise.all(['ffmpeg', 'whisper-cli', 'brew', 'gh'].map(which));
  const [pil, ai] = await Promise.all([sh('python3', ['-c', 'import PIL']), LLM.status()]);
  // listing MCP servers health-checks every one of them and takes seconds, so read the configs
  const home = require('os').homedir();
  const mcp = { claude: false, codex: false };
  try { mcp.claude = !!JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers?.birch; } catch {}
  try { mcp.codex = /^\[mcp_servers\.birch\]/m.test(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')); } catch {}
  let ghLogin = null;
  if (gh && !cfg.github) { const r = await sh(gh, ['api', 'user', '-q', '.login'], { timeout: 5000 }); if (r.ok) ghLogin = r.out.trim() || null; }
  const modelSize = exists(MODEL) ? fs.statSync(MODEL).size : 0;
  const steps = {
    github: { done: !!cfg.github, login: cfg.github || null, suggest: ghLogin, canClick: !!ghLogin },
    tools: { done: !!ffmpeg && !!whisper, ffmpeg: !!ffmpeg, whisper: !!whisper, brew: !!brew },
    model: { done: modelSize > MODEL_BYTES * 0.98, have: modelSize, total: MODEL_BYTES },
    vision: { done: TOOLS.every(t => exists(path.join(ROOT, 'tools', t))) && pil.ok, pillow: pil.ok },
    ai: { done: !!ai.active, optional: true, active: ai.active, claude: ai.claude, codex: ai.codex },
    motion: { done: !!cfg.motionReady, optional: true },
    mcp: { done: (!ai.claude.installed || mcp.claude) && (!ai.codex.installed || mcp.codex) && (mcp.claude || mcp.codex),
      optional: true, possible: ai.claude.installed || ai.codex.installed, claude: mcp.claude, codex: mcp.codex },
  };
  const ready = ['github', 'tools', 'model', 'vision'].every(k => steps[k].done);
  return { ready, steps, dir: ROOT, repo: REPO, owner: OWNER };
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
    const brew = await which('brew');
    if (!brew) throw new Error('Homebrew is needed first. Install it from https://brew.sh (it asks for your Mac password), then press this again.');
    const want = [];
    if (!(await which('ffmpeg'))) want.push('ffmpeg');
    if (!(await which('whisper-cli'))) want.push('whisper-cpp');
    if (!want.length) return;
    progress(5, 'brew install ' + want.join(' '));
    await streamed(brew, ['install', ...want], line => progress(null, line));
  })();

  if (step === 'model') return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(MODEL), { recursive: true });
    const tmp = MODEL + '.part';
    const get = (url, hops = 0) => https.get(url, { headers: { 'User-Agent': 'birch-setup' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 6) { res.resume(); return get(new URL(res.headers.location, url).href, hops + 1); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('The model download failed (' + res.statusCode + ').')); }
      const total = Number(res.headers['content-length']) || MODEL_BYTES;
      let got = 0, last = 0;
      const out = fs.createWriteStream(tmp);
      res.on('data', d => { got += d.length; const pc = Math.floor(got / total * 100); if (pc !== last) { last = pc; progress(pc, `${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB`); } });
      res.pipe(out);
      out.on('finish', () => { fs.renameSync(tmp, MODEL); resolve(); });
      res.on('error', reject); out.on('error', reject);
    }).on('error', reject);
    get(MODEL_URL);
  });

  if (step === 'vision') return (async () => {
    for (const [i, t] of TOOLS.entries()) {
      if (exists(path.join(ROOT, 'tools', t))) continue;
      progress(Math.round(i / TOOLS.length * 80), 'building ' + t);
      const r = await sh('swiftc', ['-O', path.join(ROOT, 'tools', t + '.swift'), '-o', path.join(ROOT, 'tools', t)], { timeout: 300000 });
      if (!r.ok) throw new Error('Building ' + t + ' needs the Xcode command line tools. Run xcode-select --install, then press this again.');
    }
    const pil = await sh('python3', ['-c', 'import PIL']);
    if (!pil.ok) {
      progress(85, 'installing Pillow');
      let r = await sh('python3', ['-m', 'pip', 'install', '--user', 'Pillow'], { timeout: 300000 });
      if (!r.ok) r = await sh('python3', ['-m', 'pip', 'install', '--user', '--break-system-packages', 'Pillow'], { timeout: 300000 });
      if (!r.ok) throw new Error('Pillow didn\'t install: ' + r.err.slice(-160));
    }
  })();

  // animated inserts render through HyperFrames, which needs its package and a Chrome
  if (step === 'motion') return (async () => {
    progress(10, 'fetching HyperFrames');
    const env = { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1' };
    let r = await sh('npx', ['--yes', 'hyperframes', '--version'], { timeout: 300000, env });
    if (!r.ok) throw new Error('Could not fetch HyperFrames: ' + r.err.slice(-160));
    progress(55, 'finding a Chrome to render with');
    r = await sh('npx', ['--yes', 'hyperframes', 'browser', 'ensure'], { timeout: 600000, env });
    if (!r.ok) throw new Error('HyperFrames could not get a Chrome: ' + r.err.slice(-160));
    const cfg = readConfig(); cfg.motionReady = true; writeConfig(cfg);
  })();

  // Birch as a tool inside Claude Code and Codex, with the full path so it works
  // even when the birch command isn't on PATH yet
  if (step === 'mcp') return (async () => {
    const cmd = path.join(ROOT, 'bin', 'birch');
    const claude = LLM.bin('claude'), codex = LLM.bin('codex');
    if (!claude && !codex) throw new Error('Install Claude Code or Codex first.');
    const errors = [];
    if (claude) {
      const r = await sh(claude, ['mcp', 'add', '--scope', 'user', 'birch', '--', cmd, 'mcp'], { timeout: 30000 });
      if (!r.ok && !/already exists/i.test(r.err + r.out)) errors.push('Claude Code: ' + (r.err || r.out).slice(-160));
    }
    if (codex) {
      const r = await sh(codex, ['mcp', 'add', 'birch', '--', cmd, 'mcp'], { timeout: 30000 });
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
