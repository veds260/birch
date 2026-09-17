'use strict';
// Watch the export before the person does. Everything that went wrong tonight was
// detectable: blank frames, a panel left empty, something on screen the whole video,
// long stretches with nothing happening, a bed nobody can hear, text on the face.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const BIN = require('./bin');

const run = (bin, args) => new Promise((res, rej) =>
  execFile(bin, args, { maxBuffer: 1 << 28 }, (e, so, se) => e ? rej(new Error((se || e.message).slice(-300))) : res({ so, se })));

async function frameStats(file, times, dir) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  for (const [i, t] of times.entries())
    await run(BIN.FFMPEG, ['-y', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
      '-vf', 'scale=160:-1', path.join(dir, `f${String(i).padStart(3, '0')}.png`)]).catch(() => {});
  const py = `
import os,sys,json
from PIL import Image, ImageStat
d=sys.argv[1]; out=[]
for f in sorted(os.listdir(d)):
    im=Image.open(os.path.join(d,f)).convert('L')
    s=ImageStat.Stat(im)
    out.append({"mean":round(s.mean[0],1),"sd":round(s.stddev[0],1)})
print(json.dumps(out))`;
  const { so } = await run(require('./bin').python(), ['-c', py, dir]).catch(() => ({ so: '[]' }));
  return JSON.parse(so || '[]');
}

async function audio(file) {
  const { se } = await run(BIN.FFMPEG, ['-hide_banner', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']).catch(e => ({ se: String(e.message) }));
  const grab = re => { const m = String(se).match(re); return m ? Number(m[1]) : null; };
  // the last reported values are the integrated ones
  const all = [...String(se).matchAll(/I:\s+(-?[\d.]+) LUFS/g)].map(m => Number(m[1]));
  const lra = [...String(se).matchAll(/LRA:\s+(-?[\d.]+) LU/g)].map(m => Number(m[1]));
  const pk = [...String(se).matchAll(/Peak:\s+(-?[\d.]+) dBFS/g)].map(m => Number(m[1]));
  return { lufs: all.length ? all[all.length - 1] : null, lra: lra.length ? lra[lra.length - 1] : null,
    peak: pk.length ? pk[pk.length - 1] : null };
}

/* structural review: does the plan itself read like an edit, or like a slideshow? */
function structure(plan, total) {
  const notes = [];
  const evs = plan.events.slice().sort((a, b) => a.at - b.at);
  // anything living on screen for most of the video is wallpaper, not an edit
  for (const e of evs) if (e.dur / total > 0.5)
    notes.push({ level: 'bad', what: `${e.label} is on screen for ${Math.round(e.dur / total * 100)}% of the video` });
  // two things at once
  for (let i = 1; i < evs.length; i++)
    if (evs[i].at < evs[i - 1].at + evs[i - 1].dur - 0.05)
      notes.push({ level: 'bad', what: `${evs[i].label} lands while ${evs[i - 1].label} is still up` });
  // dead air
  let prev = 0, worst = 0, worstAt = 0;
  for (const e of evs) { const gap = e.at - prev; if (gap > worst) { worst = gap; worstAt = prev; } prev = Math.max(prev, e.at + e.dur); }
  if (total - prev > worst) { worst = total - prev; worstAt = prev; }
  if (worst > 12) notes.push({ level: 'warn', what: `${Math.round(worst)}s with nothing on screen, from ${Math.round(worstAt)}s` });
  // density
  const per = evs.length / (total / 60);
  if (per < 4) notes.push({ level: 'warn', what: `only ${evs.length} things happen in ${Math.round(total)}s` });
  if (per > 24) notes.push({ level: 'warn', what: `${evs.length} things in ${Math.round(total)}s, it may feel busy` });
  return notes;
}

async function review(file, plan) {
  const notes = [];
  if (!fs.existsSync(file)) return [{ level: 'bad', what: 'no file was written' }];
  const { so } = await run(BIN.FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(so);
  const v = info.streams.find(s => s.codec_type === 'video') || {};
  const total = Number(info.format.duration) || 0;
  if (!info.streams.some(s => s.codec_type === 'audio')) notes.push({ level: 'bad', what: 'the export has no audio' });

  // 24 frames across the whole thing, the way a person would scrub it
  const times = Array.from({ length: 24 }, (_, i) => total * (i + 0.5) / 24);
  const stats = await frameStats(file, times, path.join(path.dirname(file), 'reviewframes'));
  stats.forEach((s, i) => {
    // a dark frame with type on it is a deliberate insert, not a fault; only flag
    // the ones that are dark AND empty
    if (s.sd < 6) notes.push({ level: 'bad', what: `frame at ${Math.round(times[i])}s is nearly blank` });
    else if (s.mean < 12 && s.sd < 26) notes.push({ level: 'warn', what: `frame at ${Math.round(times[i])}s is dark with nothing in it` });
    else if (s.mean > 238) notes.push({ level: 'warn', what: `frame at ${Math.round(times[i])}s is blown out` });
  });

  const a = await audio(file);
  if (a.lufs !== null) {
    if (a.lufs < -18) notes.push({ level: 'warn', what: `quiet for a phone at ${a.lufs} LUFS, aim for -14` });
    if (a.lufs > -10) notes.push({ level: 'warn', what: `loud at ${a.lufs} LUFS, it will be turned down on upload` });
  }
  if (a.peak !== null && a.peak > -0.5) notes.push({ level: 'warn', what: `peaks at ${a.peak} dBFS, close to clipping` });

  // Meta reckons 47% of a video's value is delivered in the first three seconds, and
  // 71% of TikTok viewers decide inside them. So the opening gets judged on its own.
  const opening = plan.events.filter(e => e.at < 3);
  if (!opening.length) notes.push({ level: 'bad', what: 'nothing happens in the first 3 seconds, which is where most of the value is' });
  const first = stats.slice(0, Math.max(1, Math.round(3 / (total / stats.length))));
  if (first.length > 1) {
    const spread = Math.max(...first.map(s => s.mean)) - Math.min(...first.map(s => s.mean));
    if (spread < 4) notes.push({ level: 'warn', what: 'the first 3 seconds barely change, so there is nothing to stop a scroll' });
  }

  notes.push(...structure(plan, total));
  const order = { bad: 0, warn: 1 };
  return notes.sort((x, y) => order[x.level] - order[y.level]);
}

module.exports = { review };
