'use strict';
// The thinking parts of Birch run on the user's own subscription, through whichever
// CLI they're signed in to: Claude Code (Claude plan) or Codex (ChatGPT plan).
// No API keys, nothing billed to anyone else.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, '.birch.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
const writeConfig = c => { try { fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2)); } catch {} };
const AUTH_FAIL = /not logged in|please run \/login|login required|unauthori[sz]ed|\b401\b|could not be refreshed|sign in again|log out and sign in|invalid api key|authentication/i;
// a CLI can say it's signed in while its saved session has expired, so a real
// failure marks it signed out until a sign-in or a successful call clears it
function markAuth(which, broken) {
  const c = readConfig(); c.aiBroken = c.aiBroken || {};
  if (!!c.aiBroken[which] === broken) return;
  if (broken) c.aiBroken[which] = Date.now(); else delete c.aiBroken[which];
  writeConfig(c); cache.at = 0;
}

// a server started from Finder or a launcher may not carry the shell PATH
const PLACES = [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.npm-global/bin')];
function bin(name) {
  for (const d of PLACES) { const p = path.join(d, name); if (fs.existsSync(p)) return p; }
  return null;
}
const run = (cmd, args, opts = {}) => new Promise(res => execFile(cmd, args, { timeout: 20000, maxBuffer: 1 << 22, ...opts },
  (err, out, errOut) => res({ ok: !err, code: err && err.code, out: String(out || ''), err: String(errOut || '') })));

let cache = { at: 0, value: null };
async function status(fresh = false) {
  if (!fresh && cache.value && Date.now() - cache.at < 60000) return cache.value;
  const claude = bin('claude'), codex = bin('codex');
  const out = { claude: { installed: !!claude, loggedIn: false, plan: null }, codex: { installed: !!codex, loggedIn: false, plan: null } };
  if (claude) {
    const r = await run(claude, ['auth', 'status', '--json']);
    try { const j = JSON.parse(r.out); out.claude.loggedIn = !!j.loggedIn; out.claude.plan = !j.loggedIn ? null : j.authMethod === 'claude.ai' ? 'Claude subscription' : (j.authMethod === 'console' ? 'Anthropic API' : j.authMethod || null); } catch {}
  }
  if (codex) {
    const r = await run(codex, ['login', 'status']);
    const text = (r.out + r.err).trim();
    out.codex.loggedIn = r.ok && /logged in/i.test(text) && !/not logged in/i.test(text);
    out.codex.plan = /chatgpt/i.test(text) ? 'ChatGPT subscription' : (/api key/i.test(text) ? 'OpenAI API key' : null);
  }
  const cfg = readConfig();
  for (const k of ['claude', 'codex']) if (cfg.aiBroken && cfg.aiBroken[k]) { out[k].loggedIn = false; out[k].expired = true; }
  const want = cfg.ai;
  out.active = (want && out[want] && out[want].loggedIn) ? want : (out.claude.loggedIn ? 'claude' : (out.codex.loggedIn ? 'codex' : null));
  cache = { at: Date.now(), value: out };
  return out;
}

function tail(s, n = 220) { return String(s || '').trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(-n); }

// One prompt in, the model's final text out. Images are file paths the model may look at.
async function ask(prompt, { images = [], timeout = 300000 } = {}) {
  const st = await status();
  const which = st.active;
  if (!which) {
    const hint = st.claude.installed || st.codex.installed
      ? 'Sign in to Claude or ChatGPT on the Birch setup page.'
      : 'Install Claude Code or Codex and sign in on the Birch setup page.';
    throw new Error('No AI connected. ' + hint);
  }
  if (which === 'claude') {
    const args = ['-p', '--output-format', 'text'];
    if (images.length) args.push('--allowedTools', 'Read', '--add-dir', ...[...new Set(images.map(f => path.dirname(f)))]);
    return pipe(bin('claude'), args, prompt, timeout).then(r => {
      const why = tail(r.out + '\n' + r.err);
      if (!r.ok) { if (AUTH_FAIL.test(why)) markAuth('claude', true); throw new Error('Claude: ' + friendly(why)); }
      markAuth('claude', false);
      return r.out;
    });
  }
  const outFile = path.join(os.tmpdir(), `birch-codex-${process.pid}-${Date.now()}.txt`);
  const args = ['exec', '--skip-git-repo-check', '-s', 'read-only', '-o', outFile];
  for (const f of images) args.push('-i', f);
  args.push('-');
  const r = await pipe(bin('codex'), args, prompt, timeout);
  let text = '';
  try { text = fs.readFileSync(outFile, 'utf8'); fs.rmSync(outFile, { force: true }); } catch {}
  if (!r.ok || !text.trim()) {
    const why = tail(r.err + '\n' + r.out, 400);
    if (AUTH_FAIL.test(why)) markAuth('codex', true);
    throw new Error('ChatGPT: ' + friendly(why));
  }
  markAuth('codex', false);
  return text;
}

function friendly(msg) {
  if (AUTH_FAIL.test(msg)) return 'signed out or the sign-in expired. Sign in again on the Birch setup page.';
  if (/usage limit|rate limit|quota/i.test(msg)) return 'your plan\'s usage limit is reached for now. Try again later.';
  return msg || 'no answer came back';
}

function pipe(cmd, args, input, timeout) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { env: { ...process.env, PATH: [...PLACES, process.env.PATH].join(':') } });
    let out = '', err = '', done = false;
    const finish = r => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { p.kill('SIGTERM'); finish({ ok: false, out, err: err + '\ntook too long' }); }, timeout);
    p.stdout.on('data', d => { out += d; if (out.length > 4e6) out = out.slice(-4e6); });
    p.stderr.on('data', d => { err += d; if (err.length > 1e5) err = err.slice(-1e5); });
    p.on('error', e => finish({ ok: false, out, err: e.message }));
    p.on('close', c => finish({ ok: c === 0, out, err }));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

// Browser sign-in, started from the setup page. Both CLIs open the sign-in page
// themselves and wait for it to finish.
const logins = new Map();
function login(which) {
  if (logins.has(which)) return logins.get(which);
  const cmd = bin(which);
  if (!cmd) return Promise.reject(new Error((which === 'claude' ? 'Claude Code' : 'Codex') + ' isn\'t installed yet.'));
  const args = which === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'];
  const job = new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, PATH: [...PLACES, process.env.PATH].join(':') } });
    let text = '';
    const grab = d => {
      text += d;
      // if the CLI couldn't open a browser itself, open the link it printed
      const m = String(d).match(/https:\/\/\S+/);
      if (m && !job.opened) { job.opened = true; execFile('open', [m[0].replace(/[)\].,]+$/, '')], () => {}); }
    };
    p.stdout.on('data', grab); p.stderr.on('data', grab);
    const t = setTimeout(() => { p.kill('SIGTERM'); reject(new Error('Sign-in timed out. Press the button again.')); }, 10 * 60000);
    p.on('close', c => { clearTimeout(t); cache.at = 0; if (c === 0) { markAuth(which, false); resolve(); } else reject(new Error(tail(text) || 'Sign-in didn\'t finish.')); });
    p.stdin.end();
  }).finally(() => logins.delete(which));
  logins.set(which, job);
  return job;
}

// a tiny real prompt, so setup shows a working connection rather than a CLI that only says so
async function test(which) {
  const c = readConfig(); const prev = c.ai; c.ai = which; writeConfig(c); cache.at = 0;
  try { const out = await ask('Reply with the single word: ready', { timeout: 120000 }); return { ok: /ready/i.test(out), text: out.trim().slice(0, 40) }; }
  catch (e) { return { ok: false, error: e.message }; }
  finally { const c2 = readConfig(); if (prev === undefined) delete c2.ai; else c2.ai = prev; writeConfig(c2); cache.at = 0; }
}
function choose(which) { const c = readConfig(); c.ai = which; writeConfig(c); cache.at = 0; }

// the old callback shape, so call sites stay small
function call(prompt, opts, done) { ask(prompt, opts).then(out => done(null, out), err => done(err)); }

module.exports = { status, ask, call, login, test, choose, bin };
