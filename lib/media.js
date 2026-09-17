'use strict';
// ffmpeg + whisper.cpp wrappers. Everything runs locally.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BIN = require('./bin');
const { FFMPEG, FFPROBE, WHISPER } = BIN;
const MODEL = path.join(__dirname, '..', 'models', 'ggml-small.en.bin');
const CAPPY = path.join(__dirname, 'captions.py');
const PERSONMASK = path.join(__dirname, '..', 'tools', 'personmask');

// A person mask lets text sit behind the speaker instead of pasted on top.
// macOS does the segmentation, so it runs at about realtime with no extra deps.
// The Swift tool is macOS only though, so anywhere else, and when BIRCH_NO_SWIFT
// is set, lib/mask_fallback.py does the same job with mediapipe.
const maskSwiftOK = () => {
  if (process.env.BIRCH_NO_SWIFT) return false;
  try { fs.accessSync(PERSONMASK, fs.constants.X_OK); return true; } catch { return false; }
};
function buildMask(src, dst, onProgress) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dst) && fs.statSync(dst).size > 10000) return resolve(dst);
    const [cmd, args] = maskSwiftOK()
      ? [PERSONMASK, [src, dst, 'balanced']]
      : [process.env.BIRCH_PYTHON || BIN.python(),
         [path.join(__dirname, 'mask_fallback.py'), src, dst, 'balanced']];
    console.log('mask: reading the subject with ' + (maskSwiftOK() ? 'apple vision' : 'mediapipe'));
    const p = spawn(cmd, args, { env: { ...process.env, BIRCH_FFMPEG: FFMPEG } });
    let err = '';
    p.stderr.on('data', d => {
      err += String(d).slice(-1000);
      const m = String(d).match(/mask progress (\d+)/);
      if (m && onProgress) onProgress(Number(m[1]));
    });
    p.on('error', reject);
    p.on('close', c => c === 0 ? resolve(dst)
      : reject(new Error('could not read the subject out of the video. ' + err.slice(-200))));
  });
}

const run = (bin, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(bin, args, { maxBuffer: 1 << 28, ...opts }, (err, stdout, stderr) =>
    err ? reject(new Error((stderr || err.message).slice(-1500))) : resolve({ stdout, stderr }));
});

async function probe(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'quiet', '-print_format', 'json',
    '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find(s => s.codec_type === 'video') || {};
  const [n, d] = (v.r_frame_rate || '30/1').split('/').map(Number);
  return {
    duration: Number(j.format.duration) || 0,
    width: v.width || 0, height: v.height || 0,
    fps: d ? n / d : 30,
    hasVideo: !!v.codec_type,
    hasAudio: j.streams.some(s => s.codec_type === 'audio'),
  };
}

// whisper stretches a word's end timestamp across a pause, so pauses have to be
// found in the audio itself rather than inferred from gaps between words.
// A fixed dB gate only works on clean studio audio: a street recording never
// dips to -32dB, so lib/vad.py measures the floor this recording actually has.
async function detectSilence(wav, minDur = 0.22) {
  try {
    const r = await run(BIN.python(), [path.join(__dirname, 'vad.py'), wav, String(minDur)]);
    const d = JSON.parse(r.stdout);
    if (d.silences && d.silences.length) { detectSilence.info = d.info; return d.silences; }
  } catch (e) { /* fall through to the fixed gate */ }
  let out = '';
  try {
    const r = await run(FFMPEG, ['-hide_banner', '-i', wav,
      '-af', `silencedetect=n=-32dB:d=${minDur}`, '-f', 'null', '-']);
    out = r.stderr;
  } catch (e) { out = String(e.message); }
  const sil = [];
  const re = /silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g;
  let m;
  while ((m = re.exec(out))) sil.push({ start: +m[1], end: +m[2] });
  return sil;
}

// Three takes of the same line in a row is a retake, not a point being made.
// Keeps the last one, which is the one the speaker settled on.
function findRetakes(words) {
  const t = words.map(w => w.text.toLowerCase().replace(/[^a-z0-9']/g, ''));
  const out = [];
  for (let n = 5; n >= 2; n--) {
    for (let i = 0; i + n * 2 <= t.length; i++) {
      if (out.some(r => i < r.b && i + n * 2 > r.a)) continue;
      const a = t.slice(i, i + n).join(' ');
      if (!a || a.length < 4) continue;
      let reps = 1, j = i + n;
      while (j + n <= t.length && t.slice(j, j + n).join(' ') === a) { reps++; j += n; }
      if (reps >= 2) out.push({ a: i, b: i + n * (reps - 1), phrase: a, reps, n });
    }
  }
  // "that that" and "I I": a small word said twice back to back is a stumble.
  // Content words repeat on purpose ("very very", "no no"), so leave those.
  const SMALL = new Set(['i', 'the', 'a', 'an', 'that', 'and', 'to', 'we', 'you', 'it', 'is', 'so', 'but',
    'if', 'my', 'of', 'in', 'on', 'this', 'he', 'she', 'they', 'was', 'with', 'for', 'at', 'what', 'when']);
  for (let i = 0; i + 1 < t.length; i++) {
    if (!SMALL.has(t[i]) || t[i] !== t[i + 1]) continue;
    if (out.some(r => i < r.b + r.n && i + 1 >= r.a)) continue;
    out.push({ a: i, b: i + 1, phrase: t[i], reps: 2, n: 1 });
  }
  return out.sort((x, y) => x.a - y.a);
}

// pull word boundaries back out of the silence they were stretched over
function clampToSilence(words, silences) {
  for (const w of words) {
    for (const s of silences) {
      if (s.start > w.start && s.start < w.end) w.end = Math.max(w.start + .05, s.start);
      if (s.end > w.start && s.end < w.end) w.start = Math.min(w.end - .05, s.end);
    }
  }
  return words;
}

const extractAudio = (src, dst) =>
  run(FFMPEG, ['-y', '-i', src, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dst]);

// -ml 1 with -sow gives one word per segment, which is the word-level timing
// the whole editor depends on.
function transcribe(wav, outBase, onProgress, onProc) {
  return new Promise((resolve, reject) => {
    const p = spawn(WHISPER, ['-m', MODEL, '-f', wav, '-oj', '-ojf', '-ml', '1',
      '-sow', '-wt', '0.01', '-of', outBase, '-pp', '-t', String(Math.max(2, require('os').cpus().length - 2))]);
    if (onProc) onProc(p);
    let err = '';
    p.stderr.on('data', d => {
      err += String(d).slice(-4000);
      const m = String(d).match(/progress\s*=\s*(\d+)%/g);
      if (m && onProgress) {
        const last = Number(m[m.length - 1].match(/(\d+)%/)[1]);
        onProgress(Math.max(0, Math.min(100, last)));   // whisper can report >100
      }
    });
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) return reject(new Error(err.slice(-1200) || 'transcription failed'));
      try { resolve(normalise(JSON.parse(fs.readFileSync(outBase + '.json', 'utf8')))); }
      catch (e) { reject(new Error('could not read the transcript: ' + e.message)); }
    });
  });
}

const HARD_FILLER = new Set(['um', 'uh', 'erm', 'hmm', 'mm', 'ah', 'eh', 'uhh', 'umm']);
const SOFT_FILLER = new Set(['like', 'basically', 'literally', 'actually', 'right', 'okay', 'yeah', 'so']);

function normalise(j) {
  const out = [];
  for (const s of (j.transcription || [])) {
    const text = (s.text || '').trim();
    if (!text || /^\[.*\]$/.test(text)) continue;
    const bare = text.toLowerCase().replace(/[^a-z']/g, '');
    out.push({
      i: out.length, text,
      start: (s.offsets?.from ?? 0) / 1000,
      end: (s.offsets?.to ?? 0) / 1000,
      filler: HARD_FILLER.has(bare),
      soft: SOFT_FILLER.has(bare),
      keep: true,
    });
  }
  return out;
}

/* ---------------- ranges ----------------
   Pad outward only where the neighbouring word is also kept. At a cut boundary
   whisper's words are contiguous, so padding outward would drag the cut word's
   audio back in and you hear the leftover. Trim a hair inward instead.
   gapMax also splits a run when the speaker pauses, which is silence removal. */
function ranges(words, o = {}) {
  const pad = o.pad ?? 0.06, trim = o.trim ?? 0.012;
  const gapMax = o.gapMax ?? 0;
  const env = o.env || loudness(o.wav);
  const sil = (o.silences || []).filter(s => s.end - s.start >= Math.max(gapMax, 0.2));
  const out = [];
  let i = 0;
  while (i < words.length) {
    if (!words[i].keep) { i++; continue; }
    const a = i;
    while (i + 1 < words.length && words[i + 1].keep) i++;
    const b = i;
    const cutBefore = a > 0 && !words[a - 1].keep;
    const cutAfter = b < words.length - 1 && !words[b + 1].keep;
    let start = cutBefore ? words[a].start + trim : Math.max(0, words[a].start - pad);
    let end = cutAfter ? words[b].end - trim : words[b].end + pad;
    // whisper's edges wander by a word's worth of milliseconds, so land the cut
    // in the quietest spot nearby instead of trusting them
    if (cutBefore) start = quietest(env, start, Math.max(words[a - 1].start + 0.05, start - 0.08), Math.min(words[a].end - 0.05, start + 0.06));
    if (cutAfter) end = quietest(env, end, Math.max(words[b].start + 0.05, end - 0.06), Math.min(words[b + 1].end - 0.05, end + 0.08));
    if (end - start > 0.05) out.push({ start, end, a, b });
    i++;
  }
  if (!gapMax || !sil.length) return out;

  // carve the long pauses out. What is left of each pause depends on where it
  // falls: a full stop gets a proper breath, mid-sentence gets a short one.
  const endsSentence = t => {
    let k = -1;
    for (let j = 0; j < words.length && words[j].end <= t + 0.05; j++) if (words[j].keep) k = j;
    return k >= 0 && /[.!?]["')]?$/.test(words[k].text.trim());
  };
  const cut = [];
  for (const r of out) {
    let pieces = [{ ...r }];
    for (const s of sil) {
      const next = [];
      for (const pc of pieces) {
        const os = Math.max(pc.start, s.start), oe = Math.min(pc.end, s.end);
        if (oe - os <= gapMax) { next.push(pc); continue; }
        const breath = endsSentence(os) ? 0.3 : 0.2;
        const left = { ...pc, end: Math.min(pc.end, os + breath * 0.55) };
        const right = { ...pc, start: Math.max(pc.start, oe - breath * 0.45) };
        if (left.end - left.start > 0.05) next.push(left);
        if (right.end - right.start > 0.05) next.push(right);
      }
      pieces = next;
    }
    // a sliver of speech between two carved pauses plays as a stutter on screen,
    // so give it its pause back rather than making a jump cut out of one word
    for (let k = 0; k < pieces.length; k++) {
      const pc = pieces[k];
      if (pieces.length < 2 || pc.end - pc.start >= 0.5) continue;
      const prev = pieces[k - 1], nxt = pieces[k + 1];
      const gp = prev ? pc.start - prev.end : Infinity, gn = nxt ? nxt.start - pc.end : Infinity;
      if (gp <= gn && prev) { prev.end = pc.end; pieces.splice(k, 1); k -= 1; }
      else if (nxt) { nxt.start = pc.start; pieces.splice(k, 1); k -= 1; }
    }
    cut.push(...pieces);
  }
  // a split piece inherits the parent's a and b, which would make every piece
  // claim every word and duplicate the captions many times over
  for (const r of cut) {
    let a = null, b = null;
    words.forEach((w, i) => {
      if (!w.keep) return;
      if (w.end > r.start && w.start < r.end) { if (a === null) a = i; b = i; }
    });
    r.a = a === null ? r.a : a;
    r.b = b === null ? r.b : b;
  }
  return cut.filter(r => r.a !== null).sort((x, y) => x.start - y.start);
}

// how loud a sound file is and where its peak lands, measured once per file
const sfxCache = new Map();
function sfxInfo(file) {
  if (sfxCache.has(file)) return sfxCache.get(file);
  let out = { rms: -20, peakAt: 0 };
  try {
    const buf = fs.readFileSync(file);
    let off = 12, rate = 48000, ch = 2, bits = 16, data = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4), len = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') { ch = buf.readUInt16LE(off + 10); rate = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22); }
      if (id === 'data') { data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + len)); break; }
      off += 8 + len + (len & 1);
    }
    if (data && bits === 16) {
      const n = Math.floor(data.length / 2 / ch), win = Math.round(rate * 0.01);
      let sum = 0, best = 0, bestAt = 0, acc = 0;
      for (let i = 0; i < n; i++) {
        let v = 0; for (let c = 0; c < ch; c++) v += data.readInt16LE((i * ch + c) * 2) / 32768; v /= ch;
        sum += v * v; acc += v * v;
        if ((i + 1) % win === 0) { if (acc > best) { best = acc; bestAt = i / rate; } acc = 0; }
      }
      // loudness over the part that carries the sound, not the silent tail
      out = { rms: 10 * Math.log10(sum / Math.max(1, Math.min(n, rate * 0.5)) + 1e-12), peakAt: bestAt };
    }
  } catch (e) {}
  sfxCache.set(file, out);
  return out;
}

// the speaking level of the kept audio in dB, from the 10ms envelope
function speechLevel(wav, rs) {
  const env = loudness(wav);
  if (!env) return -20;
  const vals = [];
  for (const r of rs) for (let f = Math.floor(r.start * 100); f < Math.min(env.length, r.end * 100); f++) {
    const db = 10 * Math.log10(env[f] + 1e-12);
    if (db > -45) vals.push(db);
  }
  if (!vals.length) return -20;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.6)];
}

// 10ms loudness envelope of the project's 16k mono wav, read once per file
const envCache = new Map();
function loudness(wav) {
  if (!wav) return null;
  try {
    const st = fs.statSync(wav), key = wav + ':' + st.mtimeMs;
    if (envCache.has(key)) return envCache.get(key);
    const buf = fs.readFileSync(wav);
    let off = 12, data = null, rate = 16000;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4), len = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') rate = buf.readUInt32LE(off + 12);
      if (id === 'data') { data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + len)); break; }
      off += 8 + len + (len & 1);
    }
    if (!data) return null;
    const hop = Math.round(rate / 100), n = Math.floor(data.length / 2 / hop);
    const e = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      let sum = 0;
      for (let k = 0; k < hop; k++) { const v = data.readInt16LE((f * hop + k) * 2) / 32768; sum += v * v; }
      e[f] = sum / hop;
    }
    envCache.clear(); envCache.set(key, e);
    return e;
  } catch (err) { return null; }
}

// the quietest 30ms inside [lo, hi], nudged toward the original point on ties
function quietest(env, t, lo, hi) {
  if (!env || !(hi > lo)) return t;
  let best = t, bestV = Infinity;
  for (let f = Math.ceil(lo * 100); f <= Math.floor(hi * 100); f++) {
    if (f < 1 || f + 1 >= env.length) continue;
    const v = (env[f - 1] + env[f] + env[f + 1]) * (1 + Math.abs(f / 100 - t));
    if (v < bestV) { bestV = v; best = f / 100; }
  }
  return best;
}

// original timestamp -> position in the cut timeline
function remap(t, rs) {
  let acc = 0;
  for (const r of rs) {
    if (t < r.start) return acc;
    if (t <= r.end) return acc + (t - r.start);
    acc += r.end - r.start;
  }
  return acc;
}

// group kept words into caption chunks on the output timeline
function captionChunks(words, rs, { maxWords = 6, maxDur = 2.8 } = {}) {
  const caps = [];
  for (const r of rs) {
    let cur = null;
    for (let i = r.a; i <= r.b; i++) {
      const w = words[i];
      if (!w.keep) continue;
      if (w.end <= r.start || w.start >= r.end) continue;   // not inside this piece
      const s = remap(Math.max(w.start, r.start), rs);
      const e = remap(Math.min(w.end, r.end), rs);
      const tok = { text: w.text, start: s, end: e };
      if (!cur) cur = { text: w.text, start: s, end: e, n: 1, words: [tok] };
      else if (cur.n >= maxWords || e - cur.start > maxDur || /[.?!]$/.test(cur.text)) {
        caps.push(cur); cur = { text: w.text, start: s, end: e, n: 1, words: [tok] };
      } else { cur.text += ' ' + w.text; cur.end = e; cur.n++; cur.words.push(tok); }
    }
    if (cur) caps.push(cur);
  }
  return caps.map(c => ({ text: c.text.trim(), start: c.start,
    end: Math.max(c.end, c.start + .35), words: c.words }));
}

const pad2 = n => String(n).padStart(2, '0');
const srtTime = t => {
  const ms = Math.round(t * 1000);
  return `${pad2((ms / 3600000) | 0)}:${pad2(((ms / 60000) | 0) % 60)}:${pad2(((ms / 1000) | 0) % 60)},${String(ms % 1000).padStart(3, '0')}`;
};
const srt = caps => caps.map((c, i) =>
  `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');

// words per card, matched to what each caption style is built for
const CHUNK = { scrawl: 3, story: 6, seam: 2, minimal: 4, plate: 3, pop: 3, single: 1, clean: 5, karaoke: 6, outline: 6, box: 6 };

const ASPECTS = {
  source: null,
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '16:9': [1920, 1080],
  '4:5': [1080, 1350],
};

// Where the person is at a set of times, read off the mask video. Each entry is
// the box of white pixels, as fractions of the frame, or null if nobody is there.
async function faceBoxes(mask, times, W, H) {
  if (!times.length) return [];
  const dir = path.join(path.dirname(mask), 'facebox');
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const sel = times.map(t => `lt(prev_pts*TB,${t.toFixed(3)})*gte(pts*TB,${t.toFixed(3)})`).join('+');
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-i', mask, '-vf', `select='${sel}',scale=120:-1`,
    '-fps_mode', 'passthrough', path.join(dir, 'f%03d.png')]).catch(() => {});
  const py = `
import json,os,sys
from PIL import Image
d=sys.argv[1]; out=[]
for f in sorted(os.listdir(d)):
    im=Image.open(os.path.join(d,f)).convert('L').point(lambda v:255 if v>96 else 0)
    b=im.getbbox()
    out.append(None if not b else [b[0]/im.width,b[1]/im.height,b[2]/im.width,b[3]/im.height])
print(json.dumps(out))`;
  const { stdout } = await run(BIN.python(), ['-c', py, dir]).catch(() => ({ stdout: '[]' }));
  const boxes = JSON.parse(stdout || '[]');
  while (boxes.length < times.length) boxes.push(boxes[boxes.length - 1] || null);
  return boxes;
}

// pick, per caption, the emptiest side of the head and a size that suits the line
function placeAround(caps, boxes, style) {
  // one anchor, held until the head moves a real distance; consistent beats clever
  let anchor = null, lastHead = null;
  caps.forEach((c, i) => {
    const b = boxes[i];
    const n = (c.words || []).length || c.text.split(' ').length;
    const mult = n <= 2 ? 1.3 : 1.0;
    if (!b) { c.pos = anchor ? { ...anchor, mult } : { cx: .5, cy: .78, mult }; return; }
    const [x0, y0, x1, y1] = b;
    const head = { top: y0, cx: (x0 + x1) / 2 };
    const moved = !lastHead || Math.abs(head.top - lastHead.top) > .12 || Math.abs(head.cx - lastHead.cx) > .18;
    if (!anchor || moved) {
      // prefer under the chin, then above the head, then the emptier side
      const chin = Math.min(.9, y0 + Math.min(.42, (y1 - y0) * .55) + .06);
      if (chin < .88) anchor = { cx: .5, cy: chin };
      else if (y0 > .28) anchor = { cx: .5, cy: y0 - .11 };
      else anchor = { cx: head.cx > .5 ? Math.max(.2, x0 / 2) : Math.min(.8, x1 + (1 - x1) / 2), cy: .5 };
      lastHead = head;
    }
    c.pos = { ...anchor, mult };
  });
  return caps;
}

/* Things were landing on top of each other and on his face. This spreads them:
   one at a time, a breath between, and each one placed where the face is not. */
// How long a thing is allowed to hold the screen. Anything longer is a slide, not an edit.
const MAX_HOLD = { pop: 1.4, hook: 3.5, card: 3.0, tweet: 3.5, image: 3.0, broll: 6.0, motion: 4.0 };
// these take the whole frame, so nothing else may share their window
const EXCLUSIVE = new Set(['card', 'broll']);

function schedule(items, faces, W, H, total) {
  const GAP = 0.8;                           // a breath between one thing ending and the next
  items.sort((a, b) => a.at - b.at);
  const kept = [];
  let freeFrom = 0;
  for (const it of items) {
    const key = it.ov.type === 'pop' ? (it.ov.kind === 'namecard' ? 'hook' : 'pop') : it.ov.type;
    it.dur = Math.min(it.ov.dur || 3, MAX_HOLD[key] ?? 3);
    if (it.at < freeFrom) it.at = freeFrom;                 // no overlapping, ever
    if (it.at + it.dur > total - 0.3) continue;             // no room left, drop it
    freeFrom = it.at + it.dur + GAP;
    kept.push(it);
  }
  return kept;
}

// the face box nearest a moment, in source time, or null
function faceNear(faces, t) {
  if (!faces || !faces.length) return null;
  let best = null, bd = 1e9;
  for (const f of faces) { const d = Math.abs(f.t - t); if (d < bd) { bd = d; best = f; } }
  return best && bd < 3 && best.box ? best.box : null;
}

// The left (or top) edge of a crop window over time, as an ffmpeg expression.
// Holds still while the speaker stays roughly put, and glides over half a second
// when they move or the shot changes, so the frame never jitters with the detector.
function panPath(pts, key, half) {
  const clamp = v => Math.max(half, Math.min(1 - half, v)) - half;
  const holds = [];
  let run = [pts[0]];
  const flush = () => {
    const vals = run.map(p => p[key]).sort((a, b) => a - b);
    holds.push({ t0: run[0].t, t1: run[run.length - 1].t, v: clamp(vals[vals.length >> 1]) });
  };
  for (let i = 1; i < pts.length; i++) {
    const vals = run.map(p => p[key]).sort((a, b) => a - b), med = vals[vals.length >> 1];
    // a jump bigger than a sixth of the window, seen twice in a row, is a real move
    const far = Math.abs(pts[i][key] - med) > half / 3;
    const farNext = i + 1 < pts.length && Math.abs(pts[i + 1][key] - med) > half / 3;
    if (far && farNext) { flush(); run = [pts[i]]; } else run.push(pts[i]);
  }
  flush();
  const merged = [];
  for (const h of holds) {
    const last = merged[merged.length - 1];
    if (last && (h.t1 - h.t0 < 1 || Math.abs(h.v - last.v) < 0.01)) { last.t1 = h.t1; continue; }
    merged.push({ ...h });
  }
  const H = merged.slice(-60);
  let e = H[H.length - 1].v.toFixed(4);
  for (let i = H.length - 2; i >= 0; i--) {
    const a = H[i], b = H[i + 1], g0 = Math.max(a.t1, b.t0 - 0.5), g1 = g0 + 0.5;
    e = `if(lt(t,${g0.toFixed(3)}),${a.v.toFixed(4)},if(lt(t,${g1.toFixed(3)}),${a.v.toFixed(4)}+(${(b.v - a.v).toFixed(4)})*(t-${g0.toFixed(3)})/0.5,${e}))`;
  }
  // the same path as a function, so things placed on top know where the window is
  const at = t => {
    for (let i = 0; i < H.length - 1; i++) {
      const a = H[i], b = H[i + 1], g0 = Math.max(a.t1, b.t0 - 0.5), g1 = g0 + 0.5;
      if (t < g0) return a.v;
      if (t < g1) return a.v + (b.v - a.v) * (t - g0) / 0.5;
    }
    return H[H.length - 1].v;
  };
  return { expr: e, at };
}

// The shape of the output: how much of the source the frame shows, and for the
// story look, the band the picture sits in. The band is cropped once, around the
// speaker, instead of cropping to vertical first and then again to the band.
function frameGeometry(info, W, H, letterbox) {
  const srcAr = (info.width || 16) / (info.height || 9);
  let bandH = H, bandY = 0;
  if (letterbox) {
    // half the frame: tall enough to read the speaker, cropped around them if the source is wide
    bandH = Math.round(H * 0.5 / 2) * 2;
    bandY = Math.round((H - bandH) / 2);
  }
  const cropAr = W / bandH;
  return { W, H, srcAr, cropAr, bandH, bandY, cw: Math.min(1, cropAr / srcAr), ch: Math.min(1, srcAr / cropAr) };
}

// where the crop window sits over the source, following the speaker
function cropWindow(faces, rs, geo) {
  const win = { x: null, y: null };
  if (faces && faces.length > 1 && (geo.cw < 1 || geo.ch < 1)) {
    const pts = [];
    for (const r of rs) for (let tt = r.start; tt < r.end; tt += 0.5) {
      const f = faceNear(faces, tt);
      if (f) pts.push({ t: remap(tt, rs), cx: (f[0] + f[2]) / 2, cy: (f[1] + f[3]) / 2 });
    }
    if (pts.length > 1) {
      if (geo.cw < 1) win.x = panPath(pts, 'cx', geo.cw / 2);
      // faces sit in the top half of a frame, so a vertical crop keeps some headroom
      if (geo.ch < 1) win.y = panPath(pts.map(p => ({ ...p, cy: p.cy + geo.ch * 0.12 })), 'cy', geo.ch / 2);
    }
  }
  win.at = tOut => ({ x0: win.x ? win.x.at(tOut) : (1 - geo.cw) / 2, y0: win.y ? win.y.at(tOut) : (1 - geo.ch) / 2 });
  return win;
}

// face boxes moved from the source frame into the output frame
function framedFaces(faces, rs, geo, win) {
  return (faces || []).map(f => {
    const { x0, y0 } = win.at(remap(f.t, rs));
    const b = f.box;
    const fx = v => (v - x0) / geo.cw, fy = v => (geo.bandY + ((v - y0) / geo.ch) * geo.bandH) / geo.H;
    return { t: f.t, box: [fx(b[0]), fy(b[1]), fx(b[2]), fy(b[3])] };
  }).filter(f => f.box[2] > 0 && f.box[0] < 1);
}

// for the server: the speaker's face in the frame an overlay will be drawn on
function frameFaces({ words, silences, wav, gapMax, info, aspect, letterbox, faces }) {
  const rs = ranges(words, { gapMax: gapMax || 0, silences: silences || [], wav });
  const [W, H] = ASPECTS[aspect] || [info.width, info.height];
  const geo = frameGeometry(info, W, H, !!letterbox);
  return framedFaces(faces, rs, geo, cropWindow(faces, rs, geo));
}

/* Put a thing where the face is not. Returns x,y as fractions of the frame. */
function clearOf(face, w, h, prefer) {
  // w,h are the item's size as fractions of the frame
  const pad = .04;
  const cands = [];
  if (face) {
    const [fx0, fy0, fx1, fy1] = face;
    // above the head, below the chin, then the emptier side
    if (fy0 - h - pad > pad) cands.push({ x: (1 - w) / 2, y: Math.max(pad, fy0 - h - pad), why: 'above' });
    if (fy1 + pad + h < 1 - pad) cands.push({ x: (1 - w) / 2, y: Math.min(1 - h - pad, fy1 + pad), why: 'below' });
    if (fx0 - w - pad > 0) cands.push({ x: Math.max(pad, fx0 - w - pad), y: Math.max(pad, Math.min(1 - h - pad, (fy0 + fy1) / 2 - h / 2)), why: 'left' });
    if (fx1 + w + pad < 1) cands.push({ x: Math.min(1 - w - pad, fx1 + pad), y: Math.max(pad, Math.min(1 - h - pad, (fy0 + fy1) / 2 - h / 2)), why: 'right' });
  }
  cands.push({ x: (1 - w) / 2, y: prefer === 'low' ? Math.min(1 - h - pad, .66) : .10, why: 'default' });
  if (prefer === 'above') { const a = cands.find(c => c.why === 'above'); if (a) return a; }
  if (prefer === 'below') { const b = cands.find(c => c.why === 'below'); if (b) return b; }
  return cands[0];
}

// A long clip makes hundreds of captions, and one ffmpeg input each runs the
// process out of file descriptors. So they get baked into a single track with
// an alpha channel and composited in one overlay.
async function buildCaptionTrack(caps, W, H, outdir, style, total) {
  const files = await renderCaptions(caps, W, H, outdir, style);
  return buildTrack(files, outdir, total);
}

// any timed set of full-frame PNGs becomes one alpha track this way
async function buildTrack(files, outdir, total) {
  if (!files.length) return null;
  const blank = path.join(outdir, 'blank.png');
  if (!fs.existsSync(blank)) {
    await run(BIN.python(), ['-c',
      `from PIL import Image;import sys;Image.new('RGBA',(${files[0].w || 1080},${files[0].h || 1920}),(0,0,0,0)).save('${blank}')`]);
  }
  const listPath = path.join(outdir, 'list.txt');
  const track = path.join(outdir, 'track_' + Date.now().toString(36) + '.mov');
  // Everything is counted in whole frames of the 30fps track. Padding short frames
  // up to a minimum while the clock kept the unpadded end made the track run long,
  // so animated captions (a few 33ms frames per word) drifted seconds behind the
  // speech by the end of a clip.
  const FPS = 30, fr = s => Math.round(s * FPS);
  const L = [];
  let at = 0;                                            // frames already written
  for (const f of files) {
    const a = Math.max(fr(f.start), at), b = Math.max(fr(f.end), a + 1);
    if (a > at) L.push(`file '${blank}'`, `duration ${((a - at) / FPS).toFixed(4)}`);
    L.push(`file '${f.file}'`, `duration ${((b - a) / FPS).toFixed(4)}`);
    at = b;
  }
  if (fr(total) > at) L.push(`file '${blank}'`, `duration ${((fr(total) - at) / FPS).toFixed(4)}`);
  L.push(`file '${blank}'`);        // the concat demuxer drops the final entry's duration
  fs.writeFileSync(listPath, L.join('\n'));
  await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c:v', 'qtrle', '-pix_fmt', 'argb', '-r', '30', track]);
  return track;
}

async function renderCaptions(caps, W, H, outdir, style = {}) {
  if (!caps.length) return [];
  fs.rmSync(outdir, { recursive: true, force: true });
  const cfg = JSON.stringify({ width: W, height: H, outdir, captions: caps, ...style });
  // execFile has no stdin option, so the config has to be written to the child directly
  const stdout = await new Promise((resolve, reject) => {
    const pr = spawn(BIN.python(), [CAPPY]);
    let out = '', err = '';
    pr.stdout.on('data', d => out += d);
    pr.stderr.on('data', d => err += d);
    pr.on('error', reject);
    pr.on('close', c => c === 0 ? resolve(out)
      : reject(new Error('caption rendering failed: ' + err.slice(-500))));
    pr.stdin.write(cfg);
    pr.stdin.end();
  });
  return JSON.parse(stdout);
}

/* ---------------- render ---------------- */
async function render(src, words, dst, opts = {}, onProgress, onProc) {
  const info = opts.info || await probe(src);
  const draft = !!opts.draft;                       // quick look, not the finished thing
  let rs = ranges(words, { gapMax: opts.gapMax || 0, silences: opts.silences || [], wav: opts.wav });
  if (!rs.length) throw new Error('Everything is cut, so there is nothing to export.');
  // an opening-only render: four hooks cost seconds to compare instead of minutes
  if (opts.onlyFirst) {
    const keep = [];
    let acc = 0;
    for (const r of rs) {
      const take = Math.min(r.end - r.start, opts.onlyFirst - acc);
      if (take <= 0.05) break;
      keep.push({ ...r, end: r.start + take });
      acc += take;
      if (acc >= opts.onlyFirst) break;
    }
    if (keep.length) rs = keep;
  }

  const F = 0.03;
  const g = [], labels = [];
  rs.forEach((seg, i) => {
    const d = seg.end - seg.start;
    g.push(`[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    g.push(`[0:a]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=${F},afade=t=out:st=${Math.max(0, d - F).toFixed(3)}:d=${F}[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  g.push(`${labels.join('')}concat=n=${rs.length}:v=1:a=1[vc][ac]`);

  // The camera follows the speaker. A locked-off shot never feels edited, however
  // many cuts are in it; a slow push that keeps the face in frame does. Built from
  // the face boxes, smoothed so it drifts rather than jerks.
  let vlab = '[vc]';
  if (opts.follow && opts.faces && opts.faces.length > 2) {
    const z = Math.max(1.05, Math.min(1.6, opts.followZoom || 1.22));
    // sample the face path across the cut timeline, then smooth it
    const pts = [];
    for (const r of rs) for (let tt = r.start; tt < r.end; tt += 0.5) {
      const f = faceNear(opts.faces, tt);
      if (f) pts.push({ t: remap(tt, rs), cx: (f[0] + f[2]) / 2, cy: (f[1] + f[3]) / 2 });
    }
    if (pts.length > 2) {
      const K = 9;                                  // a wide window, so it drifts
      const smAll = pts.map((p0, i) => {
        const a = Math.max(0, i - K), b = Math.min(pts.length, i + K + 1);
        const w = pts.slice(a, b);
        return { t: p0.t, cx: w.reduce((s, x) => s + x.cx, 0) / w.length, cy: w.reduce((s, x) => s + x.cy, 0) / w.length };
      });
      // ffmpeg cannot take a conditional per sample, and it does not need to: a
      // handful of keyframes across the clip gives the same slow drift
      const STEPS = 8;
      const sm = Array.from({ length: STEPS }, (_, i) =>
        smAll[Math.min(smAll.length - 1, Math.round(i * (smAll.length - 1) / (STEPS - 1)))]);
      const cw = 1 / z, ch = 1 / z;
      const clamp = (v, half) => Math.max(half, Math.min(1 - half, v));
      const expr = (key, half) => {
        // a piecewise ramp: ffmpeg reads it as one long conditional over time
        let e = `${(clamp(sm[0][key], half) - half).toFixed(4)}`;
        for (let i = 1; i < sm.length; i++) {
          const t0 = sm[i - 1].t, t1 = sm[i].t;
          if (t1 - t0 < 0.01) continue;
          const v0 = clamp(sm[i - 1][key], half) - half, v1 = clamp(sm[i][key], half) - half;
          e = `if(lt(t,${t0.toFixed(3)}),${e},if(lt(t,${t1.toFixed(3)}),${v0.toFixed(4)}+(${(v1 - v0).toFixed(4)})*(t-${t0.toFixed(3)})/${(t1 - t0).toFixed(3)},${v1.toFixed(4)}))`;
        }
        return e;
      };
      g.push(`[vc]crop=iw/${z}:ih/${z}:'iw*(${expr('cx', cw / 2)})':'ih*(${expr('cy', ch / 2)})',` +
        `scale=${info.width || 1080}:${info.height || 1920}:flags=bicubic,setsar=1[fol]`);
      vlab = '[fol]';
    }
  }
  const target = ASPECTS[opts.aspect] || null;
  let W = info.width, H = info.height;
  if (target) [W, H] = target;
  // A draft draws EVERYTHING small, not just the last step. The cost is compositing
  // hundreds of full-size overlays, so shrinking at the end would save nothing.
  if (draft && H > 640) {
    const k = 640 / H;
    W = Math.round(W * k / 2) * 2; H = Math.round(H * k / 2) * 2;
  }
  const geo = frameGeometry(info, W, H, !!(opts.letterbox && target));
  const win = cropWindow(opts.follow ? null : opts.faces, rs, geo);
  if (target || draft) {
    const ar = geo.cropAr.toFixed(6);
    const cx = win.x ? `iw*(${win.x.expr})` : '(iw-ow)/2', cy = win.y ? `ih*(${win.y.expr})` : '(ih-oh)/2';
    const fl = draft ? 'bilinear' : 'lanczos';
    g.push(`${vlab}crop='min(iw,ih*${ar})':'min(ih,iw/${ar})':'${cx}':'${cy}',scale=${W}:${geo.bandH}:flags=${fl},setsar=1` +
      (geo.bandH < H ? `,pad=${W}:${H}:0:${geo.bandY}:black` : '') + `[vr]`);
    vlab = '[vr]';
  }
  // everything drawn on top reads the face where it ends up in this frame
  const faces = opts.follow ? (opts.faces || []) : framedFaces(opts.faces, rs, geo, win);

  // Work out when everything happens before drawing any of it, so the reframes,
  // the captions and the stickers all agree about the same timeline.
  const totalDur = rs.reduce((s, r) => s + (r.end - r.start), 0);
  const sched = schedule((opts.overlays || []).filter(o => fs.existsSync(o.file)).map(o => {
    const w = words[o.word] || words[0];
    return { ov: o, at: w ? remap(Math.max(w.start, rs[0].start), rs) : 0, srcT: w ? w.start : 0 };
  }), faces, W, H, totalDur);

  // the speaker shrinks into a corner while an insert has the frame, the way
  // the usual way, with a blurred copy of the frame filling the rest
  for (const [ri, rf] of (opts.reframes || []).entries()) {
    const a = remap(Math.max((words[rf.word] || words[0]).start, rs[0].start), rs);
    // a split exists to hold something, so it ends when that thing ends and the
    // panel is never left sitting there empty
    let rfDur = Math.max(0.5, rf.dur || 6);
    if (rf.layout === 'split' || rf.corner === 'split') {
      const held = sched.filter(s => s.ov.slot === 'top' || s.ov.corner === 'top')
        .map(s => s.at + s.dur).filter(e => e > a);
      rfDur = held.length ? Math.min(rfDur, Math.max(...held) - a + 0.2) : Math.min(rfDur, 2.5);
    }
    const b = a + rfDur;
    // "split": white panel on top, the speaker full width below
    const split = rf.layout === 'split' || rf.corner === 'split';
    const sc = split ? 1 : Math.max(.2, Math.min(.8, rf.scale || .42));
    const srcAr = (info.width || 16) / (info.height || 9);
    // the speaker keeps the camera's own shape in the split: a 16:9 source sits in a
    // 16:9 panel across the full width, nothing squeezed, nothing cropped tight
    const sw = split ? W : Math.round(W * sc / 2) * 2;
    // the white panel is sized by what goes in it: a tall card gets more, a wide
    // screen recording gets a 16:9 band, so the two halves balance to the content
    let topH = Math.round(H * 0.5);
    if (split) {
      const wa = words[rf.word] || words[0];
      const ins = (opts.overlays || []).find(o => (o.slot === 'top' || o.corner === 'top') && Math.abs((words[o.word] || words[0]).start - wa.start) < (rf.dur || 6) + 1);
      if (ins && ins.ar) topH = Math.round(Math.min(H * 0.52, Math.max(H * 0.34, W * 0.88 * ins.ar + H * 0.06)));
      else if (ins) topH = Math.round(H * 0.5);
    }
    const sh = split ? Math.round(Math.min(H - topH, Math.max(H * 0.34, W / Math.max(1, srcAr))) / 2) * 2 : Math.round(H * sc / 2) * 2;
    const pad = Math.round(W * .04);
    const pos = split ? [0, Math.max(topH, H - sh)] : { bl: [pad, H - sh - pad], br: [W - sw - pad, H - sh - pad],
                  tl: [pad, pad], tr: [W - sw - pad, pad] }[rf.corner || 'bl'];
    g.push(`${vlab}split=2[rfa${ri}][rfb${ri}]`);
    if (split) {
      g.push(`[rfa${ri}]drawbox=x=0:y=0:w=${W}:h=${H}:color=white@1:t=fill[rbg${ri}]`);
      // pull the speaker panel from the uncut, uncropped camera frame
      rs.forEach((seg, i) => g.push(`[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS[sp${ri}_${i}]`));
      g.push(`${rs.map((_, i) => `[sp${ri}_${i}]`).join('')}concat=n=${rs.length}:v=1:a=0[spc${ri}]`);
      // frame the speaker, not the room: crop around the face so the bottom panel
      // is a person, rather than a wide stage with someone small on it
      const f = faceNear(opts.faces, (words[rf.word] || words[0]).start);
      let cropExpr = `crop=${sw}:${sh}:(iw-ow)/2:0`;
      if (f) {
        const [fx0, fy0, fx1, fy1] = f;
        const fw = fx1 - fx0, fh = fy1 - fy0;
        // show about five head-heights, which puts him chest-up in the panel
        const want = Math.min(1, Math.max(fw * 4.2, fh * 3.4 * (sh / sw) / ((info.height || 9) / (info.width || 16))));
        const cw = Math.min(1, want), ch = Math.min(1, cw * (sh / sw) * ((info.width || 16) / (info.height || 9)));
        const cx = Math.min(1 - cw, Math.max(0, (fx0 + fx1) / 2 - cw / 2));
        const cy = Math.min(1 - ch, Math.max(0, fy0 - ch * 0.22));
        cropExpr = `crop=iw*${cw.toFixed(4)}:ih*${ch.toFixed(4)}:iw*${cx.toFixed(4)}:ih*${cy.toFixed(4)}`;
      }
      g.push(`[spc${ri}]${cropExpr},scale=${sw}:${sh},setsar=1[rsm${ri}]`);
    } else {
      g.push(`[rfa${ri}]gblur=sigma=28,eq=brightness=-0.12[rbg${ri}]`);
      g.push(`${vlab}split=2[rfd${ri}][rfc${ri}]`);
      g.push(`[rfc${ri}]scale=${sw}:${sh}[rsm${ri}]`);
    }
    g.push(`[rbg${ri}]${split ? `[rfb${ri}]` : `[rfd${ri}]`}overlay=0:0:enable='not(between(t,${a.toFixed(3)},${b.toFixed(3)}))'[rmid${ri}]`);
    g.push(`[rmid${ri}][rsm${ri}]overlay=${pos[0]}:${pos[1]}:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'[rf${ri}]`);
    vlab = `[rf${ri}]`;
  }

  const inputs = ['-i', src];
  let inN = 1;
  const behind = (opts.overlays || []).some(o => o.behind) || opts.capBehind;
  const FLAT = () => (maskIdx >= 0 ? '[flat]' : '[vo]');
  let maskIdx = -1;
  if (behind && opts.mask && fs.existsSync(opts.mask)) {
    inputs.push('-i', opts.mask);
    maskIdx = inN++;
  }


  // stickers: tweet cards, screenshots, b-roll stills. Each one is pinned to a
  // word, so it lands at the right moment even after cuts move everything.
  for (const s of sched) {
    const ov = s.ov;
    const at = s.at;
    const dur = Math.max(0.4, s.dur ?? ov.dur ?? 3);
    // a corner preset beats raw x/y, and a pip clip sits small in a corner by default
    const CORNERS = { tl: [0.04, 0.05], tr: [null, 0.05], bl: [0.04, null], br: [null, null] };
    let sc = ov.scale || 0.78;
    if (ov.pip && !ov.scale) sc = 0.5;
    let ow = Math.round(W * sc);
    let x = ov.x === undefined ? '(W-w)/2' : Math.round(W * ov.x);
    let y = ov.y === undefined ? '(H-h)/2' : Math.round(H * ov.y);
    if (ov.corner === 'top' || ov.slot === 'top') {          // inside the white panel
      sc = ov.scale && ov.scale < 1 ? ov.scale : 0.88;
      if (ov.ar) { const maxH = H * 0.52 - H * 0.06; if (W * sc * ov.ar > maxH) sc = maxH / (W * ov.ar); }
      x = Math.round(W * (1 - sc) / 2); y = Math.round(H * 0.03);
    } else if (ov.corner && CORNERS[ov.corner]) {
      const [cx, cy] = CORNERS[ov.corner];
      x = cx === null ? `W-w-${Math.round(W * 0.04)}` : Math.round(W * cx);
      y = cy === null ? `H-h-${Math.round(H * 0.05)}` : Math.round(H * cy);
    } else if (ov.x === undefined || ov.auto) {
      // nothing said where it goes, so put it clear of the face
      const face = faceNear(faces, s.srcT);
      let ih = sc * (ov.ar || 0.6);
      if (ih > 0.8) { sc = sc * (0.8 / ih); ih = 0.8; ow = Math.round(W * sc); }   // never taller than the frame
      const pos = clearOf(face, sc, ih, ov.type === 'pop' ? 'above' : null);
      x = Math.round(W * pos.x); y = Math.round(H * pos.y);
    }
    // whatever decided the position, keep the whole thing on screen
    if (typeof y === 'number') y = Math.max(0, Math.min(H - Math.round(ow * (ov.ar || 0.6)), y));
    if (typeof x === 'number') x = Math.max(0, Math.min(W - ow, x));
    if (ov.corner === 'top' || ov.slot === 'top') ow = Math.round(W * sc);
    inputs.push('-i', ov.file);
    const isVid = /\.(mp4|mov|webm|mkv)$/i.test(ov.file);
    // a clip carries its own clock, so shift it to land where the word does
    g.push(isVid
      ? `[${inN}:v]scale=${ow}:-1,setpts=PTS-STARTPTS+${at.toFixed(3)}/TB[sk${inN}]`
      : `[${inN}:v]scale=${ow}:-1[sk${inN}]`);
    g.push(`${vlab}[sk${inN}]overlay=${x}:${y}:enable='between(t,${at.toFixed(3)},${(at + dur).toFixed(3)})'[sv${inN}]`);
    vlab = `[sv${inN}]`;
    inN++;
  }

  // accumulating lists and pill stacks, one track each
  for (const [li, ls] of (opts.lists || []).entries()) {
    if (!ls.lines || !ls.lines.length) continue;
    const dir = path.join(path.dirname(dst), 'list' + li);
    fs.rmSync(dir, { recursive: true, force: true });
    const cfgL = JSON.stringify({ width: W, height: H, outdir: dir, lines: ls.lines,
      x: ls.x, y: ls.y, size: ls.size, face: ls.face, numbered: ls.numbered !== false,
      look: ls.look || 'plain' });
    const outL = await new Promise((resolve, reject) => {
      const pr = spawn(BIN.python(), [path.join(__dirname, 'list.py')]);
      let o = '', e = '';
      pr.stdout.on('data', d => o += d); pr.stderr.on('data', d => e += d);
      pr.on('close', c => c === 0 ? resolve(JSON.parse(o)) : reject(new Error('list: ' + e.slice(-300))));
      pr.stdin.write(cfgL); pr.stdin.end();
    });
    const total = rs.reduce((s, r) => s + (r.end - r.start), 0);
    const times = ls.lines.map(l => remap(Math.max((words[l.word] || words[0]).start, rs[0].start), rs));
    // a list builds, holds for a moment once it is complete, then leaves. It does
    // not sit on the screen for the rest of the video.
    const hold = ls.hold ?? 3.5;
    const SPAN = ls.span ?? 14;      // lines further apart than this are not one list
    const files = [];
    for (let i = 0; i < outL.files.length; i++) {
      const next = times[i + 1];
      const breaks = next === undefined || next - times[i] > SPAN;
      files.push({ file: outL.files[i], w: W, h: H, start: times[i],
        end: breaks ? Math.min(total, times[i] + hold) : next });
      if (breaks && next !== undefined) {
        // the run ended; the next line starts a list of its own rather than
        // adding to one that has been on screen for half a minute
        break;
      }
    }
    const track = await buildTrack(files, dir, total);
    if (track) {
      inputs.push('-i', track);
      // a card or clip owns the frame while it is up, so the list hides under it
      const hide = sched.filter(s => EXCLUSIVE.has(s.ov.type))
        .map(s => `between(t,${s.at.toFixed(3)},${(s.at + s.dur).toFixed(3)})`);
      for (const rf of (opts.reframes || [])) if (rf.layout === 'split' || rf.corner === 'split') {
        const w = words[rf.word] || words[0]; const a = remap(Math.max(w.start, rs[0].start), rs);
        hide.push(`between(t,${a.toFixed(3)},${(a + Math.max(.5, rf.dur || 6)).toFixed(3)})`);
      }
      const en = hide.length ? `:enable='not(${hide.join('+')})'` : '';
      g.push(`${vlab}[${inN}:v]overlay=0:0:shortest=0${en}[ls${li}]`);
      vlab = `[ls${li}]`;
      inN++;
    }
  }

  // The purple cow is the beat worth remarking on, not a colour. A hue rotation
  // just tints the frame purple and reads as a filter, so this is an emphasis
  // hit instead: the camera snaps in, the image lifts for an instant, then it
  // settles back. You feel the jolt without the footage changing colour.
  for (const [ci, cow] of (opts.cows || []).entries()) {
    const w = words[cow.word] || words[0];
    const a = remap(Math.max(w.start, rs[0].start), rs);
    const b = a + Math.max(0.3, cow.dur || 0.7);
    const amp = Math.min(0.30, Math.max(0.04, cow.amp ?? 0.12));
    const A = a.toFixed(3), B = b.toFixed(3);
    // snap in over ~2 frames, settle over the rest of the hold
    const z = `(1+${amp}*exp(-(t-${A})*7))`;
    const zf = `if(between(t,${A},${B}),${z},1)`;
    g.push(`${vlab}crop=w='iw/(${zf})':h='ih/(${zf})':x='(iw-ow)/2':y='(ih-oh)/2',` +
      `scale=${W}:${H},setsar=1[cwz${ci}]`);
    // one bright frame on the hit, then contrast and colour sit slightly up
    const fl = `if(between(t,${A},${B}),0.16*exp(-(t-${A})*26),0)`;
    const ct = `if(between(t,${A},${B}),1+0.14*exp(-(t-${A})*5),1)`;
    const st = `if(between(t,${A},${B}),1+0.18*exp(-(t-${A})*5),1)`;
    g.push(`[cwz${ci}]eq=brightness='${fl}':contrast='${ct}':saturation='${st}'[cw${ci}]`);
    vlab = `[cw${ci}]`;
  }

  // Sections. A look belongs to a stretch, not the whole timeline: captions can
  // run for the first half only, a grade can sit on one passage, the letterbox can
  // come and go. Each section names its own window in output time.
  const sections = (opts.sections || []).map(s => {
    const a = words[s.from] ? remap(Math.max(words[s.from].start, rs[0].start), rs) : 0;
    const b = words[s.to] ? remap(Math.min(words[s.to].end, rs[rs.length - 1].end), rs) : totalDur;
    return { ...s, a, b };
  }).filter(s => s.b > s.a);

  // a grade over everything, or over the sections that ask for one
  const GRADES = {
    warm:  'eq=contrast=1.08:saturation=1.12:gamma=0.98,colorbalance=rs=.05:gs=.01:bs=-.06:rm=.03:bm=-.04',
    film:  'eq=contrast=1.12:saturation=0.9:gamma=1.02,colorbalance=rs=.03:bs=.04:rh=-.02:bh=.03,vignette=PI/5',
    clean: 'eq=contrast=1.05:saturation=1.05:brightness=0.01',
    punch: 'eq=contrast=1.22:saturation=1.25:gamma=0.96',
    mono:  'hue=s=0,eq=contrast=1.15:gamma=1.05',
    cool:  'eq=contrast=1.06:saturation=1.0,colorbalance=rs=-.05:bs=.07:rm=-.03:bm=.04',
  };
  const graded = sections.filter(s => s.grade && GRADES[s.grade]);
  if (graded.length) {
    // each graded stretch is a second copy of the picture, shown only in its window
    graded.forEach((s, gi) => {
      g.push(`${vlab}split=2[gk${gi}][gc${gi}]`);
      g.push(`[gc${gi}]${GRADES[s.grade]}[gg${gi}]`);
      g.push(`[gk${gi}][gg${gi}]overlay=0:0:enable='between(t,${s.a.toFixed(3)},${s.b.toFixed(3)})'[gr${gi}]`);
      vlab = `[gr${gi}]`;
    });
  } else if (opts.grade && GRADES[opts.grade]) { g.push(`${vlab}${GRADES[opts.grade]}[gr]`); vlab = '[gr]'; }

  // spotlight: everything outside a rectangle dims, so one thing on screen is the thing
  for (const [si, sp] of (opts.spots || []).entries()) {
    const w = words[sp.word] || words[0];
    const a = remap(Math.max(w.start, rs[0].start), rs);
    const b = a + Math.min(Math.max(0.4, sp.dur || 3), 3.0);
    const x = Math.round(W * (sp.x ?? .1)), y = Math.round(H * (sp.y ?? .3)), rw = Math.round(W * (sp.w ?? .8)), rh = Math.round(H * (sp.h ?? .3));
    g.push(`${vlab}split=3[sp${si}a][sp${si}b][sp${si}c]`);
    g.push(`[sp${si}b]eq=brightness=-0.12:saturation=0.85,boxblur=6:1[sp${si}dim]`);
    g.push(`[sp${si}c]crop=${rw}:${rh}:${x}:${y}[sp${si}win]`);
    g.push(`[sp${si}dim][sp${si}win]overlay=${x}:${y}[sp${si}m]`);
    g.push(`[sp${si}a][sp${si}m]overlay=0:0:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'[sp${si}]`);
    vlab = `[sp${si}]`;
  }

  // captions as PNG overlays, since this ffmpeg has no text filters
  if (opts.captions) {
    const style = opts.capStyle || 'minimal';
    let caps = captionChunks(words, rs, { maxWords: CHUNK[style] || 6,
      maxDur: style === 'single' ? 1.6 : 2.8 });
    // if any section says where captions belong, they only run there
    const capSecs = sections.filter(s => s.captions !== undefined);
    if (capSecs.length) {
      const on = capSecs.filter(s => s.captions);
      caps = caps.filter(c => on.some(s => c.start < s.b && c.end > s.a));
    }
    // a clip insert carries its own text, so the spoken captions sit out its window
    // whatever the scheduler decided is where these actually are
    const quiet = sched.filter(s => s.ov.type === 'broll' || s.ov.type === 'card' || s.ov.type === 'motion' ||
      (s.ov.type === 'pop' && s.ov.kind !== 'comment')).map(s => [s.at, s.at + s.dur]);
    if (quiet.length) caps = caps.filter(c => !quiet.some(([a, b]) => c.start < b && c.end > a));
    const total = rs.reduce((s, r) => s + (r.end - r.start), 0);
    if (onProgress) onProgress(0);
    if (geo.bandH < H) {
      // letterboxed: captions live in the black bar under the picture
      const top = (geo.bandY + geo.bandH + (H - geo.bandY - geo.bandH) * 0.3) / H;
      caps.forEach(c => { c.pos = { cx: .5, top }; });
    } else if (faces.length && style !== 'seam') {
      // One place for the whole video. Captions that move line to line read as a
      // mistake, so the spot is picked once: the lower third, below where the chin
      // usually sits across the clip, and every line keeps its top edge there.
      const bottoms = faces.map(f => f.box[3]).sort((a, b) => a - b);
      const low = bottoms[Math.floor(bottoms.length * 0.85)] || .5;
      const top = Math.min(.80, Math.max(.68, low + .06));
      caps.forEach(c => { c.pos = { cx: .5, top }; });
    } else if (opts.capDynamic && opts.mask && fs.existsSync(opts.mask)) {
      // sample the mask at each caption's middle, in SOURCE time, since the mask is uncut
      const mids = caps.map(c => {
        const w = words.find(x => x.keep && remap(x.start, rs) >= c.start) || words[0];
        return Math.min((opts.info?.duration || w.start + .1) - .05, w.start + .15);
      });
      const boxes = await faceBoxes(opts.mask, mids, W, H).catch(() => []);
      if (boxes.length) placeAround(caps, boxes, style);
    }
    const track = await buildCaptionTrack(caps, W, H, path.join(path.dirname(dst), 'caps'),
      { size: opts.capSize, bottom: opts.capBottom, boxOpacity: opts.capBox,
        style, highlight: opts.capHi, drift: opts.capDrift === true }, total);
    if (track) {
      inputs.push('-i', track);
      g.push(`${vlab}[${inN}:v]overlay=0:0:shortest=0${FLAT()}`);
      inN++;
    } else g.push(`${vlab}null${FLAT()}`);
  } else {
    g.push(`${vlab}null${FLAT()}`);
  }

  // lay the subject back over the top, so anything drawn so far sits behind them
  if (maskIdx >= 0) {
    rs.forEach((seg, i) => g.push(
      `[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS[m${i}]`));
    g.push(`${rs.map((_, i) => `[m${i}]`).join('')}concat=n=${rs.length}:v=1:a=0[mcat]`);
    if (target) {
      const ar2 = (W / H).toFixed(6);
      g.push(`[mcat]crop='min(iw,ih*${ar2})':'min(ih,iw/${ar2})',scale=${W}:${H}:flags=lanczos,setsar=1[mc2]`);
    } else g.push(`[mcat]scale=${W}:${H},setsar=1[mc2]`);
    // the mask video is uncut, so it has to be trimmed the same way
    rs.forEach((seg, i) => g.push(
      `[${maskIdx}:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS[k${i}]`));
    g.push(`${rs.map((_, i) => `[k${i}]`).join('')}concat=n=${rs.length}:v=1:a=0[kcat]`);
    if (target) {
      const ar3 = (W / H).toFixed(6);
      g.push(`[kcat]crop='min(iw,ih*${ar3})':'min(ih,iw/${ar3})',scale=${W}:${H}[kc2]`);
    } else g.push(`[kcat]scale=${W}:${H}[kc2]`);
    g.push(`[kc2]format=gray[mk]`);
    g.push(`[mc2][mk]alphamerge[subj]`);
    g.push(`[flat][subj]overlay=0:0[vo]`);
  }

  // ---- sound: voice, then a bed ducked under it, then hits on the things that land
  const snd = opts.sound || {};
  const total0 = rs.reduce((s, r) => s + (r.end - r.start), 0);
  const audioIn = [];                                   // extra -i entries
  let voice = '[ac]';
  const hits = [];                                       // {file, at, gain}
  const SFX_DIR = path.join(__dirname, '..', 'sound', 'sfx');
  const sfxFile = n => { const f = path.join(SFX_DIR, n + '.wav'); return fs.existsSync(f) ? f : null; };
  const evAt = ov => { const w = words[ov.word] || words[0]; return remap(Math.max(w.start, rs[0].start), rs); };
  if (snd.sfx !== false) {
    // Each role has a sound, a level relative to the voice and a high-pass so it
    // never muddies speech. Every file is measured, so a sound lands with its peak
    // on the frame the thing appears, and louder files don't win just for being loud.
    const ROLES = {
      impact:  { name: 'impact',      rel: -8, hp: 30,  pri: 5 },
      riser:   { name: 'riser_short', rel: -12, hp: 300, pri: 5 },
      card:    { name: 'whoosh_soft', rel: -12, hp: 220, pri: 4 },
      insert:  { name: 'whoosh',      rel: -10, hp: 180, pri: 3 },
      hook:    { name: 'swoosh',      rel: -12, hp: 220, pri: 3 },
      reframe: { name: 'swoosh',      rel: -11, hp: 220, pri: 3 },
      pop:     { name: 'pop',         rel: -15, hp: 350, pri: 2 },
      list:    { name: 'click',       rel: -18, hp: 500, pri: 1 },
      ...(snd.roles || {}),
    };
    const voiceDb = speechLevel(opts.wav, rs);
    const want = [];
    const add = (role, at, group) => {
      const r = ROLES[role]; const f = r && sfxFile(r.name); if (!f) return;
      const info = sfxInfo(f);
      const gainDb = Math.max(-40, Math.min(6, voiceDb + r.rel - info.rms)) + 20 * Math.log10(snd.sfxGain ?? 1);
      want.push({ role, file: f, at: Math.max(0, at - info.peakAt), visual: at, gainDb, hp: r.hp, pri: r.pri, group: group || role + at });
    };
    for (const ov of (opts.overlays || [])) {
      const role = ov.type === 'pop' ? ({ pop: 'pop', comment: 'insert', namecard: 'card' }[ov.kind] || 'hook')
        : ov.type === 'motion' ? ({ stat: 'hook', headline: 'hook' }[ov.kind] || 'insert')
        : ({ broll: 'insert', tweet: 'insert', image: 'insert', card: 'insert', hook: 'hook' }[ov.type] || null);
      if (role) add(role, evAt(ov));
    }
    // a list gets one sound when it starts, not a click on every line
    for (const ls of (opts.lists || [])) { const ln = ls.lines && ls.lines[0]; const w = ln && words[ln.word];
      if (w) add('list', remap(Math.max(w.start, rs[0].start), rs)); }
    // the jolt: a short riser that peaks exactly where the impact hits
    for (const cw of (opts.cows || [])) { const w = words[cw.word]; if (!w) continue;
      const t = remap(Math.max(w.start, rs[0].start), rs);
      add('impact', t, 'cow' + t); add('riser', t, 'cow' + t); }
    for (const rf of (opts.reframes || [])) { const w = words[rf.word]; if (w) add('reframe', remap(Math.max(w.start, rs[0].start), rs)); }

    // Restraint: the most important sounds claim their moment first, nothing lands
    // within 1.8s of another, and small word pops get at most one every 6 seconds.
    const kept = [], keptGroups = new Set();
    want.sort((x, y) => y.pri - x.pri || x.visual - y.visual);
    for (const h of want) {
      if (keptGroups.has(h.group)) { kept.push(h); continue; }
      const clash = kept.some(k => k.group !== h.group && Math.abs(k.visual - h.visual) < 1.8);
      const tooMany = h.role === 'pop' && kept.some(k => k.role === 'pop' && Math.abs(k.visual - h.visual) < 6);
      if (clash || tooMany) continue;
      kept.push(h); keptGroups.add(h.group);
    }
    hits.push(...kept.sort((x, y) => x.at - y.at));
  }
  const mixIns = [];
  const bed = snd.bed && fs.existsSync(snd.bed) ? snd.bed : null;
  let mixCount = 0;
  if (bed) {
    audioIn.push('-stream_loop', '-1', '-i', bed);
    const bi = inN + audioIn.filter(x => x === '-i').length - 1;
    // the bed sits under the voice and drops further whenever the voice speaks
    g.push(`[${bi}:a]atrim=0:${total0.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=1.2,afade=t=out:st=${Math.max(0, total0 - 1.8).toFixed(3)}:d=1.8,` +
      `volume=${(snd.bedGain ?? 0.34).toFixed(3)}[bedraw]`);
    g.push(`${voice}asplit=2[vkey][vmain]`);
    // duck about 7 dB under speech and come back quickly, so the bed is heard in
    // every breath rather than crushed flat for the whole video
    g.push(`[bedraw][vkey]sidechaincompress=threshold=0.06:ratio=4:attack=12:release=180:makeup=2[bed]`);
    voice = '[vmain]';
    mixIns.push('[bed]'); mixCount++;
  }
  hits.forEach((h, i) => {
    audioIn.push('-i', h.file);
    const hi = inN + audioIn.filter(x => x === '-i').length - 1;
    const ms = Math.round(h.at * 1000);
    g.push(`[${hi}:a]aformat=sample_rates=48000:channel_layouts=stereo,highpass=f=${h.hp || 120},volume=${(h.gainDb ?? 0).toFixed(1)}dB,adelay=${ms}|${ms},apad=whole_dur=${total0.toFixed(3)}[hit${i}]`);
    mixIns.push(`[hit${i}]`); mixCount++;
  });
  let alab;
  if (mixCount) {
    g.push(`${voice}${mixIns.join('')}amix=inputs=${mixCount + 1}:duration=first:dropout_transition=0:normalize=0[amixed]`);
    alab = '[amixed]';
  } else alab = voice;
  if (opts.normalize) { g.push(`${alab}loudnorm=I=-14:TP=-1:LRA=9[an]`); alab = '[an]'; }
  inputs.push(...audioIn);

  // Apple Silicon encodes this in a fraction of the time libx264 takes, and the
  // quality difference does not show on a phone screen. Elsewhere, libx264.
  const crf = opts.crf ?? 18;
  const vt = opts.encoder !== 'x264' && process.platform === 'darwin';
  const venc = vt
    ? ['-c:v', 'h264_videotoolbox', '-q:v', String(Math.max(30, Math.min(90, 110 - crf * 3))),
       '-allow_sw', '1']
    : ['-c:v', 'libx264', '-preset', opts.preset || 'veryfast', '-crf', String(crf)];
  const args = ['-y', ...inputs, '-filter_complex', g.join(';'),
    '-map', '[vo]', '-map', alab, ...venc,
    '-r', String(draft ? 24 : Math.round(info.fps || 30)),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', dst];

  const total = rs.reduce((s, r) => s + (r.end - r.start), 0);
  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args);
    if (onProc) onProc(p);
    let err = '';
    p.stdout.on('data', d => {
      const m = String(d).match(/out_time_ms=(\d+)/);
      if (m && onProgress && total) onProgress(Math.min(99, Math.round((Number(m[1]) / 1e6) / total * 100)));
    });
    p.stderr.on('data', d => { err += String(d).slice(-4000); });
    p.on('error', reject);
    p.on('close', c => c === 0 ? resolve() : reject(new Error(err.slice(-1200) || 'export failed')));
  });

  // what actually ended up on screen, for the review to read
  const plan = sched.map(s => ({ at: s.at, dur: s.dur, label: s.ov.label || s.ov.type, type: s.ov.type }));
  for (const ls of (opts.lists || [])) {
    const ts = ls.lines.map(l => remap(Math.max((words[l.word] || words[0]).start, rs[0].start), rs));
    if (ts.length) plan.push({ at: ts[0], dur: Math.min(total, ts[ts.length - 1] + (ls.hold ?? 3.5)) - ts[0], label: 'list', type: 'list' });
  }
  return { cuts: rs.length, duration: total, width: W, height: H, plan };
}

module.exports = { frameFaces, frameGeometry, sfxInfo, speechLevel, WHISPER, MODEL, probe, extractAudio, transcribe, render, ranges, remap, buildMask,
  detectSilence, clampToSilence, findRetakes, buildCaptionTrack,
  captionChunks, srt, ASPECTS, MODEL };
