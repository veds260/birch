'use strict';
// Whisper's word times slip after a pause: the word before the gap gets stretched
// over it and the next word lands a beat late. Cutting on those times removes the
// wrong audio. The pauses themselves are measured from the waveform and are right,
// so the words get re-seated onto the stretches of actual speech between them.

const letters = w => Math.max(1, w.text.replace(/[^a-z0-9]/gi, '').length);
const expect = w => 0.068 * letters(w) + 0.04;

function islands(silences, duration) {
  const out = [];
  let t = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    if (s.start - t > 0.04) out.push({ start: t, end: s.start });
    t = Math.max(t, s.end);
  }
  if (duration - t > 0.04) out.push({ start: t, end: duration });
  return out;
}

function align(words, silences, duration, o = {}) {
  const W = { fit: 1, drift: 1.5, empty: 0.35, emptyPer: 0.6, cal: false, ...o };
  const isl = islands(silences || [], duration || (words.length ? words[words.length - 1].end : 0));
  const n = words.length, k = isl.length;
  if (!n || !k) return { words, orphans: [] };
  // people talk at their own speed, so scale the per-letter guess to this clip
  let rate = 1;
  if (W.cal) {
    const speech = isl.reduce((t, x) => t + x.end - x.start, 0);
    const guess = words.reduce((t, w) => t + expect(w), 0);
    if (speech > 1 && guess > 1) rate = Math.max(0.6, Math.min(1.6, speech / guess));
  }
  const E = [0];
  for (const w of words) E.push(E[E.length - 1] + expect(w) * rate);

  // cost of seating words a..b-1 on island i
  const seat = (a, b, i) => {
    const I = isl[i], D = I.end - I.start, want = E[b] - E[a];
    const fit = (want - D) / Math.max(D, want, 0.35);
    const drift = (Math.abs(words[a].start - I.start) + Math.abs(words[b - 1].end - I.end)) / 2;
    return W.fit * fit * fit + W.drift * Math.min(drift, 3);
  };
  // speech with no words on it: an um whisper dropped, a laugh, a breath
  const empty = i => W.empty + W.emptyPer * (isl[i].end - isl[i].start);

  // cost[i][j] = best cost with the first j words seated on the first i islands
  const INF = 1e9, MAXG = 40;
  const cost = Array.from({ length: k + 1 }, () => new Float64Array(n + 1).fill(INF));
  const back = Array.from({ length: k + 1 }, () => new Int32Array(n + 1).fill(-1));
  cost[0][0] = 0;
  for (let i = 1; i <= k; i++) {
    const I = isl[i - 1];
    for (let j = 0; j <= n; j++) {
      if (cost[i - 1][j] < INF) {
        const c = cost[i - 1][j] + empty(i - 1);
        if (c < cost[i][j]) { cost[i][j] = c; back[i][j] = j; }
      }
      for (let a = Math.max(0, j - MAXG); a < j; a++) {
        if (cost[i - 1][a] >= INF) continue;
        // an island more than 4s from where whisper put the words is never the one
        if (words[a].start > I.end + 4 || words[j - 1].end < I.start - 4) continue;
        const c = cost[i - 1][a] + seat(a, j, i - 1);
        if (c < cost[i][j]) { cost[i][j] = c; back[i][j] = a; }
      }
    }
  }
  if (cost[k][n] >= INF) return { words, orphans: [] };

  const groups = [];
  for (let i = k, j = n; i > 0; i--) { const a = back[i][j]; groups.push({ i: i - 1, a, b: j }); j = a; }
  groups.reverse();
  const orphans = [];
  for (const g of groups) {
    const I = isl[g.i];
    if (g.a === g.b) { orphans.push({ start: I.start, end: I.end }); continue; }
    // inside the island keep whisper's rhythm where it has one, else share by length
    const ws = words[g.a].start, we = words[g.b - 1].end, span = we - ws;
    const D = I.end - I.start;
    let acc = 0;
    for (let x = g.a; x < g.b; x++) {
      const w = words[x];
      let s, e;
      if (span > 0.08 && g.b - g.a > 1) {
        s = I.start + (w.start - ws) / span * D; e = I.start + (w.end - ws) / span * D;
      } else {
        s = I.start + acc / (E[g.b] - E[g.a]) * D; acc += expect(w) * rate; e = I.start + acc / (E[g.b] - E[g.a]) * D;
      }
      w.start = +Math.max(I.start, s).toFixed(3); w.end = +Math.min(I.end, Math.max(e, s + 0.04)).toFixed(3);
    }
  }
  return { words, orphans };
}

// a blip of sound with no words on it, sitting between two pauses, is a click,
// a breath or a cough. Fold it into the pause so the pause gets cut as one.
function foldBlips(silences, orphans, maxLen = 0.3) {
  const sil = [...silences].sort((a, b) => a.start - b.start).map(s => ({ ...s }));
  for (const o of orphans) {
    if (o.end - o.start > maxLen) continue;
    const i = sil.findIndex(s => Math.abs(s.end - o.start) < 0.02);
    const j = sil.findIndex(s => Math.abs(s.start - o.end) < 0.02);
    if (i < 0 || j < 0 || j !== i + 1) continue;
    sil[i].end = sil[j].end; sil.splice(j, 1);
  }
  return sil;
}

// The sure way to know which words sit on which stretch of speech is to ask:
// each stretch is transcribed on its own (one model load for all of them), then
// the full transcript is matched against those pieces word by word.
const fs = require('fs'), path = require('path'), { execFile } = require('child_process');
const norm = t => t.toLowerCase().replace(/[^a-z0-9]/g, '');

function slice(wavBuf, rate, a, b, lead) {
  let off = 12, dataOff = -1, len = 0;
  while (off + 8 <= wavBuf.length) {
    const id = wavBuf.toString('ascii', off, off + 4), l = wavBuf.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; len = l; break; }
    off += 8 + l + (l & 1);
  }
  const s0 = dataOff + 2 * Math.floor(a * rate), s1 = Math.min(dataOff + len, dataOff + 2 * Math.ceil(b * rate));
  const pcm = Buffer.concat([Buffer.alloc(2 * Math.round(lead * rate)), wavBuf.subarray(s0, s1), Buffer.alloc(2 * Math.round(0.5 * rate))]);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function lcsPairs(a, b) {
  const n = a.length, m = b.length, d = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    d[i][j] = a[i] && a[i] === b[j] ? d[i + 1][j + 1] + 1 : Math.max(d[i + 1][j], d[i][j + 1]);
  const pairs = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    // on a repeat ("that that") match the later copy, so the stumble is the leftover
    if (a[i] && a[i] === b[j] && d[i + 1][j] < d[i][j]) { pairs.push([i, j]); i++; j++; }
    else if (d[i + 1][j] >= d[i][j + 1]) i++; else j++;
  }
  return pairs;
}

async function seat(words, silences, duration, wav, o = {}) {
  // o.whisper is {cmd, args}: whisper.cpp where it exists, Birch's python
  // transcriber where it does not. Both take the same flags.
  const whisper = o.whisper, model = o.model;
  const isl = islands(silences || [], duration).filter(x => x.end - x.start >= 0.08);
  if (!words.length || !isl.length || !whisper || !whisper.cmd || !model) return align(words, silences, duration);
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'seat-'));
  try {
    const buf = fs.readFileSync(wav), rate = buf.readUInt32LE(24), LEAD = 0.3;
    const files = isl.map((x, i) => {
      const f = path.join(dir, `i${String(i).padStart(4, '0')}.wav`);
      // a word on its own is too little for whisper in digital silence; a little of
      // the real room either side gets it heard
      const ctx = x.end - x.start < 0.5 ? 0.15 : 0;
      fs.writeFileSync(f, slice(buf, rate, Math.max(0, x.start - ctx), x.end + ctx, LEAD - ctx));
      x.ctx = ctx;
      return f;
    });
    for (let k = 0; k < files.length; k += 150) {
      const args = [...whisper.args, '-m', model, '-oj', '-ojf', '-ml', '1', '-sow', '-wt', '0.01', '-t', String(o.threads || 6)];
      for (const f of files.slice(k, k + 150)) args.push('-f', f);
      await new Promise((res, rej) => execFile(whisper.cmd, args, { maxBuffer: 1 << 26 }, e => e ? rej(e) : res()));
    }
    // every word heard inside a stretch, with times on the clip's clock
    const heard = [];
    isl.forEach((x, i) => {
      let j; try { j = JSON.parse(fs.readFileSync(files[i] + '.json', 'utf8')); } catch { return; }
      for (const seg of j.transcription || []) {
        const t = (seg.text || '').trim();
        if (!t || /^\[.*\]$/.test(t)) continue;
        const s = Math.max(x.start, x.start + seg.offsets.from / 1000 - LEAD);
        const e = Math.min(x.end, Math.max(s + 0.04, x.start + seg.offsets.to / 1000 - LEAD));
        heard.push({ n: norm(t), i, start: s, end: e });
      }
    });
    const heardOn = new Set(heard.map(h => h.i));
    const pairs = lcsPairs(words.map(w => norm(w.text)), heard.map(h => h.n));
    if (pairs.length < words.length * 0.5) return align(words, silences, duration);
    const at = new Array(words.length).fill(null);
    for (const [wi, hi] of pairs) at[wi] = heard[hi];

    // words the pieces missed go next to their matched neighbours, on whichever
    // side of the pause whisper's own time puts them closer to
    let prev = -1;
    for (let wi = 0; wi <= words.length; wi++) {
      if (wi < words.length && !at[wi]) continue;
      const gapA = prev + 1, gapB = wi;
      if (gapB > gapA) {
        const L = prev >= 0 ? at[prev] : null, R = wi < words.length ? at[wi] : null;
        const run = words.slice(gapA, gapB);
        const mid = (run[0].start + run[run.length - 1].end) / 2;
        let lo, hi;
        // a short stretch whisper heard nothing on (too little audio to go on)
        // between the neighbours is where these words went
        const lo_i = L ? L.i + 1 : 0, hi_i = R ? R.i - 1 : isl.length - 1;
        const blank = [];
        for (let i = lo_i; i <= hi_i; i++) if (!heardOn.has(i)) blank.push(i);
        if (L && R && L.i === R.i) { lo = L.end; hi = R.start; }
        else if (blank.length) { lo = isl[blank[0]].start; hi = isl[blank[blank.length - 1]].end; }
        else {
          const li = L ? isl[L.i] : null, ri = R ? isl[R.i] : null;
          const useLeft = li && (!ri || Math.abs(mid - li.end) <= Math.abs(mid - ri.start));
          if (useLeft) { hi = li.end; lo = Math.max(li.start, Math.min(L.end, hi - 0.12 * run.length)); }
          else if (ri) { lo = ri.start; hi = Math.min(ri.end, Math.max(R.start, lo + 0.12 * run.length)); }
          else { lo = run[0].start; hi = run[run.length - 1].end; }
        }
        const step = Math.max(0.02, (hi - lo) / run.length);
        run.forEach((w, k) => { w.start = +(lo + k * step).toFixed(3); w.end = +(lo + (k + 1) * step).toFixed(3); w.seated = false; });
      }
      if (wi < words.length) { words[wi].start = +at[wi].start.toFixed(3); words[wi].end = +at[wi].end.toFixed(3); }
      prev = wi;
    }
    // times only move forward, and a word never spills past the speech it sits on
    for (let k = 1; k < words.length; k++) {
      const p0 = words[k - 1], w = words[k];
      if (w.start < p0.end) {
        if (w.end - 0.03 > p0.end) w.start = p0.end;
        else { const mid = (p0.start + w.end) / 2; p0.end = +Math.max(p0.start + 0.02, mid).toFixed(3); w.start = p0.end; }
      }
      if (w.end < w.start + 0.02) w.end = +(w.start + 0.02).toFixed(3);
    }
    const used = new Set(pairs.map(([, hi]) => heard[hi].i));
    for (const w of words) for (let i = 0; i < isl.length; i++) {
      const c = (w.start + w.end) / 2; if (c >= isl[i].start && c <= isl[i].end) used.add(i);
    }
    const orphans = isl.filter((_, i) => !used.has(i));
    return { words, orphans, matched: pairs.length / words.length };
  } catch (e) {
    return align(words, silences, duration);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { align, seat, islands, foldBlips };
