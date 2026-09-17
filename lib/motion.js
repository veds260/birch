'use strict';
// Animated inserts: a real photo of something named, a number counting up, a
// headline, a website being shown. Each is an HTML composition in motion/ that
// HyperFrames renders on this machine into a transparent clip the renderer lays
// over the video. Nothing here needs an account or a key.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const KINDS = ['photo', 'stat', 'headline', 'site'];
const LENGTH = { photo: 2.8, stat: 2.6, headline: 2.6, site: 3.2 };
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(p => fs.existsSync(p));

const run = (cmd, args, opts = {}) => new Promise(res => execFile(cmd, args, { maxBuffer: 1 << 24, ...opts },
  (err, out, errOut) => res({ ok: !err, out: String(out || ''), err: String(errOut || (err && err.message) || '') })));

function py(script, cfg) {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', [path.join(__dirname, script)]);
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', c => { try { c === 0 ? resolve(JSON.parse(out)) : reject(new Error(err.slice(-200))); } catch (e) { reject(e); } });
    p.stdin.end(JSON.stringify(cfg));
  });
}

// the stuff the animation shows, gathered into its folder
async function gather(ins, dir) {
  if (ins.type === 'photo') {
    const r = await py('assets.py', { term: ins.term, out: path.join(dir, 'image.img') });
    if (!r.found) throw new Error(`no free picture of ${ins.term}`);
    // the extension tells the template whether it's a logo to show whole
    const ext = /\.(png|svg)/i.test(r.title) || /logo|coat_of_arms|seal|emblem/i.test(r.title) ? '.png' : '.jpg';
    const name = r.title.replace(/[^\w.-]+/g, '_').replace(/\.\w+$/, '') + ext;
    fs.renameSync(r.file, path.join(dir, name));
    const credit = [r.credit, r.licence].filter(Boolean).join(', ');
    return { src: name, credit: credit ? 'Photo: ' + credit + ', via Wikimedia Commons' : 'via Wikimedia Commons', caption: ins.caption || '' };
  }
  if (ins.type === 'site') {
    if (!CHROME) throw new Error('no Chrome to take the screenshot with');
    const url = /^https?:\/\//.test(ins.url) ? ins.url : 'https://' + ins.url;
    const shot = path.join(dir, 'site.png');
    await run(CHROME, ['--headless=new', '--hide-scrollbars', '--disable-gpu', `--screenshot=${shot}`, '--window-size=1280,1600',
      '--virtual-time-budget=6000', `--user-data-dir=${path.join(require('os').tmpdir(), 'birch-shot')}`, url], { timeout: 45000 });
    if (!fs.existsSync(shot) || fs.statSync(shot).size < 5000) throw new Error('the site did not load');
    return { src: 'site.png', url };
  }
  if (ins.type === 'stat') return { value: String(ins.value), label: String(ins.label || '') };
  if (ins.type === 'headline') return { text: String(ins.text) };
  throw new Error('unknown insert ' + ins.type);
}

async function render(ins, { W = 1080, H = 1920, y = 0.3, workdir }) {
  if (!KINDS.includes(ins.type)) throw new Error('unknown insert ' + ins.type);
  const dir = path.join(workdir, `${ins.type}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  let html = fs.readFileSync(path.join(ROOT, 'motion', ins.type, 'index.html'), 'utf8');
  if (W !== 1080 || H !== 1920) {
    html = html.replace(/width: 1080px; height: 1920px/g, `width: ${W}px; height: ${H}px`)
      .replace(/data-width="1080" data-height="1920"/g, `data-width="${W}" data-height="${H}"`)
      .replace(/\* 1920\)/g, `* ${H})`);
  }
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  const seconds = Number(ins.seconds) || LENGTH[ins.type];
  const vars = { ...(await gather(ins, dir)), y, seconds };
  const out = path.join(dir, 'insert.mov');
  const r = await run('npx', ['--yes', 'hyperframes', 'render', dir, '--format', 'mov', '--quality', 'draft',
    '--variables', JSON.stringify(vars), '-o', out, '--quiet'],
    { timeout: 240000, env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1', HYPERFRAMES_NO_TELEMETRY: '1' } });
  if (!fs.existsSync(out)) throw new Error('the animation did not render: ' + (r.err || r.out).split('\n').filter(Boolean).slice(-1)[0]);
  return { file: out, seconds, vars };
}

module.exports = { render, KINDS, LENGTH };
