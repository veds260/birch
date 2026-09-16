'use strict';
// Reads the per-second vision log and turns it into things the editor can use:
// where the face is at any time, when the shot changes, whether a stretch is a
// screen recording, and a short description of what the footage shows.
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const path = require('path');
const TOOL = path.join(__dirname, '..', 'tools', 'scenevision');
const { FFMPEG } = require('./bin');

function analyse(src, out, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(TOOL, [src, out, '1']);
    let err = '';
    p.stderr.on('data', d => { err += String(d).slice(-500); const m = String(d).match(/vision (\d+)/); if (m && onProgress) onProgress(Number(m[1])); });
    p.on('error', reject);
    p.on('close', c => c === 0 ? resolve(load(out)) : reject(new Error('vision failed: ' + err.slice(-200))));
  });
}
function load(out) {
  try { return fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
}
// shot changes from ffmpeg's scene detector
function cuts(src) {
  return new Promise(resolve => {
    execFile(FFMPEG, ['-hide_banner', '-i', src, '-vf', "select='gt(scene,0.35)',showinfo", '-f', 'null', '-'], { maxBuffer: 1 << 26 },
      (e, so, se) => { const ts = []; for (const m of String(se).matchAll(/pts_time:([\d.]+)/g)) ts.push(+(+m[1]).toFixed(2)); resolve(ts); });
  });
}
const at = (log, t) => { let best = log[0]; for (const r of log) { if (r.t <= t) best = r; else break; } return best; };
function faceAt(log, t) { const r = at(log, t); return r && r.faces && r.faces.length ? r.faces.sort((a, b) => (b[2]-b[0])*(b[3]-b[1]) - (a[2]-a[0])*(a[3]-a[1]))[0] : null; }
// a screen-recording stretch: on-screen text, no face
function screenSpans(log) {
  const spans = []; let cur = null;
  for (const r of log) {
    const isScreen = (r.text && r.text.length > 8) && !(r.faces && r.faces.length);
    if (isScreen && !cur) cur = { start: r.t, end: r.t + 1 };
    else if (isScreen && cur) cur.end = r.t + 1;
    else if (!isScreen && cur) { if (cur.end - cur.start >= 2) spans.push(cur); cur = null; }
  }
  if (cur && cur.end - cur.start >= 2) spans.push(cur);
  return spans;
}
// framing of the speaker over time: close, medium, wide
function framing(log) {
  return log.map(r => { const f = r.faces && r.faces[0]; if (!f) return { t: r.t, shot: 'none' };
    const h = f[3] - f[1]; return { t: r.t, shot: h > .32 ? 'close' : h > .16 ? 'medium' : 'wide', face: f }; });
}
function summary(log, cutTimes) {
  const tags = {}; for (const r of log) for (const [k, c] of (r.tags || [])) tags[k] = (tags[k] || 0) + c;
  const top = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
  const faces = log.filter(r => r.faces && r.faces.length).length;
  const text = log.filter(r => r.text).length;
  const fr = framing(log); const close = fr.filter(x => x.shot === 'close').length, wide = fr.filter(x => x.shot === 'wide').length;
  return { seconds: log.length, withFace: faces, withText: text, cuts: cutTimes.length, tags: top,
    shots: { close, medium: fr.filter(x => x.shot === 'medium').length, wide }, screen: screenSpans(log) };
}
// Who is talking. The biggest face in a frame is often someone in the crowd, so
// every second picks one face, favouring big and central ones, and a path through
// the seconds is chosen that does not jump between people without a reason.
// A shot change is a reason, so jumps there are free.
function speakerTrack(log, cutTimes = []) {
  const rows = log.filter(r => r.faces && r.faces.length);
  if (!rows.length) return [];
  const cutBetween = (t0, t1) => cutTimes.some(c => c > t0 && c <= t1 + 0.01);
  const emit = r => {
    const big = Math.max(...r.faces.map(f => Math.sqrt(f[3] - f[1])));
    return r.faces.map(f => (Math.sqrt(f[3] - f[1]) / big) * (1 - 0.7 * Math.abs((f[0] + f[2]) / 2 - 0.5)));
  };
  const centre = f => [(f[0] + f[2]) / 2, (f[1] + f[3]) / 2];
  let score = emit(rows[0]), back = [];
  for (let k = 1; k < rows.length; k++) {
    const e = emit(rows[k]), prev = rows[k - 1], cur = rows[k];
    const free = cutBetween(prev.t, cur.t) || cur.t - prev.t > 4;
    const ns = [], bk = [];
    cur.faces.forEach((f, j) => {
      const [x, y] = centre(f);
      let best = -1e9, bi = 0;
      prev.faces.forEach((g, i) => {
        const [px, py] = centre(g);
        const v = score[i] - (free ? 0 : 3 * Math.hypot(x - px, y - py));
        if (v > best) { best = v; bi = i; }
      });
      ns.push(best + e[j]); bk.push(bi);
    });
    score = ns; back.push(bk);
  }
  let j = score.indexOf(Math.max(...score));
  const out = [];
  for (let k = rows.length - 1; k >= 0; k--) {
    out.push({ t: rows[k].t, box: rows[k].faces[j] });
    if (k > 0) j = back[k - 1][j];
  }
  return out.reverse();
}

module.exports = { analyse, load, cuts, at, faceAt, screenSpans, framing, summary, speakerTrack };
