'use strict';
// Birch: the local server. Loopback only, no dependencies.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const M = require('./lib/media');
const SUG = require('./lib/suggest');
const FLOW = require('./lib/flow');
const SHOTS = require('./lib/shots');
const EP = require('./lib/editprompt');
const ALIGN = require('./lib/align');
const VIS = require('./lib/vision');
const TALK = require('./lib/talkers');
const SETUP = require('./lib/setup');
const setupRuns = new Map();
const MOTION = require('./lib/motion');
const REVIEW = require('./lib/review');
const FIX = require('./lib/fixwords');
const FCP = require('./lib/fcpxml');
const HOOKS = require('./lib/hooks');

// the hook card has to be drawn at the shape the video will end up
const ASPECT_WH = (a, m) => (M.ASPECTS[a] || [m.width || 1080, m.height || 1920]);

// "A vintage microphone on a stand" -> "vintage microphone". The thing itself, so a
// real photo of it can be found and handed to the model as a reference.
function headNoun(desc) {
  const STOP = new Set(['a', 'an', 'the', 'one', 'two', 'some', 'his', 'her', 'their', 'its']);
  const words = String(desc).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  for (const w of words) {
    if (STOP.has(w) && !out.length) continue;
    // stop at the first word that starts describing what it is doing or where it is
    if (/^(with|on|in|at|against|over|under|beside|next|that|which|as|from|into|and|while|already|before|after|being|getting|dropping|printing|pressed|stuck|raised|floating|aimed|stamped)$/.test(w)) break;
    if (w.endsWith('ing') && out.length) break;
    out.push(w);
    if (out.length >= 2) break;
  }
  return out.join(' ').trim() || null;
}

// Where a full-frame graphic should sit so it does not land on the speaker's face.
// Read from the vision pass at that moment; falls back to the lower third.
// Where an overlay of a given height can sit without covering the speaker, as a
// centre y in the output frame. Uses the same crop the renderer will make.
function clearY(k, wordIdx, ownHeight = 0.22, prefer = 'below') {
  try {
    const m = meta(k);
    const w = m.words[wordIdx] || m.words[0];
    const t = w ? w.start : 0;
    const aspect = m.settings?.aspect;
    const letterbox = !!m.settings?.letterbox && !!M.ASPECTS[aspect];
    const [W, H] = M.ASPECTS[aspect] || [m.width, m.height];
    const geo = M.frameGeometry(m, W, H, letterbox);
    // letterboxed, the big words go in the bar above the picture
    if (geo.bandH < H) return Math.max(ownHeight / 2 + 0.02, geo.bandY / H / 2);
    let src = (m.speaker && m.speaker.length) ? m.speaker.map(x => ({ t: x.t, box: x.box })) : null;
    if (!src) src = VIS.load(path.join(pdir(k), 'vision.jsonl')).filter(r => r.faces && r.faces.length)
      .map(r => ({ t: r.t, box: r.faces.slice().sort((a, b) => (b[2]-b[0])*(b[3]-b[1]) - (a[2]-a[0])*(a[3]-a[1]))[0] }));
    const faces = M.frameFaces({ words: m.words, silences: m.silences, wav: path.join(pdir(k), 'audio.wav'),
      gapMax: m.settings?.gapMax ?? 0.5, info: m, aspect, letterbox, faces: src });
    const near = faces.map(f => ({ d: Math.abs(f.t - t), box: f.box })).sort((a, b) => a.d - b.d)[0];
    if (!near || near.d > 3) return 0.62;
    const [, top, , bottom] = near.box;
    // on the chest, just under the chin, clear of the mouth; a headline tries above the head first
    const above = top - 0.03 - ownHeight > 0.04 ? top - 0.03 - ownHeight / 2 : null;
    if (prefer === 'above' && above !== null) return above;
    if (bottom + 0.05 + ownHeight < 0.94) return Math.max(0.5, bottom + 0.05 + ownHeight / 2);
    if (above !== null) return above;
    return 0.8;
  } catch (e) { return 0.62; }
}
const TWITTER_KEY = process.env.TWITTERAPI_KEY || '';

const runPy = (script, cfg) => new Promise((resolve, reject) => {
  const pr = require('child_process').spawn(require('./lib/bin').python(), [path.join(__dirname, 'lib', script)],
    { env: { ...process.env, TWITTERAPI_KEY: TWITTER_KEY } });
  let out = '', err = '';
  pr.stdout.on('data', d => out += d);
  pr.stderr.on('data', d => err += d);
  pr.on('error', reject);
  pr.on('close', c => c === 0 ? resolve(JSON.parse(out))
    : reject(new Error(err.trim().split('\n').pop() || 'failed')));
  pr.stdin.write(JSON.stringify(cfg));
  pr.stdin.end();
});

const PORT = Number(process.env.PORT) || 8796;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const PROJECTS = path.join(ROOT, 'projects');
fs.mkdirSync(PROJECTS, { recursive: true });

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|aac)$/i;
const BROWSE_DIRS = ['Desktop', 'Downloads', 'Movies', 'Documents']
  .map(d => path.join(os.homedir(), d)).filter(d => fs.existsSync(d));

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readJson = req => new Promise((resolve, reject) => {
  let d = '';
  req.on('data', c => { d += c; if (d.length > 2e7) { req.destroy(); reject(new Error('too large')); } });
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
});

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'clip';
const pdir = id => path.join(PROJECTS, id);
const mpath = id => path.join(pdir(id), 'project.json');
const meta = id => JSON.parse(fs.readFileSync(mpath(id), 'utf8'));
// Nothing owns the screen for longer than its kind is allowed. The render
// already enforced this, but the stored value disagreed with what you saw,
// so a tweet read dur=8 while the export showed 3.5.
const HOLD = { pop: 1.4, hook: 3.5, card: 3.0, tweet: 3.5, image: 3.0, broll: 6.0, motion: 4.0 };
function capHolds(m) {
  for (const o of (m.overlays || [])) {
    const lim = (o.type === 'pop' && o.kind === 'namecard') ? HOLD.hook : (HOLD[o.type] ?? 3);
    if (!(o.dur > 0) || o.dur > lim) o.dur = Math.min(o.dur || lim, lim);
  }
  return m;
}
const saveMeta = (id, m) => fs.writeFileSync(mpath(id), JSON.stringify(capHolds(m), null, 2));
const safeId = id => /^[a-z0-9-]+$/i.test(String(id)) && fs.existsSync(mpath(id));

const jobs = new Map();               // project id -> import progress, which does block
// Long work gets its own task so you can keep editing while it runs. Keyed
// separately because a project can have an export and a Flow clip going at once.
const tasks = new Map();
let taskSeq = 0;
function newTask(type, project, label) {
  const id = `t${++taskSeq}`;
  tasks.set(id, { id, type, project, label, stage: 'running', pct: 0, note: '', started: Date.now() });
  return id;
}
const setTask = (id, p) => { const t = tasks.get(id); if (t) Object.assign(t, p); };
function sweepTasks() {
  const now = Date.now();
  for (const [id, t] of tasks)
    if (t.stage !== 'running' && now - (t.ended || now) > 10 * 60 * 1000) tasks.delete(id);
}
const procs = new Map();              // id -> child process, so we can cancel
const setJob = (id, j) => jobs.set(id, Object.assign(jobs.get(id) || {}, j));

function listProjects() {
  return fs.readdirSync(PROJECTS).filter(d => fs.existsSync(mpath(d)))
    .map(d => { const m = meta(d);
      return { id: d, name: m.name, created: m.created, duration: m.duration || 0,
        words: (m.words || []).length, rendered: !!m.rendered, linked: !!m.linked }; })
    .sort((a, b) => b.created - a.created);
}

// who is talking, from mouth movement against the audio. Cached per project.
const speakerRuns = new Map();
function findSpeaker(id) {
  if (speakerRuns.has(id)) return speakerRuns.get(id);
  const job = (async () => {
    const m = meta(id);
    const file = path.join(pdir(id), 'talkers.jsonl');
    const frames = fs.existsSync(file) && fs.statSync(file).size > 0 ? TALK.load(file) : await TALK.scan(m.src, file);
    const speech = ALIGN.islands(m.silences || [], m.duration || 0);
    const cur = meta(id);
    cur.speaker = TALK.speakerPath(frames, speech, cur.cuts || []);
    saveMeta(id, cur);
    return cur.speaker;
  })().catch(() => []).finally(() => setTimeout(() => speakerRuns.delete(id), 1000));
  speakerRuns.set(id, job);
  return job;
}

const DIR = require('./lib/director');
const directRuns = new Map();
function startDirect(id) {
  if (directRuns.has(id)) return directRuns.get(id).tid;
  const tid = newTask('direct', id, 'Reading the clip');
  setTask(tid, { note: 'Working out who is talking and what goes on screen' });
  const job = (async () => {
    if (visionRuns.has(id)) await visionRuns.get(id);
    const m = meta(id);
    let formats = [];
    try { formats = JSON.parse(fs.readFileSync(path.join(ROOT, 'refs', 'templates.json'), 'utf8')); } catch {}
    const d = await DIR.direct(m, VIS.load(path.join(pdir(id), 'vision.jsonl')), formats, path.join(pdir(id), 'look'));
    const cur = meta(id); cur.direction = d; delete cur.directionError; saveMeta(id, cur);
    setTask(tid, { stage: 'done', pct: 100, ended: Date.now(),
      note: (d.speaker.name ? `${d.speaker.name} is talking` : 'no name in the clip') + (d.format ? `, ${d.format} format` : '') });
  })().catch(e => {
    const cur = meta(id); cur.directionError = e.message; saveMeta(id, cur);
    setTask(tid, { stage: 'error', note: e.message.slice(0, 160), ended: Date.now() });
  }).finally(() => directRuns.delete(id));
  directRuns.set(id, { tid, job });
  return tid;
}

const visionRuns = new Map();
function runVision(id) {
  const m = meta(id);
  const out = path.join(pdir(id), 'vision.jsonl');
  const tid = newTask('vision', id, 'Looking at the footage');
  setTask(tid, { note: 'Faces, shots, on-screen text, one frame a second' });
  const job = Promise.all([VIS.analyse(m.src, out, n => setTask(tid, { note: `Looked at ${n} seconds` })), VIS.cuts(m.src)])
    .then(async ([log, cutTimes]) => {
      const cur = meta(id); cur.vision = VIS.summary(log, cutTimes); cur.cuts = cutTimes; saveMeta(id, cur);
      setTask(tid, { note: 'Working out who is talking' });
      const sp = await findSpeaker(id);
      const people = new Set(sp.map(x => x.who)).size;
      setTask(tid, { stage: 'done', pct: 100, ended: Date.now(), note: `${cur.vision.withFace}s with a face, ${people ? 'speaker found' : 'no speaker found'}, ${cutTimes.length} shot changes` });
    }).catch(e => setTask(tid, { stage: 'error', note: e.message.slice(0, 160), ended: Date.now() }))
    .finally(() => visionRuns.delete(id));
  visionRuns.set(id, job);
  return tid;
}

// the speaker's face over time, for anything that frames or dodges it. Waits for a
// scan still running, and runs one for projects made before speakers were tracked.
async function speakerFaces(id) {
  if (visionRuns.has(id)) await visionRuns.get(id);
  let m = meta(id);
  if (!m.speaker && m.src && fs.existsSync(m.src)) { await findSpeaker(id); m = meta(id); }
  if (m.speaker && m.speaker.length) return m.speaker.map(x => ({ t: x.t, box: x.box }));
  const visLog = VIS.load(path.join(pdir(id), 'vision.jsonl'));
  return visLog.filter(r => r.faces && r.faces.length)
    .map(r => ({ t: r.t, box: r.faces.slice().sort((a, b) => (b[2]-b[0])*(b[3]-b[1]) - (a[2]-a[0])*(a[3]-a[1]))[0] }));
}

async function ingest(id) {
  const m = meta(id);
  try {
    setJob(id, { stage: 'reading', pct: 0, note: '' });
    const info = await M.probe(m.src);
    if (!info.hasAudio) throw new Error('That file has no audio track, so there is nothing to transcribe.');
    Object.assign(m, info); saveMeta(id, m);

    // a header at the back of the file makes the browser fetch the tail before it can
    // show frame one, and some builds never get there. Put it at the front, no re-encode.
    if (/\.(mp4|m4v|mov)$/i.test(m.src)) {
      const fast = path.join(pdir(id), 'source-fast.mp4');
      await new Promise(r => execFile(require('./lib/bin').FFMPEG, ['-y', '-loglevel', 'error', '-i', m.src,
        '-c', 'copy', '-movflags', '+faststart', fast], () => r()));
      if (fs.existsSync(fast) && fs.statSync(fast).size > 1000) { m.play = fast; saveMeta(id, m); }
    }
    setJob(id, { stage: 'extracting', pct: 0, note: 'Pulling the audio out' });
    const wav = path.join(pdir(id), 'audio.wav');
    await M.extractAudio(m.src, wav);

    setJob(id, { stage: 'transcribing', pct: 0,
      note: 'Runs on your machine, so it takes about a tenth of the clip length' });
    const words = await M.transcribe(wav, path.join(pdir(id), 'transcript'),
      p => setJob(id, { pct: p }), pr => procs.set(id, pr));
    procs.delete(id);

    setJob(id, { stage: 'transcribing', pct: 99, note: 'Finding the pauses' });
    const heard = await M.detectSilence(wav);
    setJob(id, { stage: 'transcribing', pct: 99, note: 'Lining every word up with the audio' });
    const seated = await ALIGN.seat(words, heard, m.duration, wav, { whisper: M.whisper(), model: M.MODEL });
    m.words = seated.words;
    m.silences = ALIGN.foldBlips(heard, seated.orphans);

    // Propose the obvious cuts up front, so the first render is already tighter
    // than the source instead of a straight copy of it. All reversible in the UI.
    m.retakes = M.findRetakes(m.words);
    let dropped = 0;
    for (const r of m.retakes) {
      for (let i = r.a; i < r.b; i++) { m.words[i].keep = false; m.words[i].retake = true; dropped++; }
    }
    for (const w of m.words) if (w.filler) { w.keep = false; dropped++; }
    m.autoCut = { words: dropped, retakes: m.retakes.length, silences: m.silences.length,
      dead: +(m.silences.reduce((s, x) => s + (x.end - x.start), 0)).toFixed(1) };
    m.settings = Object.assign({ gapMax: 0.5 }, m.settings || {});
    saveMeta(id, m);
    setJob(id, { stage: 'done', pct: 100, note: '' });
    // the vision pass runs after, as a task, so the editor opens while it works,
    // then Birch reads the clip once it knows what is on screen
    runVision(id);
    if (process.env.BIRCH_NO_CLAUDE !== '1') startDirect(id);
  } catch (e) {
    procs.delete(id);
    setJob(id, { stage: 'error', error: e.message });
  }
}

function newProject(name, src, linked) {
  const id = `${Date.now().toString(36)}-${slug(name)}`;
  fs.mkdirSync(pdir(id), { recursive: true });
  saveMeta(id, { id, name, created: Date.now(), src, linked: !!linked, words: [] });
  return id;
}


// Every way of asking for an edit ends up here: typed instruction, a format, a
// rerun. One applier, so a new kind of move only has to be taught once.
async function applyOps(k, ops) {
  const cur = meta(k); cur.overlays = cur.overlays || []; cur.lists = cur.lists || []; cur.reframes = cur.reframes || [];
  const done = [];
  const dir = path.join(pdir(k), 'stickers'); fs.mkdirSync(dir, { recursive: true });
  const W = ASPECT_WH(cur.settings?.aspect, cur);
  for (const op of ops) {
    try {
      if (op.op === 'title') {
        const oid = 'hk' + Date.now().toString(36) + done.length, file = path.join(dir, oid + '.png');
        const ti = await runPy('titleblock.py', { width: W[0], height: W[1], out: file, headline: op.headline || '', subline: op.subline || '',
          face: op.face || 'ultra', accent: op.accent || '#F5E31C', upper: op.upper !== false, top: 0.06, headSize: Math.round(W[1] * 0.062) });
        cur.overlays.unshift({ id: oid, type: 'hook', file, word: EP.wordAt(cur.words, op.at), dur: Number(op.seconds) || 4,
          scale: ti.scale, x: ti.x, y: ti.y, ar: ti.h / ti.w, behind: !!op.behind, label: (op.headline || op.subline || 'Title').slice(0, 44) });
        done.push(`title "${op.headline}" at ${op.at}`);
      } else if (op.op === 'card') {
        const oid = 'cd' + Date.now().toString(36) + done.length, file = path.join(dir, oid + '.png');
        await runPy('card.py', { width: W[0], height: W[1], out: file, headline: op.headline, lines: op.lines, body: op.body, highlight: op.highlight, band: op.band || null });
        cur.overlays.push({ id: oid, type: 'card', file, word: EP.wordAt(cur.words, op.at), dur: Number(op.seconds) || 4, scale: 1, x: 0, y: 0,
          label: 'Card: ' + (op.headline || (op.lines || [])[0] || 'text').slice(0, 40) });
        done.push(`card at ${op.at}`);
      } else if (op.op === 'list') {
        const ats = Array.isArray(op.at) ? op.at : [op.at];
        cur.lists.push({ id: 'ls' + Date.now().toString(36) + done.length, look: op.look || 'plain', numbered: true, x: .06, y: .10, face: 'clean',
          lines: (op.lines || []).map((text, i) => ({ text, word: EP.wordAt(cur.words, ats[i] || ats[ats.length - 1]) })) });
        done.push(`list of ${(op.lines || []).length}`);
      } else if (op.op === 'reframe') {
        cur.reframes.push({ id: 'rf' + Date.now().toString(36) + done.length, word: EP.wordAt(cur.words, op.at), dur: Number(op.seconds) || 6,
          corner: op.corner || 'bl', layout: op.corner === 'split' ? 'split' : undefined, scale: Number(op.scale) || .42 });
        done.push(`shrink speaker at ${op.at}`);
      } else if (op.op === 'cut') {
        const a = EP.wordAt(cur.words, op.from), b = EP.wordAt(cur.words, op.to);
        for (let i = a; i < b; i++) cur.words[i].keep = false;
        done.push(`cut ${op.from} to ${op.to}`);
      } else if (op.op === 'captions') {
        cur.settings = { ...(cur.settings || {}), captions: op.on !== false, capStyle: op.style || cur.settings?.capStyle || 'minimal', styleChosen: true,
          capDynamic: op.dynamic !== undefined ? !!op.dynamic : cur.settings?.capDynamic, capBehind: op.behind !== undefined ? !!op.behind : cur.settings?.capBehind };
        done.push(`captions ${op.style || ''}`);
      } else if (op.op === 'shape') {
        cur.settings = { ...(cur.settings || {}), aspect: op.aspect }; done.push(`shape ${op.aspect}`);
      } else if (op.op === 'cow') {
        cur.cows = cur.cows || []; cur.cows.push({ id: 'cw' + Date.now().toString(36) + done.length, word: EP.wordAt(cur.words, op.at), dur: Number(op.seconds) || 0.7 });
        done.push(`purple cow at ${op.at}`);
      } else if (op.op === 'spotlight') {
        cur.spots = cur.spots || []; cur.spots.push({ id: 'sp' + Date.now().toString(36) + done.length, word: EP.wordAt(cur.words, op.at), dur: Number(op.seconds) || 3,
          x: op.x ?? .1, y: op.y ?? .3, w: op.w ?? .8, h: op.h ?? .3 });
        done.push(`spotlight at ${op.at}`);
      } else if (op.op === 'section') {
        cur.sections = cur.sections || [];
        const sec = { id: 'sc' + Date.now().toString(36) + done.length,
          from: EP.wordAt(cur.words, op.from), to: EP.wordAt(cur.words, op.to) };
        if (op.captions !== undefined) sec.captions = !!op.captions;
        if (op.grade) sec.grade = op.grade;
        if (op.letterbox !== undefined) sec.letterbox = !!op.letterbox;
        cur.sections.push(sec);
        done.push(`section ${op.from}-${op.to}`);
      } else if (op.op === 'grade') {
        cur.settings = { ...(cur.settings || {}), grade: op.name || null }; done.push(`grade ${op.name}`);
      } else if (op.op === 'letterbox') {
        cur.settings = { ...(cur.settings || {}), letterbox: op.on !== false }; done.push('letterbox');
      } else if (['pop', 'cloud', 'gradient', 'comment'].includes(op.op)) {
        const oid = 'pp' + Date.now().toString(36) + done.length, file = path.join(dir, oid + '.png');
        const wIdx = EP.wordAt(cur.words, op.at);
        const yFor = op.op === 'comment' ? 0.62 : clearY(k, wIdx, op.op === 'pop' ? 0.20 : 0.26);
        await runPy('pop.py', { kind: op.op, text: op.text, sub: op.sub, words: op.words, handle: op.handle, face: op.face,
          y: yFor, tight: false, width: W[0], height: W[1], out: file });
        cur.overlays.push({ id: oid, type: 'pop', kind: op.op, file, word: wIdx,
          dur: Number(op.seconds) || (op.op === 'pop' ? 1.2 : op.op === 'comment' ? 4 : 3),
          scale: 1, x: 0, y: 0, ar: (W[1] / W[0]), behind: !!op.behind, label: (op.op + ': ' + (op.text || (op.words || []).join(' '))).slice(0, 44) });
        done.push(`${op.op} at ${op.at}`);
      } else if (op.op === 'shot') {
        cur.shots = cur.shots || []; const n = cur.shots.length + 1;
        cur.shots.push({ n, word: EP.wordAt(cur.words, op.at), text: '', onScreen: op.line, object: op.object, secs: Number(op.seconds) || 4,
          prompt: `Vertical 9:16 portrait video, ${Number(op.seconds) || 4} seconds. Pure black (#0D0D0D) with subtle film grain background. ${op.object}, on the left third of frame, snapping in from blur with a hard bounce, then holds. Simultaneously, bold white grotesque text stamps in at center right: "${op.line}". No other text, no captions, no logos, no watermark. A dramatic bass-thud sound hit on the reveal. Camera: completely static. Transition out: hard cut.`, by: 'prompt' });
        done.push(`shot "${op.line}" at ${op.at}`);
      } else if (op.op === 'asset') {
        const oid = 'as' + Date.now().toString(36) + done.length, file = path.join(dir, oid + '.jpg');
        const info = await runPy('assets.py', { term: op.term, out: file });
        if (!info.found) { done.push(`no free picture of ${op.term}`); }
        else {
          const dim = await M.probe(file).catch(() => ({ width: 1200, height: 800 }));
          cur.overlays.push({ id: oid, type: 'image', file, word: EP.wordAt(cur.words, op.at),
            dur: Number(op.seconds) || 3, scale: 0.62, auto: true,
            ar: (dim.height || 800) / (dim.width || 1200), credit: info.credit, licence: info.licence,
            label: op.term + ' · ' + (info.licence || 'CC') });
          done.push(`picture of ${op.term} at ${op.at}`);
        }
      } else if (op.op === 'tweet') {
        const oid = 'tw' + Date.now().toString(36) + done.length, file = path.join(dir, oid + '.png');
        const info = await runPy('tweetcard.py', { tweet: op.url, out: file, width: 1000, dark: true });
        cur.overlays.push({ id: oid, type: 'tweet', file, word: EP.wordAt(cur.words, op.at), dur: 3.5, scale: .78, slot: op.slot || undefined, label: '@' + info.author + ' · ' + info.text.slice(0, 44) });
        done.push(`tweet at ${op.at}`);
      }
    } catch (e) { done.push(`could not do ${op.op}: ${e.message.slice(0, 60)}`); }
  }
  saveMeta(k, cur);
  return done;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}`);
  const p = u.pathname;
  const id = u.searchParams.get('id');
  try {
    // setup: what's missing, fix it from the browser, and the GitHub star and follow
    if (req.method === 'GET' && p === '/api/birch/ping') return send(res, 200, { birch: true, dir: ROOT, pid: process.pid });
    if (req.method === 'GET' && p === '/api/birch/setup') return send(res, 200, { ...(await SETUP.status()), running: Object.fromEntries(setupRuns) });
    if (req.method === 'POST' && p === '/api/birch/setup/github') {
      const { login, click } = await readJson(req);
      return send(res, 200, click ? await SETUP.starAndFollow() : await SETUP.checkGithub(login));
    }
    if (req.method === 'POST' && p === '/api/birch/setup/run') {
      const { step } = await readJson(req);
      // pressing a button twice, or reloading mid-download, joins the run already going
      const live = setupRuns.get(step);
      if (live) return send(res, 200, { ok: true, task: live, step, joined: true });
      const tid = newTask('setup', null, 'Setup: ' + step);
      setupRuns.set(step, tid);
      setTask(tid, { note: 'starting' });
      SETUP.run(step, (pct, note) => setTask(tid, { ...(pct != null ? { pct } : {}), ...(note ? { note: String(note).slice(0, 160) } : {}) }))
        .then(() => setTask(tid, { stage: 'done', pct: 100, ended: Date.now(), note: 'done' }))
        .catch(e => setTask(tid, { stage: 'error', ended: Date.now(), note: e.message.slice(0, 240) }))
        .finally(() => setupRuns.delete(step));
      return send(res, 200, { ok: true, task: tid, step });
    }
    // nothing gets imported or rendered until the star and follow are in
    if (req.method === 'POST' && ['/api/import', '/api/importPath', '/api/render', '/api/birch/direct'].includes(p) && !SETUP.readConfig().github) {
      req.resume();
      return send(res, 403, { error: 'Finish setup first: star Birch on GitHub and follow @veds260.', setup: `http://${HOST}:${PORT}/birch` });
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const desk = path.join(ROOT, 'public/index.html');
      if (!fs.existsSync(desk)) { res.writeHead(302, { Location: '/birch' }); return res.end(); }
      return send(res, 200, fs.readFileSync(desk), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && /^\/styles\/[a-z]+\.png$/.test(p)) {
      const f = path.join(ROOT, 'public', p);
      if (!fs.existsSync(f)) return send(res, 404, { error: 'no sample' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=300' });
      return fs.createReadStream(f).pipe(res);
    }

    if (req.method === 'GET' && /^\/(app\.js|style\.css)$/.test(p))
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', p.slice(1))),
        p.endsWith('.js') ? 'text/javascript' : 'text/css');

    if (req.method === 'GET' && p === '/api/projects') return send(res, 200, listProjects());

    /* ---------------- Birch ---------------- */
    // the Birch app and its art live under /birch, next to the old editor at /
    if (req.method === 'GET' && (p === '/birch' || p === '/birch/'))
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'public/birch/index.html')), 'text/html; charset=utf-8');
    if (req.method === 'GET' && /^\/birch\/[a-z0-9-]+\.(webp|webm|png|js|css)$/.test(p)) {
      const f = path.join(ROOT, 'public', p);
      if (!fs.existsSync(f)) return send(res, 404, { error: 'missing' });
      const ext = path.extname(f).slice(1);
      const type = { webp: 'image/webp', webm: 'video/webm', png: 'image/png', js: 'text/javascript', css: 'text/css' }[ext];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=3600' });
      return fs.createReadStream(f).pipe(res);
    }
    // the three music beds, so a channel keeps sounding like itself
    if (req.method === 'GET' && p === '/api/birch/beds') {
      const dir = path.join(ROOT, 'beds');
      const beds = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.wav')).map(f => ({ name: f.replace(/\.wav$/, ''), file: path.join(dir, f) })) : [];
      return send(res, 200, beds);
    }
    if (req.method === 'GET' && /^\/birch\/bed\/[a-z0-9-]+\.wav$/.test(p)) {
      const f = path.join(ROOT, 'beds', path.basename(p));
      if (!fs.existsSync(f)) return send(res, 404, { error: 'no bed' });
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method === 'GET' && /^\/birch\/sfx\/[a-z0-9_]+\.wav$/.test(p)) {
      const f = path.join(ROOT, 'sound', 'sfx', path.basename(p));
      if (!fs.existsSync(f)) return send(res, 404, { error: 'no sfx' });
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      return fs.createReadStream(f).pipe(res);
    }
    // a name card, drawn full frame at the project's own aspect so it lands where it was drawn
    if (req.method === 'POST' && p === '/api/birch/namecard') {
      const { id: k, word, seconds, name, role } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      if (!String(name || '').trim()) return send(res, 400, { error: 'a name card needs a name' });
      const m = meta(k);
      const dir = path.join(pdir(k), 'stickers'); fs.mkdirSync(dir, { recursive: true });
      const oid = 'nc' + Date.now().toString(36);
      const file = path.join(dir, oid + '.png');
      const W = ASPECT_WH(m.settings?.aspect, m);
      try { await runPy('namecard.py', { name, role, width: W[0], height: W[1], out: file }); }
      catch (e) { return send(res, 400, { error: e.message }); }
      m.overlays = m.overlays || [];
      m.overlays.push({ id: oid, type: 'pop', kind: 'namecard', by: 'birch', file, word: Number(word) || 0, dur: Number(seconds) || 3,
        scale: 1, x: 0, y: 0, ar: W[1] / W[0], label: 'Name card: ' + String(name).slice(0, 36) });
      saveMeta(k, m);
      return send(res, 200, { ok: true, overlays: m.overlays });
    }

    // everything Birch put on screen comes off before a plan is applied again, so re-exports never stack
    if (req.method === 'POST' && p === '/api/birch/clear') {
      const { id: k, format } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      const mine = (m.overlays || []).filter(o => o.by === 'birch');
      for (const o of mine) { try { fs.unlinkSync(o.file); } catch {} }
      m.overlays = (m.overlays || []).filter(o => o.by !== 'birch');
      // going back to plain captions takes the last format's moves off too
      if (format) {
        for (const key of ['overlays', 'lists', 'reframes', 'cows', 'spots']) m[key] = (m[key] || []).filter(o => o.by !== 'template');
        delete m.template;
        m.settings = { ...(m.settings || {}) }; delete m.settings.letterbox; delete m.settings.grade;
      }
      saveMeta(k, m);
      return send(res, 200, { ok: true, removed: mine.length });
    }

    // Birch reads the clip: who is talking, which format fits, what goes on screen
    if (req.method === 'POST' && p === '/api/birch/direct') {
      const { id: k, force } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      if (m.direction && !force) return send(res, 200, { ok: true, direction: m.direction });
      return send(res, 200, { ok: true, task: startDirect(k) });
    }
    // an animated insert: a real photo, a number, a headline, a website
    if (req.method === 'POST' && p === '/api/birch/insert') {
      const { id: k, insert } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      if (!insert || !MOTION.KINDS.includes(insert.type)) return send(res, 400, { error: 'unknown insert' });
      const m = meta(k);
      const [W, H] = ASPECT_WH(m.settings?.aspect, m);
      const wi = Math.max(0, Math.min((m.words || []).length - 1, Number(insert.word) || 0));
      const tall = { photo: 0.34, site: 0.4, stat: 0.2, headline: 0.16 }[insert.type];
      const y = clearY(k, wi, tall, insert.type === 'headline' ? 'above' : 'below');
      try {
        const r = await MOTION.render(insert, { W, H, y, workdir: path.join(pdir(k), 'motion') });
        const c = meta(k); c.overlays = c.overlays || [];
        const what = insert.term || insert.value || insert.text || insert.url || '';
        const ov = { id: 'mo' + Date.now().toString(36), type: 'motion', kind: insert.type, file: r.file, word: wi, dur: r.seconds,
          by: 'birch', scale: 1, x: 0, y: 0, ar: H / W, label: (insert.type + ': ' + what).slice(0, 44) };
        c.overlays.push(ov); saveMeta(k, c);
        return send(res, 200, { ok: true, overlay: ov, credit: r.vars.credit || null });
      } catch (e) { return send(res, 422, { error: e.message }); }
    }

    // a title over the opening seconds, tagged so a re-export replaces it
    if (req.method === 'POST' && p === '/api/birch/title') {
      const { id: k, text } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      if (!String(text || '').trim()) return send(res, 400, { error: 'no title' });
      const before = new Set((meta(k).overlays || []).map(o => o.id));
      const done = await applyOps(k, [{ op: 'title', at: '0:00', headline: String(text).slice(0, 60), face: 'ultra', seconds: 3, upper: true }]);
      const c = meta(k);
      (c.overlays || []).forEach(o => { if (!before.has(o.id)) o.by = 'birch'; });
      saveMeta(k, c);
      return send(res, 200, { ok: true, done });
    }
    if (req.method === 'GET' && p === '/api/birch/direction') {
      if (!safeId(id)) return send(res, 404, { error: 'not found' });
      const m = meta(id);
      const running = directRuns.has(id) || visionRuns.has(id);
      return send(res, 200, { running, direction: m.direction || null, error: m.directionError || null,
        speakerFound: !!(m.speaker && m.speaker.length) });
    }

    // how long the clip is before and after, using the same ranges the renderer cuts to
    if (req.method === 'GET' && p === '/api/birch/stats') {
      if (!safeId(id)) return send(res, 404, { error: 'not found' });
      const m = meta(id);
      const words = m.words || [];
      const rs = words.length ? M.ranges(words, { gapMax: m.settings?.gapMax ?? 0.5, silences: m.silences || [], wav: path.join(pdir(id), 'audio.wav') }) : [];
      const kept = rs.reduce((s, r) => s + (r.end - r.start), 0);
      return send(res, 200, {
        source: m.duration || 0, kept,
        pauses: (m.silences || []).length,
        retakes: (m.retakes || []).length,
        fillers: words.filter(w => w.filler).length,
        cutWords: words.filter(w => w.keep === false).length,
        words: words.length,
        // each word's moment in the finished cut, so the plan shows real timestamps
        times: words.map(w => (w.keep === false || !rs.length) ? null : +M.remap(Math.max(w.start, rs[0].start), rs).toFixed(2))
      });
    }

    // a poster frame per project, made once
    if (req.method === 'GET' && p === '/api/project/thumb') {
      if (!safeId(id)) return send(res, 404, { error: 'not found' });
      const m = meta(id);
      const th = path.join(pdir(id), 'thumb.jpg');
      if (!fs.existsSync(th) && m.src && fs.existsSync(m.src)) {
        await new Promise(r => execFile(require('./lib/bin').FFMPEG,
          ['-y', '-loglevel', 'error', '-ss', String(Math.min(2, (m.duration || 4) / 2)), '-i', m.src,
           '-frames:v', '1', '-vf', 'scale=480:-2', th], () => r()));
      }
      if (!fs.existsSync(th)) return send(res, 404, { error: 'no thumb' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' });
      return fs.createReadStream(th).pipe(res);
    }

    // what the footage looks like, from the vision pass
    // clean up the mishearings before they end up burned into the captions
    if (req.method === 'POST' && p === '/api/fixwords') {
      const { id: k } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const tid = newTask('fix', k, 'Checking the transcript');
      setTask(tid, { note: 'Looking for misheard names and jargon' });
      FIX.ask(meta(k).words).then(fixes => {
        const cur = meta(k);
        const n = FIX.apply(cur.words, fixes);
        cur.fixes = fixes; saveMeta(k, cur);
        setTask(tid, { stage: 'done', pct: 100, ended: Date.now(),
          note: n ? `${n} word${n > 1 ? 's' : ''} corrected: ` + (fixes || []).slice(0, 4).map(f => `${f.wrong} to ${f.right}`).join(', ') : 'Nothing looked wrong' });
      }).catch(e => setTask(tid, { stage: 'error', note: e.message.slice(0, 160), ended: Date.now() }));
      return send(res, 200, { ok: true, task: tid });
    }

    if (req.method === 'GET' && p === '/api/review') {
      if (!safeId(id)) return send(res, 404, { error: 'not found' });
      return send(res, 200, meta(id).review || []);
    }

    if (req.method === 'GET' && p === '/api/vision') {
      if (!safeId(id)) return send(res, 404, { error: 'not found' });
      const m = meta(id);
      const log = VIS.load(path.join(pdir(id), 'vision.jsonl'));
      return send(res, 200, { summary: m.vision || null, cuts: m.cuts || [], framing: VIS.framing(log).filter((_, i) => i % 2 === 0), ready: !!m.vision });
    }
    if (req.method === 'POST' && p === '/api/vision/run') {
      const { id: k } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      return send(res, 200, { ok: true, task: runVision(k) });
    }

    // sound: the beds and hits on disk, and named profiles that pick three beds
    if (req.method === 'GET' && p === '/api/sound') {
      const dir = path.join(ROOT, 'sound');
      const list = d => fs.existsSync(path.join(dir, d)) ? fs.readdirSync(path.join(dir, d)).filter(f => /\.(m4a|mp3|wav|aac|flac)$/i.test(f)).map(f => ({ name: f.replace(/\.[^.]+$/, ''), file: path.join(dir, d, f) })) : [];
      let profiles = {}; try { profiles = JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8')); } catch {}
      return send(res, 200, { bgm: list('bgm'), sfx: list('sfx'), profiles });
    }
    if (req.method === 'POST' && p === '/api/sound/profile') {
      const { name, beds } = await readJson(req);
      const f = path.join(ROOT, 'sound', 'profiles.json');
      let profiles = {}; try { profiles = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
      profiles[String(name).slice(0, 40)] = { beds: (beds || []).slice(0, 3) };
      fs.writeFileSync(f, JSON.stringify(profiles, null, 2));
      return send(res, 200, { ok: true, profiles });
    }

    // formats: a named bundle of settings and moves, learned from real edits
    if (req.method === 'GET' && p === '/api/templates') {
      try { return send(res, 200, JSON.parse(fs.readFileSync(path.join(ROOT, 'refs', 'templates.json'), 'utf8'))); }
      catch { return send(res, 200, []); }
    }
    if (req.method === 'GET' && /^\/templates\/[a-z0-9-]+\.(png|jpg)$/.test(p)) {
      const f = path.join(ROOT, 'public', p);
      if (!fs.existsSync(f)) return send(res, 404, { error: 'no sample' });
      res.writeHead(200, { 'Content-Type': p.endsWith('png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'max-age=300' });
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method === 'POST' && p === '/api/template/apply') {
      const { id: k, template, extra, settingsOnly, planned } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'refs', 'templates.json'), 'utf8'));
      const tp = list.find(x => x.key === template);
      if (!tp) return send(res, 404, { error: 'no such format' });
      const m = meta(k);
      // a new format replaces what the last format placed, and leaves your own edits alone
      if (m.template) {
        m.overlays = (m.overlays || []).filter(o => o.by !== 'template');
        m.lists = (m.lists || []).filter(o => o.by !== 'template');
        m.reframes = (m.reframes || []).filter(o => o.by !== 'template');
        m.cows = (m.cows || []).filter(o => o.by !== 'template');
        m.spots = (m.spots || []).filter(o => o.by !== 'template');
      }
      // the shape you already chose wins over the format's default
      m.settings = { ...(m.settings || {}), ...tp.settings, ...(m.settings?.aspect ? { aspect: m.settings.aspect } : {}), styleChosen: true };
      m.template = tp.key;
      saveMeta(k, m);
      // the moves that need judgement go through the same path as a typed instruction
      let task = null;
      if (tp.instruction && !settingsOnly) {
        const tid = newTask('edit', k, 'Format: ' + tp.name);
        setTask(tid, { note: 'Laying out the ' + tp.name + ' format on this clip' });
        EP.ask(tp.instruction + (extra ? ' ' + String(extra).slice(0, 400) : ''), meta(k), tp.ref || null).then(async ops => {
          // the plan already owns the titles and big words, so the format only brings its layout moves
          if (planned) ops = (ops || []).filter(o => o.op !== 'pop' && o.op !== 'title' && o.op !== 'gradient');
          const before = (() => { const c = meta(k); return { o: (c.overlays || []).length, l: (c.lists || []).length, r: (c.reframes || []).length, c: (c.cows || []).length, s: (c.spots || []).length }; })();
          const done = await applyOps(k, ops);
          const c = meta(k);
          (c.overlays || []).slice(before.o).forEach(x => x.by = 'template'); (c.lists || []).slice(before.l).forEach(x => x.by = 'template');
          (c.reframes || []).slice(before.r).forEach(x => x.by = 'template'); (c.cows || []).slice(before.c).forEach(x => x.by = 'template'); (c.spots || []).slice(before.s).forEach(x => x.by = 'template');
          // titles are unshifted, so the newest sit at the front
          (c.overlays || []).slice(0, Math.max(0, (c.overlays || []).length - before.o)).forEach(x => { if (x.type === 'hook') x.by = 'template'; });
          saveMeta(k, c);
          setTask(tid, { stage: 'done', pct: 100, ended: Date.now(), note: done.length ? tp.name + ': ' + done.join(', ').slice(0, 280) : tp.name + ' applied, nothing to place' });
        }).catch(e => setTask(tid, { stage: 'error', note: e.message.slice(0, 200), ended: Date.now() }));
        task = tid;
      }
      return send(res, 200, { ok: true, task, settings: m.settings });
    }

    // browse local folders so a big file never has to travel over HTTP
    if (req.method === 'GET' && p === '/api/browse') {
      const dir = u.searchParams.get('dir');
      if (!dir) return send(res, 200, { roots: BROWSE_DIRS.map(d => ({ path: d, name: path.basename(d) })) });
      const real = path.resolve(dir);
      if (!real.startsWith(os.homedir())) return send(res, 403, { error: 'outside home folder' });
      const items = fs.readdirSync(real, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.'))
        .map(e => { const fp = path.join(real, e.name);
          let size = 0; try { size = e.isFile() ? fs.statSync(fp).size : 0; } catch {}
          return { name: e.name, path: fp, dir: e.isDirectory(), size,
            ok: e.isDirectory() || VIDEO_EXT.test(e.name) }; })
        .filter(e => e.ok)
        .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
      return send(res, 200, { dir: real, parent: path.dirname(real), items });
    }

    // import by path: no copy at all
    if (req.method === 'POST' && p === '/api/importPath') {
      const { file } = await readJson(req);
      const real = path.resolve(file);
      if (!real.startsWith(os.homedir()) || !fs.existsSync(real))
        return send(res, 400, { error: 'cannot read that file' });
      const nid = newProject(path.basename(real).replace(/\.[^.]+$/, ''), real, true);
      setJob(nid, { stage: 'queued', pct: 0 });
      ingest(nid);
      return send(res, 200, { id: nid });
    }

    // streaming upload, straight to disk
    if (req.method === 'POST' && p === '/api/import') {
      const name = decodeURIComponent(req.headers['x-filename'] || 'clip.mp4');
      const nid = newProject(name.replace(/\.[^.]+$/, ''), '', false);
      const dest = path.join(pdir(nid), 'source' + (path.extname(name) || '.mp4'));
      const m = meta(nid); m.src = dest; saveMeta(nid, m);
      const total = Number(req.headers['content-length'] || 0);
      let got = 0;
      setJob(nid, { stage: 'copying', pct: 0, note: '' });
      const ws = fs.createWriteStream(dest);
      req.on('data', c => { got += c.length; if (total) setJob(nid, { pct: Math.round(got / total * 100) }); });
      req.pipe(ws);
      ws.on('finish', () => { send(res, 200, { id: nid }); ingest(nid); });
      ws.on('error', e => { setJob(nid, { stage: 'error', error: e.message }); send(res, 500, { error: e.message }); });
      return;
    }

    if (req.method === 'GET' && p === '/api/tasks') {
      sweepTasks();
      return send(res, 200, [...tasks.values()].sort((a, b) => a.started - b.started));
    }

    if (req.method === 'POST' && p === '/api/task/dismiss') {
      const { task } = await readJson(req);
      tasks.delete(task);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/task/cancel') {
      const { task } = await readJson(req);
      const tk = tasks.get(task);
      if (tk) {
        const pr = procs.get(tk.project);
        if (pr) { try { pr.kill('SIGKILL'); } catch {} procs.delete(tk.project); }
        setTask(task, { stage: 'error', note: 'Cancelled.', ended: Date.now() });
      }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/job')
      return send(res, 200, jobs.get(id) || { stage: 'done', pct: 100 });

    if (req.method === 'POST' && p === '/api/cancel') {
      const { id: cid } = await readJson(req);
      const pr = procs.get(cid);
      if (pr) { try { pr.kill('SIGKILL'); } catch {} procs.delete(cid); }
      setJob(cid, { stage: 'error', error: 'Cancelled.' });
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/project') {
      if (!safeId(id)) return send(res, 404, { error: 'not found' });
      const m = meta(id);
      delete m.broll;                 // always regenerated, never served stale
      // old projects carry a caption style from before the good ones existed
      if (m.settings && !m.settings.styleChosen) m.settings.capStyle = 'minimal';
      if (!m.settings?.crf) m.settings = { ...(m.settings || {}), crf: 20 };
      return send(res, 200, m);
    }

    if (req.method === 'POST' && p === '/api/keep') {
      const { id: k, keeps } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      m.words.forEach((w, i) => { if (keeps[i] !== undefined) w.keep = !!keeps[i]; });
      saveMeta(k, m);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/settings') {
      const { id: k, settings, draft } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k); m.settings = settings; saveMeta(k, m);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/rename') {
      const { id: k, name } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k); m.name = String(name).slice(0, 120); saveMeta(k, m);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/delete') {
      const { id: k } = await readJson(req);
      if (safeId(k)) fs.rmSync(pdir(k), { recursive: true, force: true });
      return send(res, 200, { ok: true });
    }

    // work out what should go on screen, so nothing has to be hunted for
    if (req.method === 'GET' && p === '/api/suggest') {
      if (!safeId(id)) return send(res, 404, { error: 'not found' });
      process.env.TWITTERAPI_KEY = TWITTER_KEY;
      const m = meta(id);
      const s = await SUG.suggest(m.words);
      return send(res, 200, s);
    }

    // auto-place everything it found that it is sure about
    if (req.method === 'POST' && p === '/api/suggest/apply') {
      const { id: k } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      process.env.TWITTERAPI_KEY = TWITTER_KEY;
      const m = meta(k);
      const s = await SUG.suggest(m.words);
      const dir = path.join(pdir(k), 'stickers');
      fs.mkdirSync(dir, { recursive: true });
      m.overlays = m.overlays || [];
      let added = 0;
      for (const tw of s.tweets) {
        const oid = 'tw' + Date.now().toString(36) + added;
        const file = path.join(dir, oid + '.png');
        try {
          const info = await runPy('tweetcard.py', { tweet: tw.tweet.id, out: file, width: 1000, dark: true });
          m.overlays.push({ id: oid, type: 'tweet', file, word: tw.word, dur: 3.5, scale: .78,
            label: '@' + info.author + ' · ' + info.text.slice(0, 44) });
          added++;
        } catch {}
      }
      saveMeta(k, m);          // prompts are never cached, they change with the composer
      return send(res, 200, { ok: true, added, overlays: m.overlays, broll: s.broll, names: s.names, found: s.found });
    }

    // grab whatever was just made in Flow and drop it in
    if (req.method === 'POST' && p === '/api/import-download') {
      const { id: k, word } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const dl = path.join(os.homedir(), 'Downloads');
      const recent = fs.readdirSync(dl)
        .filter(f => /\.(mp4|mov|webm|png|jpg|jpeg|gif)$/i.test(f) && !f.startsWith('.'))
        .map(f => ({ f, p: path.join(dl, f), t: fs.statSync(path.join(dl, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)[0];
      if (!recent) return send(res, 400, { error: 'Downloads has no video or image in it.' });
      if (Date.now() - recent.t > 60 * 60 * 1000)
        return send(res, 400, { error: `The newest thing in Downloads is "${recent.f}", over an hour old. Generate it first.` });
      const m = meta(k);
      const dir = path.join(pdir(k), 'stickers');
      fs.mkdirSync(dir, { recursive: true });
      const oid = 'dl' + Date.now().toString(36);
      const file = path.join(dir, oid + path.extname(recent.f));
      fs.copyFileSync(recent.p, file);
      m.overlays = m.overlays || [];
      m.overlays.push({ id: oid, type: 'broll', file, word: word || 0, dur: 4, scale: 1,
        label: recent.f });
      saveMeta(k, m);
      return send(res, 200, { ok: true, overlays: m.overlays, file: recent.f });
    }

    // a frame of the speaker, so generated shots match the room, the light and the grade
    if (req.method === 'POST' && p === '/api/shots/ground') {
      const { id: k } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      const dir = path.join(pdir(k), 'refs'); fs.mkdirSync(dir, { recursive: true });
      const still = path.join(dir, 'speaker.jpg');
      await new Promise(r => execFile(require('./lib/bin').FFMPEG, ['-y', '-loglevel', 'error',
        '-ss', String(Math.min(4, (m.duration || 8) / 2)), '-i', m.src, '-frames:v', '1',
        '-vf', 'scale=1024:-2', still], () => r()));
      // a real picture of anything the shot names
      const shots = m.shots || [];
      let grounded = 0;
      for (const s of shots) {
        s.refs = [];
        // the object is usually a plain thing, not a proper noun: "a stethoscope
        // pressed against a door" wants a picture of a stethoscope
        const term = headNoun(s.object || '');
        if (term) {
          const f = path.join(dir, 'ref' + s.n + '.jpg');
          try { const info = await runPy('assets.py', { term, out: f });
            if (info.found) { s.refs.unshift(f); grounded++; } } catch {}
        }
        if (fs.existsSync(still)) s.refs.push(still);
      }
      m.shots = shots; saveMeta(k, m);
      return send(res, 200, { ok: true, grounded, still: fs.existsSync(still), shots: shots.length });
    }

    // every shot in the list, one after another, each clip pinned to its word
    if (req.method === 'POST' && p === '/api/shots/generate-all') {
      const { id: k, shots } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const dir = path.join(pdir(k), 'stickers');
      const tid = newTask('flow', k, `Flow: ${shots.length} shots`);
      (async () => {
        let done = 0;
        for (const s of shots) {
          setTask(tid, { note: `Shot ${done + 1} of ${shots.length}: opening Flow`, pct: Math.round(done / shots.length * 100) });
          try {
            const r = await FLOW.generate(s.prompt, dir,
              st => setTask(tid, { note: `Shot ${done + 1} of ${shots.length}: ${st}` }), s.refs || []);
            const cur = meta(k); cur.overlays = cur.overlays || [];
            cur.overlays.push({ id: 'fl' + Date.now().toString(36), type: 'broll', file: r.file,
              word: s.word || 0, dur: s.secs || 4, scale: 1, label: `Shot ${s.n || done + 1}: ${(s.onScreen || '').slice(0, 36)}` });
            saveMeta(k, cur);
          } catch (e) {
            setTask(tid, { stage: 'error', note: `Shot ${done + 1} failed: ${e.message}`, ended: Date.now() });
            return;
          }
          done++;
        }
        setTask(tid, { stage: 'done', pct: 100, note: `${done} clips placed`, ended: Date.now() });
      })();
      return send(res, 200, { ok: true, task: tid });
    }

    // the shot list is written once per transcript and kept; Rewrite runs it again
    if (req.method === 'GET' && p === '/api/shots') {
      if (!safeId(id)) return send(res, 404, { error: 'not found' });
      const m = meta(id);
      const k = SHOTS.key(m.words);
      if (m.shots && m.shotsKey === k) return send(res, 200, { shots: m.shots, by: m.shotsBy || 'claude', ready: true });
      return send(res, 200, { shots: [], ready: false });
    }
    if (req.method === 'POST' && p === '/api/shots/write') {
      const { id: k } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      const tid = newTask('shots', k, 'Writing the shot list');
      setTask(tid, { note: 'Reading the transcript for the four beats that earn an insert' });
      SHOTS.writeShots(m.words).then(r => {
        const cur = meta(k); cur.shots = r.shots; cur.shotsKey = r.key; cur.shotsBy = r.by; saveMeta(k, cur);
        setTask(tid, { stage: 'done', pct: 100, ended: Date.now(),
          note: r.by === 'claude' ? `${r.shots.length} shots written` : 'Claude was not reachable, used the plain composer' });
      }).catch(e => setTask(tid, { stage: 'error', note: e.message, ended: Date.now() }));
      return send(res, 200, { ok: true, task: tid });
    }

    // references for the dropdown: catalogued looks plus any clip dropped in ~/reels
    if (req.method === 'GET' && p === '/api/refs') {
      const refs = EP.REFS();
      const dir = path.join(os.homedir(), 'reels');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.(mp4|mov)$/i.test(f)) : [];
      const list = files.map(f => { const k = f.replace(/\.[^.]+$/, ''); const r = refs[k];
        return { key: k, file: path.join(dir, f), creator: r?.creator || k, look: r?.look || 'not catalogued yet', tags: r?.tags || [] }; });
      for (const [k, r] of Object.entries(refs)) if (!list.some(x => x.key === k)) list.push({ key: k, creator: r.creator, look: r.look, tags: r.tags });
      return send(res, 200, list);
    }

    // edit by asking: the instruction becomes operations, applied with the existing tools
    if (req.method === 'POST' && p === '/api/edit/prompt') {
      const { id: k, instruction, ref } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      const tid = newTask('edit', k, 'Edit: ' + String(instruction).slice(0, 40));
      setTask(tid, { note: 'Reading the transcript and what is already on screen' });
      EP.ask(instruction, m, ref).then(async ops => {
        const done = await applyOps(k, ops);
        setTask(tid, { stage: 'done', pct: 100, ended: Date.now(), note: done.length ? done.join('; ').slice(0, 300) : 'Nothing to change' });
      }).catch(e => setTask(tid, { stage: 'error', note: e.message.slice(0, 200), ended: Date.now() }));
      return send(res, 200, { ok: true, task: tid });
    }

    // keyword pop, word cloud, gradient hook, comment card
    if (req.method === 'POST' && p === '/api/pop') {
      const { id: k, pop, word, seconds, by } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      const dir = path.join(pdir(k), 'stickers'); fs.mkdirSync(dir, { recursive: true });
      const oid = 'pp' + Date.now().toString(36);
      const file = path.join(dir, oid + '.png');
      const W = ASPECT_WH(m.settings?.aspect, m);
      let info;
      const wi = Number(word) || 0;
      const yFor = pop.kind === 'comment' ? (pop.y ?? 0.62) : clearY(k, wi, pop.kind === 'pop' ? 0.09 : 0.26);
      try { info = await runPy('pop.py', { ...pop, y: yFor, tight: false, width: W[0], height: W[1], out: file }); }
      catch (e) { return send(res, 400, { error: e.message }); }
      m.overlays = m.overlays || [];
      const dur = Number(seconds) || (pop.kind === 'pop' ? 1.2 : pop.kind === 'comment' ? 4 : 3);
      m.overlays.push({ id: oid, type: 'pop', kind: pop.kind, file, word: wi, dur, by: by || undefined,
        scale: 1, x: 0, y: 0, ar: (W[1] / W[0]), label: (pop.kind + ': ' + (pop.text || (pop.words || []).join(' '))).slice(0, 44) });
      saveMeta(k, m);
      return send(res, 200, { ok: true, overlays: m.overlays });
    }

    // white card: a text slide over the whole frame, or a band with the speaker still visible
    if (req.method === 'POST' && p === '/api/card') {
      const { id: k, card, word, seconds } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      const dir = path.join(pdir(k), 'stickers'); fs.mkdirSync(dir, { recursive: true });
      const oid = 'cd' + Date.now().toString(36);
      const file = path.join(dir, oid + '.png');
      const W = ASPECT_WH(m.settings?.aspect, m);
      try { await runPy('card.py', { ...card, width: W[0], height: W[1], out: file }); }
      catch (e) { return send(res, 400, { error: e.message }); }
      m.overlays = m.overlays || [];
      m.overlays.push({ id: oid, type: 'card', file, word: Number(word) || 0, dur: Number(seconds) || 4,
        scale: 1, x: 0, y: 0, label: 'Card: ' + (card.headline || (card.lines || [])[0] || 'text').slice(0, 40) });
      saveMeta(k, m);
      return send(res, 200, { ok: true, overlays: m.overlays });
    }

    // clips that finished after the watcher gave up
    if (req.method === 'POST' && p === '/api/flow/collect') {
      const { id: k, word } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      const known = new Set((m.overlays || []).map(o => o.src).filter(Boolean));
      const tid = newTask('flow', k, 'Collect from Flow');
      FLOW.collect(path.join(pdir(k), 'stickers'), known)
        .then(got => {
          const cur = meta(k); cur.overlays = cur.overlays || [];
          for (const g of got) cur.overlays.push({ id: 'fl' + Date.now().toString(36) + cur.overlays.length,
            type: 'broll', file: g.file, src: g.src, word: word || 0, dur: 5, scale: 1, label: 'Flow clip' });
          saveMeta(k, cur);
          setTask(tid, { stage: 'done', pct: 100, note: got.length ? `${got.length} clip(s) brought in` : 'Nothing new in Flow yet', ended: Date.now() });
        })
        .catch(e => setTask(tid, { stage: 'error', note: e.message, ended: Date.now() }));
      return send(res, 200, { ok: true, task: tid });
    }

    // Four hooks, four short clips, pick the one that stops a scroll
    if (req.method === 'POST' && p === '/api/hooks') {
      const { id: k, n } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      const count = Math.max(2, Math.min(5, Number(n) || 4));
      const tid = newTask('hooks', k, `Trying ${count} openings`);
      setTask(tid, { note: 'Writing them' });
      (async () => {
        const variants = await HOOKS.ask(m.words.map(w => w.text).join(' '), count);
        const dir = path.join(pdir(k), 'hooks');
        fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
        const W = ASPECT_WH(m.settings?.aspect, m);
        const out = [];
        for (const [i, v] of variants.slice(0, count).entries()) {
          setTask(tid, { pct: Math.round(i / count * 100), note: `Rendering "${(v.headline || '').slice(0, 34)}"` });
          const png = path.join(dir, `h${i}.png`);
          const ti = await runPy('titleblock.py', { width: W[0], height: W[1], out: png,
            headline: v.headline || '', subline: v.subline || '', face: 'ultra', accent: '#F5E31C',
            upper: true, top: 0.06, headSize: Math.round(W[1] * 0.062) });
          const clip = path.join(dir, `h${i}.mp4`);
          // the same edit, just the opening, with this hook over it
          await M.render(m.src, m.words, clip, {
            ...m.settings, draft: true, onlyFirst: 5, info: m, faces: [], silences: m.silences || [], wav: path.join(pdir(k), 'audio.wav'),
            overlays: [{ id: 'hk' + i, type: 'hook', file: png, word: 0, dur: 4,
              scale: ti.scale, x: ti.x, y: ti.y, ar: ti.h / ti.w, label: v.headline || '' }],
            lists: [], reframes: [], cows: [], spots: [], sound: null,
          }).catch(() => {});
          if (fs.existsSync(clip)) out.push({ i, ...v, png, clip });
        }
        const cur = meta(k); cur.hooks = out; saveMeta(k, cur);
        setTask(tid, { stage: 'done', pct: 100, ended: Date.now(),
          note: out.length ? `${out.length} openings ready to compare` : 'none rendered' });
      })().catch(e => setTask(tid, { stage: 'error', note: e.message.slice(0, 160), ended: Date.now() }));
      return send(res, 200, { ok: true, task: tid });
    }

    if (req.method === 'GET' && p === '/api/hooks') {
      if (!safeId(id)) return send(res, 404, { error: 'not found' });
      return send(res, 200, meta(id).hooks || []);
    }
    if (req.method === 'GET' && p === '/api/hooks/clip') {
      if (!safeId(id)) return send(res, 404, { error: 'not found' });
      const h = (meta(id).hooks || [])[Number(u.searchParams.get('i')) || 0];
      if (!h || !fs.existsSync(h.clip)) return send(res, 404, { error: 'gone' });
      const size = fs.statSync(h.clip).size;
      const range = req.headers.range;
      if (range) {
        const [s, e] = range.replace(/bytes=/, '').split('-');
        const start = parseInt(s, 10) || 0;
        if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        const end = e ? Math.min(parseInt(e, 10), size - 1) : size - 1;
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1, 'Content-Type': 'video/mp4' });
        return fs.createReadStream(h.clip, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(h.clip).pipe(res);
    }
    // keep the one that wins
    if (req.method === 'POST' && p === '/api/hooks/pick') {
      const { id: k, i } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      const h = (m.hooks || [])[Number(i)];
      if (!h) return send(res, 404, { error: 'no such opening' });
      const dir = path.join(pdir(k), 'stickers'); fs.mkdirSync(dir, { recursive: true });
      const oid = 'hk' + Date.now().toString(36);
      const file = path.join(dir, oid + '.png');
      fs.copyFileSync(h.png, file);
      const W = ASPECT_WH(m.settings?.aspect, m);
      const dim = await M.probe(file).catch(() => ({ width: W[0], height: W[1] }));
      m.overlays = (m.overlays || []).filter(o => !(o.type === 'hook' && o.word === 0));
      m.overlays.unshift({ id: oid, type: 'hook', file, word: 0, dur: 4,
        scale: (dim.width || W[0]) / W[0], x: 0, y: 0, ar: (dim.height || 1) / (dim.width || 1),
        label: h.headline });
      saveMeta(k, m);
      return send(res, 200, { ok: true, overlays: m.overlays });
    }

    // a real picture of a named thing, from Wikimedia Commons
    if (req.method === 'POST' && p === '/api/asset') {
      const { id: k, term, word, seconds } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      const dir = path.join(pdir(k), 'stickers'); fs.mkdirSync(dir, { recursive: true });
      const oid = 'as' + Date.now().toString(36);
      const file = path.join(dir, oid + '.jpg');
      let info;
      try { info = await runPy('assets.py', { term, out: file }); }
      catch (e) { return send(res, 400, { error: e.message }); }
      if (!info.found) return send(res, 404, { error: `no free picture of "${term}"` });
      const dim = await M.probe(file).catch(() => ({ width: 1200, height: 800 }));
      m.overlays = m.overlays || [];
      m.overlays.push({ id: oid, type: 'image', file, word: Number(word) || 0, dur: Number(seconds) || 3,
        scale: 0.62, auto: true, ar: (dim.height || 800) / (dim.width || 1200),
        credit: info.credit, licence: info.licence,
        label: term + ' · ' + (info.licence || 'CC') });
      saveMeta(k, m);
      return send(res, 200, { ok: true, overlays: m.overlays, info });
    }

    // Flow ------------------------------------------------------------------
    if (req.method === 'GET' && p === '/api/flow/status')
      return send(res, 200, await FLOW.status());

    if (req.method === 'POST' && p === '/api/flow/login') {
      try { return send(res, 200, await FLOW.login()); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (req.method === 'POST' && p === '/api/flow/generate') {
      const { id: k, word, prompt, refs } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      const dir = path.join(pdir(k), 'stickers');
      const tid = newTask('flow', k, 'Flow: ' + String(prompt).slice(0, 40));
      FLOW.generate(prompt, dir, s => setTask(tid, { note: s }), refs || [])
        .then(r => {
          const cur = meta(k);
          cur.overlays = cur.overlays || [];
          cur.overlays.push({ id: 'fl' + Date.now().toString(36), type: 'broll', file: r.file,
            word: word || 0, dur: 4, scale: 1, label: 'Flow: ' + prompt.slice(0, 40) });
          saveMeta(k, cur);
          setTask(tid, { stage: 'done', pct: 100, note: 'Clip placed', ended: Date.now() });
        })
        .catch(e => setTask(tid, { stage: 'error', note: e.message, ended: Date.now() }));
      return send(res, 200, { ok: true, task: tid });
    }

    if (req.method === 'POST' && p === '/api/hook') {
      const { id: k, headline, subline, face, accent, upper, chip, seconds, top, word, behind, x, y, scale } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      const dir = path.join(pdir(k), 'stickers');
      fs.mkdirSync(dir, { recursive: true });
      const oid = 'hk' + Date.now().toString(36);
      const file = path.join(dir, oid + '.png');
      const W = ASPECT_WH(m.settings?.aspect, m);
      let ti;
      try {
        ti = await runPy('titleblock.py', { width: W[0], height: W[1], out: file,
          headline: headline || '', subline: subline || '',
          face: face || 'ultra', accent: accent || '#F5E31C',
          upper: upper !== false, chip: chip || null,
          top: top === undefined ? 0.06 : Number(top),
          headSize: Math.round(W[1] * 0.062) });
      } catch (e) { return send(res, 400, { error: e.message }); }
      m.overlays = m.overlays || [];   // titles stack, they are not one per video
      m.overlays.unshift({ id: oid, type: 'hook', file, word: Number(word) || 0,
        dur: Number(seconds) || 4,
        scale: x === undefined ? ti.scale : (Number(scale) || ti.scale),
        x: x === undefined ? ti.x : Number(x),
        y: y === undefined ? ti.y : Number(y),
        behind: !!behind, ar: ti.h / ti.w,
        label: (headline || subline || 'Title').slice(0, 44) });
      saveMeta(k, m);
      return send(res, 200, { ok: true, overlays: m.overlays });
    }

    if (req.method === 'POST' && p === '/api/jolt') {
      const { id: k, cows, spots } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k); m.cows = cows || []; m.spots = spots || []; saveMeta(k, m);
      return send(res, 200, { ok: true });
    }

    // speaker reframe ---------------------------------------------------------
    if (req.method === 'POST' && p === '/api/reframe') {
      const { id: k, reframe } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k); m.reframes = m.reframes || [];
      if (reframe.id) { const i = m.reframes.findIndex(r => r.id === reframe.id); if (i >= 0) m.reframes[i] = reframe; else m.reframes.push(reframe); }
      else { reframe.id = 'rf' + Date.now().toString(36); m.reframes.push(reframe); }
      saveMeta(k, m);
      return send(res, 200, { ok: true, reframes: m.reframes });
    }
    if (req.method === 'POST' && p === '/api/reframe/remove') {
      const { id: k, rid } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k); m.reframes = (m.reframes || []).filter(r => r.id !== rid); saveMeta(k, m);
      return send(res, 200, { ok: true, reframes: m.reframes });
    }

    // accumulating lists ----------------------------------------------------
    if (req.method === 'POST' && p === '/api/list') {
      const { id: k, list } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      m.lists = m.lists || [];
      if (list.id) { const i = m.lists.findIndex(l => l.id === list.id); if (i >= 0) m.lists[i] = list; else m.lists.push(list); }
      else { list.id = 'ls' + Date.now().toString(36); m.lists.push(list); }
      saveMeta(k, m);
      return send(res, 200, { ok: true, lists: m.lists });
    }
    if (req.method === 'POST' && p === '/api/list/remove') {
      const { id: k, lid } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k); m.lists = (m.lists || []).filter(l => l.id !== lid); saveMeta(k, m);
      return send(res, 200, { ok: true, lists: m.lists });
    }

    // stickers ------------------------------------------------------------
    if (req.method === 'POST' && p === '/api/overlay/tweet') {
      const { id: k, tweet, word, dur, scale, dark } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      const dir = path.join(pdir(k), 'stickers');
      fs.mkdirSync(dir, { recursive: true });
      const oid = 'tw' + Date.now().toString(36);
      const file = path.join(dir, oid + '.png');
      let info;
      try { info = await runPy('tweetcard.py', { tweet, out: file, width: 1000, dark: dark !== false }); }
      catch (e) { return send(res, 400, { error: 'Could not fetch that tweet. ' + e.message }); }
      m.overlays = m.overlays || [];
      m.overlays.push({ id: oid, type: 'tweet', file, word: word || 0, dur: dur || 3.5,
        scale: scale || .78, label: '@' + info.author + ' · ' + info.text.slice(0, 44) });
      saveMeta(k, m);
      return send(res, 200, { ok: true, overlays: m.overlays });
    }

    if (req.method === 'POST' && p === '/api/overlay/image') {
      const k = u.searchParams.get('id');
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      const dir = path.join(pdir(k), 'stickers');
      fs.mkdirSync(dir, { recursive: true });
      const nm = decodeURIComponent(req.headers['x-filename'] || 'image.png');
      const oid = 'im' + Date.now().toString(36);
      const file = path.join(dir, oid + (path.extname(nm) || '.png'));
      const ws = fs.createWriteStream(file);
      req.pipe(ws);
      ws.on('finish', () => {
        m.overlays = m.overlays || [];
        m.overlays.push({ id: oid, type: 'image', file, word: Number(u.searchParams.get('word')) || 0,
          dur: 3, scale: .7, label: nm });
        saveMeta(k, m);
        send(res, 200, { ok: true, overlays: m.overlays });
      });
      ws.on('error', e => send(res, 500, { error: e.message }));
      return;
    }

    if (req.method === 'POST' && p === '/api/overlay/update') {
      const { id: k, oid, patch } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      const ov = (m.overlays || []).find(o => o.id === oid);
      if (ov) Object.assign(ov, patch);
      saveMeta(k, m);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/overlay/remove') {
      const { id: k, oid } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      const ov = (m.overlays || []).find(o => o.id === oid);
      if (ov) { try { fs.unlinkSync(ov.file); } catch {} }
      m.overlays = (m.overlays || []).filter(o => o.id !== oid);
      saveMeta(k, m);
      return send(res, 200, { ok: true, overlays: m.overlays });
    }

    if (req.method === 'GET' && p === '/api/overlay/thumb') {
      const k = u.searchParams.get('id');
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const ov = (meta(k).overlays || []).find(o => o.id === u.searchParams.get('oid'));
      if (!ov || !fs.existsSync(ov.file)) return send(res, 404, { error: 'gone' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return fs.createReadStream(ov.file).pipe(res);
    }

    if (req.method === 'POST' && p === '/api/render') {
      const { id: k, settings, draft } = await readJson(req);
      if (!safeId(k)) return send(res, 404, { error: 'not found' });
      const m = meta(k);
      m.settings = settings || m.settings || {};
      saveMeta(k, m);
      const out = path.join(pdir(k), draft ? 'draft.mp4' : 'final.mp4');
      const maskFile = path.join(pdir(k), 'mask.mov');
      const wantsMask = (m.overlays || []).some(o => o.behind) || m.settings.capBehind || m.settings.capDynamic;
      const xid = newTask('export', k, (draft ? 'Draft ' : 'Export ') + (m.name || '').slice(0, 30));
      setTask(xid, { note: 'Finding the speaker' });
      // where the speaker's face is: the crop follows it, and text and stickers stay off it
      let faces = [];
      speakerFaces(k).then(f => { faces = f; m.speaker = meta(k).speaker; setTask(xid, { note: wantsMask ? 'Reading the subject out of the frame' : 'Stitching the takes' }); })
        .then(() => wantsMask
          ? M.buildMask(m.src, maskFile, n => setTask(xid, { note: `Reading the subject, frame ${n}` }))
          : null)
        .then(mask => M.render(m.src, m.words, out, { ...m.settings, draft: !!draft, info: m,
          silences: m.silences || [], wav: path.join(pdir(k), 'audio.wav'), overlays: m.overlays || [], lists: m.lists || [], reframes: m.reframes || [], mask,
          sound: m.settings.sound || null, cows: m.cows || [], spots: m.spots || [], grade: m.settings.grade || null, faces, sections: m.sections || [] },
          pc => setTask(xid, { pct: pc, note: 'Stitching the takes' }), pr => procs.set(k, pr)))
        .then(async r => {
          procs.delete(k);
          const caps = M.captionChunks(m.words, M.ranges(m.words, { gapMax: m.settings.gapMax || 0, silences: m.silences || [], wav: path.join(pdir(k), 'audio.wav') }));
          fs.writeFileSync(path.join(pdir(k), 'captions.srt'), M.srt(caps));
          m.rendered = true; m.renderStats = r; saveMeta(k, m);
          setTask(xid, { note: 'Watching it back' });
          let notes = [];
          try { notes = await REVIEW.review(out, { events: r.plan || [] }); } catch (e) { notes = []; }
          const cur = meta(k); cur.review = notes; saveMeta(k, cur);
          const bad = notes.filter(n => n.level === 'bad').length;
          setTask(xid, { stage: 'done', pct: 100, ended: Date.now(),
            note: notes.length ? (bad ? `${bad} thing${bad > 1 ? 's' : ''} to fix: ` : 'Worth a look: ') + notes.slice(0, 2).map(n => n.what).join('; ') : 'Ready, nothing looks wrong' });
        })
        .catch(e => { procs.delete(k);
          setTask(xid, { stage: 'error', note: e.message, ended: Date.now() }); });
      return send(res, 200, { ok: true, task: xid });
    }

    // the cut, for Resolve, Premiere or Final Cut
    if (req.method === 'GET' && p === '/api/fcpxml') {
      if (!safeId(id)) return send(res, 404, { error: 'not found' });
      const m = meta(id);
      const rs = M.ranges(m.words, { gapMax: m.settings?.gapMax || 0, silences: m.silences || [], wav: path.join(pdir(id), 'audio.wav') });
      const markers = [];
      for (const o of (m.overlays || [])) {
        const w = m.words[o.word]; if (!w) continue;
        markers.push({ at: M.remap(Math.max(w.start, rs[0].start), rs), label: (o.label || o.type).slice(0, 40) });
      }
      const xml = FCP.build({ name: m.name || 'cut', src: m.src, fps: m.fps || 30,
        width: m.width || 1920, height: m.height || 1080, ranges: rs, markers });
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${slug(m.name)}.fcpxml"` });
      return res.end(xml);
    }

    if (req.method === 'GET' && p === '/api/srt') {
      if (!safeId(id)) return send(res, 404, { error: 'not found' });
      const m = meta(id);
      const caps = M.captionChunks(m.words, M.ranges(m.words, { gapMax: m.settings?.gapMax || 0, silences: m.silences || [], wav: path.join(pdir(id), 'audio.wav') }));
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${slug(m.name)}.srt"` });
      return res.end(M.srt(caps));
    }

    if (req.method === 'GET' && (p === '/media/source' || p === '/media/final')) {
      console.log('[media]', p, req.headers.range || '(no range)', req.headers['user-agent']?.slice(0, 40));
      if (!safeId(id)) return send(res, 404, { error: 'not found' });
      const m = meta(id);
      let file = m.play && fs.existsSync(m.play) ? m.play : m.src;
      if (p === '/media/final') {
        const d = path.join(pdir(id), 'draft.mp4'), f = path.join(pdir(id), 'final.mp4');
        // whichever is newer is the one just made
        const mt = x => fs.existsSync(x) ? fs.statSync(x).mtimeMs : 0;
        file = mt(d) > mt(f) ? d : f;
      }
      if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'not ready' });
      const size = fs.statSync(file).size;
      const type = /\.(mp3|m4a|wav|aac)$/i.test(file) ? 'audio/mp4' : 'video/mp4';
      const range = req.headers.range;
      if (range) {
        const [s, e] = range.replace(/bytes=/, '').split('-');
        let start = parseInt(s, 10) || 0;
        // Chrome probes the tail; an empty stream there never ends and the player hangs
        if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        let end = e ? Math.min(parseInt(e, 10), size - 1) : size - 1;
        if (end < start) end = start;
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': type });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Length': size, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === 'POST' && p === '/api/reveal') {
      const { id: k } = await readJson(req);
      if (safeId(k)) require('./lib/bin').reveal(path.join(pdir(k), 'final.mp4'));
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

server.requestTimeout = 0;          // big uploads must not time out
server.headersTimeout = 0;
server.listen(PORT, HOST, () => console.log(`Birch → http://${HOST}:${PORT}`));
