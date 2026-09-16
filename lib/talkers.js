'use strict';
// Finds the speaker's face. Every face gets strung into a track at five frames a
// second, and the track whose mouth moves while there is speech on the audio is the
// one talking. In an interview that changes back and forth, so it is decided over
// short windows, with a little stickiness so the frame does not flick between people.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const TOOL = path.join(__dirname, '..', 'tools', 'talkers');

function scan(src, out, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(TOOL, [src, out, '5']);
    let err = '';
    p.stderr.on('data', d => { err += String(d).slice(-300); const m = String(d).match(/talkers (\d+)/); if (m && onProgress) onProgress(+m[1]); });
    p.on('error', reject);
    p.on('close', c => c === 0 ? resolve(load(out)) : reject(new Error('face scan failed: ' + err.slice(-160))));
  });
}
function load(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
}

function tracks(frames, cuts = []) {
  const all = [];
  let live = [];
  let cutIdx = 0;
  const sortedCuts = [...cuts].sort((a, b) => a - b);
  for (const fr of frames) {
    while (cutIdx < sortedCuts.length && sortedCuts[cutIdx] <= fr.t) { live = []; cutIdx++; }
    const taken = new Set();
    for (const f of fr.f) {
      const cx = (f[0] + f[2]) / 2, cy = (f[1] + f[3]) / 2, h = f[3] - f[1];
      let best = null, bd = 1e9;
      for (const tr of live) {
        if (taken.has(tr)) continue;
        const l = tr.pts[tr.pts.length - 1];
        if (fr.t - l.t > 1.2) continue;
        const d = Math.hypot(cx - l.cx, cy - l.cy);
        if (d < Math.max(0.05, l.h * 0.8) && h / l.h > 0.7 && h / l.h < 1.4 && d < bd) { bd = d; best = tr; }
      }
      const pt = { t: fr.t, cx, cy, h, box: f.slice(0, 4), open: f[4] };
      if (best) { best.pts.push(pt); taken.add(best); }
      else { const tr = { id: all.length, pts: [pt] }; all.push(tr); live.push(tr); taken.add(tr); }
    }
  }
  return all.filter(tr => tr.pts.length >= 3);
}

// speech: [{start,end}] stretches with sound on them
function speakerPath(frames, speech, cuts = [], step = 0.5) {
  const trs = tracks(frames, cuts);
  if (!trs.length) return [];
  const talking = t => speech.some(s => t >= s.start && t <= s.end);
  const end = frames[frames.length - 1].t;
  const out = [];
  let cur = null;
  for (let t = 0; t <= end; t += step) {
    const lo = t - 1.5, hi = t + 1.5;
    let best = null, bestA = -1;
    const here = [];
    for (const tr of trs) {
      if (tr.pts[0].t > t + 0.6 || tr.pts[tr.pts.length - 1].t < t - 0.6) continue;
      const w = tr.pts.filter(p => p.t >= lo && p.t <= hi);
      if (w.length < 2) continue;
      let mv = 0, n = 0;
      for (let k = 1; k < w.length; k++) {
        if (w[k].open < 0 || w[k - 1].open < 0 || !talking(w[k].t)) continue;
        mv += Math.abs(w[k].open - w[k - 1].open); n++;
      }
      const size = w.reduce((a, p) => a + p.h, 0) / w.length;
      const cx = w.reduce((a, p) => a + p.cx, 0) / w.length;
      // mouths move most, but a big centred face breaks ties when nobody's lips read
      const act = (n ? mv / n : 0) + 0.02 * Math.sqrt(size) * (1 - 0.5 * Math.abs(cx - 0.5));
      here.push({ tr, act });
      if (act > bestA) { bestA = act; best = tr; }
    }
    if (!best) continue;
    const still = cur && here.find(x => x.tr === cur);
    if (still && best !== cur && bestA < still.act * 1.35) best = cur;
    cur = best;
    const p = best.pts.reduce((a, b) => Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a);
    out.push({ t: +t.toFixed(2), box: p.box, who: best.id });
  }
  return out;
}

module.exports = { scan, load, tracks, speakerPath };
