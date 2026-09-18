// Drives Birch over its own HTTP API, the way the setup page and the app do.
// Used by the Linux workflow so the test presses the same buttons a person would.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const HOME = process.env.BIRCH_DIR || path.join(process.env.GITHUB_WORKSPACE || process.cwd(), '.birch-home');
const PORT = Number(process.env.BIRCH_PORT) || 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(process.env.GITHUB_WORKSPACE || process.cwd(), 'out');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = async (method, p, body) => {
  const res = await fetch(BASE + p, body ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method });
  return res.json().catch(() => ({}));
};
const fail = m => { console.error('FAILED: ' + m); process.exit(1); };

async function up() {
  for (let i = 0; i < 60; i++) {
    try { const r = await api('GET', '/api/birch/ping'); if (r.birch) return; } catch {}
    if (i === 0) spawn(process.execPath, [path.join(HOME, 'server.js')], { cwd: HOME, detached: true, stdio: 'ignore', env: { ...process.env, PORT: String(PORT) } }).unref();
    await sleep(2000);
  }
  fail('the server never came up');
}

async function task(id, label, minutes = 25) {
  const end = Date.now() + minutes * 60000;
  let last = '';
  while (Date.now() < end) {
    const t = (await api('GET', '/api/tasks')).find?.(x => x.id === id) || (await api('GET', '/api/tasks')).filter(x => x.id === id)[0];
    if (t) {
      if (t.note && t.note !== last) { last = t.note; console.log(`   ${label}: ${t.note}`); }
      if (t.stage === 'error') fail(`${label}: ${t.note}`);
      if (t.stage === 'done') return t;
    }
    await sleep(4000);
  }
  fail(`${label} took too long`);
}

async function setup() {
  await up();
  for (const step of ['tools', 'model', 'vision']) {
    const t0 = Date.now();
    const r = await api('POST', '/api/birch/setup/run', { step });
    if (!r.task) fail(`${step} did not start: ${r.error}`);
    await task(r.task, step);
    console.log(`   ${step}: done in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  const st = await api('GET', '/api/birch/setup');
  console.log('   ready:', st.ready, JSON.stringify(Object.fromEntries(Object.entries(st.steps).map(([k, v]) => [k, v.done]))));
  if (!st.ready) fail('setup says it is not ready');
}

async function cut(file) {
  await up();
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const imp = await api('POST', '/api/importPath', { file });
  if (!imp.id) fail('import refused: ' + JSON.stringify(imp));
  for (;;) {
    const j = await api('GET', '/api/job?id=' + imp.id);
    if (j.stage === 'error') fail('ingest: ' + j.error);
    if (j.stage === 'done') break;
    await sleep(3000);
  }
  console.log(`   transcribed in ${Math.round((Date.now() - t0) / 1000)}s`);

  const dir = path.join(HOME, 'projects', imp.id);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  const kept = (m.words || []).filter(w => w.keep !== false).length;
  console.log(`   words: ${(m.words || []).length}, kept ${kept}, pauses ${(m.silences || []).length}, retakes ${(m.retakes || []).length}`);
  if (kept < 20) fail('almost nothing was transcribed');

  // the vision pass runs on its own after ingest
  for (let i = 0; i < 60; i++) {
    const t = (await api('GET', '/api/tasks')).filter(x => x.project === imp.id && x.type === 'vision').pop();
    if (t && (t.stage === 'done' || t.stage === 'error')) { console.log('   vision: ' + (t.note || t.stage)); break; }
    await sleep(4000);
  }
  const lines = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  const fresh = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  console.log(`   vision.jsonl ${lines('vision.jsonl')} lines, talkers.jsonl ${lines('talkers.jsonl')} lines, speaker ${(fresh.speaker || []).length} points`);
  if (!lines('vision.jsonl')) fail('no faces file was written');
  if (!(fresh.speaker || []).length) fail('no speaker was found');

  const settings = { ...(fresh.settings || {}), aspect: '9:16', captions: true, capStyle: 'minimal', gapMax: 0.5, normalize: true, styleChosen: true };
  await api('POST', '/api/settings', { id: imp.id, settings });
  const t1 = Date.now();
  await api('POST', '/api/render', { id: imp.id, settings });
  const ex = await new Promise(async resolve => {
    for (;;) {
      const t = (await api('GET', '/api/tasks')).filter(x => x.project === imp.id && x.type === 'export').pop();
      if (t && (t.stage === 'done' || t.stage === 'error')) return resolve(t);
      await sleep(4000);
    }
  });
  if (ex.stage === 'error') fail('render: ' + ex.note);
  const out = path.join(dir, 'final.mp4');
  const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
  console.log(`   rendered in ${Math.round((Date.now() - t1) / 1000)}s, ${(size / 1e6).toFixed(1)} MB, review: ${ex.note}`);
  if (size < 200000) fail('the export is too small to be a video');
  fs.copyFileSync(out, path.join(OUT, 'final.mp4'));
  // whichever ffmpeg the install ended up with, which on Windows is one Birch fetched
  let ff = 'ffmpeg';
  try { ff = require(path.join(HOME, 'lib', 'bin.js')).FFMPEG; } catch {}
  await new Promise(r => execFile(ff, ['-v', 'error', '-y', '-ss', '3', '-i', out, '-frames:v', '1', path.join(OUT, 'frame.png')], () => r()));
  console.log('   all good');
}

const [what, arg] = process.argv.slice(2);
(what === 'setup' ? setup() : cut(arg)).catch(e => fail(e.message));
