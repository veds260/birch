#!/usr/bin/env node
'use strict';
/* vd: the part HyperFrames does not do.
 *
 * HyperFrames packages footage with designed overlays but leaves the clip
 * unchanged. This tightens the clip first, then hands over a folder it can
 * read: the cut footage, a transcript in cut time, the safe zones where the
 * speaker's face is, and a motion board to correct before anything renders.
 *
 *   node vd.js cut <video> [-o outdir]
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const M = require('./lib/media.js');
const VIS = require('./lib/vision.js');

const sh = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { maxBuffer: 1 << 28 }, (e, so, se) => e ? rej(new Error(se || e.message)) : res(so)));
const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;

async function cut(src, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const info = await M.probe(src);

  console.log('  transcribing (local whisper, no API)');
  const wav = path.join(outDir, 'audio.wav');
  await M.extractAudio(src, wav);
  let words = await M.transcribe(wav, path.join(outDir, 'transcript'), () => {}, () => {});

  console.log('  finding pauses (adaptive, measures this recording\'s own floor)');
  const silences = await M.detectSilence(wav);
  words = M.clampToSilence(words, silences);

  const retakes = M.findRetakes(words);
  let dropped = 0;
  for (const r of retakes) for (let i = r.a; i < r.b; i++) { words[i].keep = false; words[i].retake = true; dropped++; }
  for (const w of words) if (w.filler) { w.keep = false; dropped++; }

  const rs = M.ranges(words, { gapMax: 0.5, silences });
  const kept = rs.reduce((s, r) => s + (r.end - r.start), 0);

  console.log(`  ${words.length} words, ${dropped} dropped, ${retakes.length} retakes, ` +
    `${silences.length} pauses; ${info.duration.toFixed(1)}s -> ${kept.toFixed(1)}s`);

  // cut the footage down to the kept ranges
  const outFile = path.join(outDir, 'cut.mp4');
  const fc = rs.map((r, i) =>
    `[0:v]trim=${r.start}:${r.end},setpts=PTS-STARTPTS[v${i}];` +
    `[0:a]atrim=${r.start}:${r.end},asetpts=PTS-STARTPTS[a${i}]`).join(';');
  const cc = rs.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${rs.length}:v=1:a=1[v][a]`;
  await sh('ffmpeg', ['-v', 'error', '-y', '-i', src, '-filter_complex', `${fc};${cc}`,
    '-map', '[v]', '-map', '[a]', '-c:v', 'h264_videotoolbox', '-b:v', '12M',
    '-c:a', 'aac', '-movflags', '+faststart', outFile]);

  // transcript in cut time, which is the only time HyperFrames will see
  const out = [];
  for (const w of words) {
    if (w.keep === false) continue;
    const t = M.remap(Math.max(w.start, rs[0].start), rs);
    out.push({ t: +t.toFixed(3), text: w.text });
  }
  fs.writeFileSync(path.join(outDir, 'transcript.json'), JSON.stringify(out, null, 2));

  // Where the faces are, so overlays have somewhere legal to sit. Run the vision
  // pass on the CUT footage, because cut time is the only time that exists now.
  let safe = null;
  try {
    console.log('  tracking faces');
    await VIS.analyse(outFile, path.join(outDir, 'vision.json'), () => {});
    const log = VIS.load(path.join(outDir, 'vision.json'));
    let top = 1, bot = 0, seen = 0, most = 0;
    for (const f of (log || [])) {
      const fs = f.faces || [];
      if (!fs.length) continue;
      seen++; most = Math.max(most, fs.length);
      for (const q of fs) { top = Math.min(top, q[1]); bot = Math.max(bot, q[3]); }
    }
    if (seen) safe = {
      faceBand: [+top.toFixed(3), +bot.toFixed(3)],
      above: +(top - 0.03).toFixed(2),
      below: +(bot + 0.03).toFixed(2),
      seconds: seen, mostFaces: most
    };
  } catch (e) { console.log('  no face track (' + e.message.slice(0, 50) + ')'); }

  return { info, words, rs, kept, retakes, silences, outFile, transcript: out, safe };
}

function board(r, name) {
  const dur = r.kept;
  const lines = [];
  lines.push(`# Motion board: ${name}`, '');
  lines.push(`Cut footage \`cut.mp4\`, ${dur.toFixed(1)}s, ${r.info.width}x${r.info.height}.`);
  lines.push(`Source was ${r.info.duration.toFixed(1)}s, so ${(r.info.duration - dur).toFixed(1)}s came out.`);
  lines.push('');
  lines.push('Correct this before anything renders. Every row is a thing that happens on screen.');
  lines.push('');
  lines.push('| # | at | hold | what happens | why here |');
  lines.push('|---|----|------|--------------|----------|');

  // beats worth marking: the opening, and each point the speaker resumes after a real pause
  const t = r.transcript;
  const beats = [];
  if (t.length) beats.push({ at: 0, why: 'opening, the scroll decision' });
  for (let i = 1; i < t.length; i++) {
    const gap = t[i].t - t[i - 1].t;
    if (gap > 0.55 && beats.every(b => Math.abs(b.at - t[i].t) > 3.5)) {
      beats.push({ at: t[i].t, why: 'new thought after a pause' });
    }
  }
  const phrase = at => t.filter(w => w.t >= at && w.t < at + 2.6).map(w => w.text).join(' ').slice(0, 52);
  beats.slice(0, 10).forEach((b, i) => {
    lines.push(`| ${i + 1} | ${fmt(b.at)} | | [decide] | ${b.why}: "${phrase(b.at)}" |`);
  });
  lines.push('');
  lines.push('## Instagram Reels safe zone');
  lines.push('');
  lines.push('The app draws its own UI over the video. Anything outside this box is');
  lines.push('partly or wholly hidden in the feed, so nothing that has to be read goes there.');
  lines.push('');
  lines.push('| edge | keep clear | what covers it |');
  lines.push('|------|-----------|----------------|');
  lines.push('| top | 220px | status bar, account handle |');
  lines.push('| bottom | 400px | caption, handle, audio ticker |');
  lines.push('| right | 120px | like / comment / share / save, from about a third down |');
  lines.push('| left | 60px | edge crop |');
  lines.push('');
  const sw = r.info.width || 1080, shh = r.info.height || 1920;
  lines.push(`**On this clip (${sw}x${shh}): everything readable lives inside x 60 to ${sw - 120}, y 220 to ${shh - 400}.**`);
  lines.push('');
  lines.push('## Face safe zones');
  if (r.safe) {
    const s = r.safe;
    lines.push(`Faces tracked in ${s.seconds}s of the clip, up to ${s.mostFaces} at once.`);
    lines.push('');
    lines.push(`- Faces occupy **y ${s.faceBand[0]} to ${s.faceBand[1]}** (0 is the top of frame).`);
    lines.push(`- **Legal above:** y < ${s.above}`);
    lines.push(`- **Legal below:** y > ${s.below}  ← put captions here`);
    lines.push('- Anything between those two lands on a face. Do not put it there.');
  } else {
    lines.push('No face track yet. Run the vision pass, or say "keep overlays clear of the speaker\'s face"');
    lines.push('in the prompt and check the preview.');
  }
  lines.push('');
  lines.push('## Retakes removed');
  lines.push(r.retakes.length
    ? r.retakes.map(x => `- "${x.phrase}" said ${x.reps} times, kept the last`).join('\n')
    : '- none found');
  return lines.join('\n');
}

function brief(r, name) {
  return `# BRIEF.md

## The clip
\`cut.mp4\`, ${r.kept.toFixed(1)}s, ${r.info.width}x${r.info.height}.
Already tightened: ${r.silences.length} pauses and ${r.retakes.length} retakes removed.
Do not re-cut it. The story is fixed.

## Route
Designed overlays on footage that plays unchanged.

## Non-negotiables
- Captions in short phrases, no punctuation.
- Never cover the speaker's face. See the safe zones in motion-board.md.
- Nothing holds longer than it earns. Pops under 1.5s, cards under 3s.
- Not every second needs something on it. Silence on screen is allowed.

## Before rendering
1. Write the motion board into \`motion-board.md\`, timestamp by timestamp.
2. Wait for it to be corrected.
3. \`npx hyperframes preview\` stays open the whole time.
4. \`lint\` and \`check\` both pass before \`render\`.

## Transcript
\`transcript.json\`, word level, in cut time.
`;
}

function listStyles() {
  const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'refs', 'styles.json'), 'utf8'));
  console.log('\nEdit styles\n');
  for (const [k, v] of Object.entries(s.styles)) {
    console.log(`  ${k.padEnd(16)} ${v.label}`);
    console.log(`  ${''.padEnd(16)} ${v.bestFor}`);
    if (v.source) console.log(`  ${''.padEnd(16)} measured from ${v.source}`);
    console.log('');
  }
  console.log('Music beds, three so a profile starts to sound like itself\n');
  for (const [k, v] of Object.entries(s.beds)) {
    if (k.startsWith('_')) continue;
    console.log(`  ${k.padEnd(16)} ${v.use}`);
  }
  const have = fs.existsSync(path.join(__dirname, 'beds'))
    ? fs.readdirSync(path.join(__dirname, 'beds')).filter(f => f.endsWith('.wav')) : [];
  console.log(`\n  generated: ${have.length ? have.join(', ') : 'none yet, run tools/genbeds.py'}`);
  const sfx = fs.existsSync(path.join(__dirname, 'sound', 'sfx'))
    ? fs.readdirSync(path.join(__dirname, 'sound', 'sfx')).filter(f => f.endsWith('.wav')) : [];
  console.log(`\nSFX (${sfx.length}), all synthesised, nothing sampled\n`);
  for (const [g, names] of Object.entries(s.sfx)) {
    if (g.startsWith('_') || !Array.isArray(names)) continue;
    console.log(`  ${g.padEnd(12)} ${names.join(', ')}`);
  }
  console.log('\nMix:  python3 tools/mix.py <video> <out> --bed speech --sfx 4.3:riser_short\n');
}

(async () => {
  const [cmd, src, ...rest] = process.argv.slice(2);
  if (cmd === 'styles') { listStyles(); return; }
  if (cmd !== 'cut' || !src) {
    console.log('usage: node vd.js cut <video> [-o outdir]');
    console.log('       node vd.js styles');
    process.exit(1);
  }
  const oi = rest.indexOf('-o');
  const name = path.basename(src).replace(/\.[^.]+$/, '');
  const outDir = oi >= 0 ? rest[oi + 1] : path.join(process.cwd(), 'hf-' + name);
  console.log(`cutting ${path.basename(src)}`);
  const r = await cut(path.resolve(src), outDir);
  fs.writeFileSync(path.join(outDir, 'motion-board.md'), board(r, name));
  fs.writeFileSync(path.join(outDir, 'BRIEF.md'), brief(r, name));
  console.log(`\nready: ${outDir}`);
  console.log('  cut.mp4, transcript.json, motion-board.md, BRIEF.md');
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
