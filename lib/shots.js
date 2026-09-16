'use strict';
// The on-screen line is writing, not extraction. This asks the local claude CLI
// (his subscription, no API bill) for a reframe per beat and a metaphor object,
// and only falls back to the regex composer if the CLI is missing or slow.
const { execFile } = require('child_process');
const crypto = require('crypto');
const SUG = require('./suggest');

const PALETTES = [
  { bg: 'pure black (#0D0D0D) with subtle film grain', ink: 'white', hot: 'signal red (#E8222A)' },
  { bg: 'cream (#F3EEE4) with a faint grid pattern', ink: 'near-black (#141414)', hot: 'bold red (#D7263D)' },
  { bg: 'acid yellow (#F5E31C), flat', ink: 'black', hot: 'white' },
  { bg: 'deep navy (#0B1530) with a soft vignette', ink: 'white', hot: 'electric blue (#3B82F6)' },
  { bg: 'off-white paper (#F7F5F0) with torn newspaper edges and halftone dots', ink: 'black', hot: 'red marker' },
];
const MOVES = ['snapping in from blur with a hard bounce (ease-out-back, 0.2s settle)',
  'sliding up from the bottom edge and overshooting slightly',
  'scaling from 0 to 100% with a quick pop, then a small shake',
  'stamping in with a flash frame, then holding still'];
const HITS = ['a dramatic bass-thud', 'a sharp camera-shutter click', 'a paper-rip', 'a deep whoosh'];
const OUTS = ['quick zoom-punch into black', 'flash to white then hard cut', 'hard cut, no transition',
  'the object shrinks to a dot and vanishes'];

function prompt(i, line, object) {
  const pal = PALETTES[i % PALETTES.length];
  const words = line.replace(/[.!?]+$/, '').split(' ');
  const cut = Math.ceil(words.length / 2);
  const first = words.slice(0, cut).join(' '), rest = words.slice(cut).join(' ');
  // four seconds is enough for one line; a second line earns a beat more
  const secs = words.length > 4 ? 5 : 4;
  return { secs, text: `Vertical 9:16 portrait video, ${secs} seconds. ${pal.bg} background. ` +
    `${object.charAt(0).toUpperCase() + object.slice(1)}, on the left third of frame, ${MOVES[i % MOVES.length]}, then holds. ` +
    `Simultaneously, bold ${pal.ink} grotesque text stamps in at center right: "${first}" in ${pal.ink}` +
    (rest ? `, then below it "${rest}" in ${pal.hot}, larger, scale-in from 120% to 100% in 0.15s` : '') +
    `. No other text anywhere, no captions, no logos, no watermark. ${HITS[i % HITS.length].charAt(0).toUpperCase() + HITS[i % HITS.length].slice(1)} sound hit on the reveal, then a low instrumental bed at 90 BPM. ` +
    `Camera: completely static. Transition out: ${OUTS[i % OUTS.length]}.` };
}

function askClaude(transcript) {
  const ask = `You write on-screen text for short vertical videos. Below is a transcript of someone talking. Pick the 4 strongest beats, in the order they occur. For each, write ONE on-screen line of at most 6 words that is NOT a quote or paraphrase of the sentence: a punchy reframe, a claim, a number, or a contrast the beat earns. Then name one visual object or gag for a 4-second kinetic-type insert that is a metaphor for the beat, not a literal illustration. Return ONLY a JSON array: [{"beat": "the first 6 words of the sentence, exactly as in the transcript", "line": "...", "object": "..."}]\n\nTRANSCRIPT:\n${transcript}`;
  return new Promise((resolve, reject) => {
    execFile('claude', ['-p', '--output-format', 'text', ask], { timeout: 150000, maxBuffer: 1 << 20 },
      (err, out) => {
        if (err) return reject(err);
        const m = String(out).match(/\[[\s\S]*\]/);
        if (!m) return reject(new Error('no JSON in claude output'));
        try { resolve(JSON.parse(m[0])); } catch (e) { reject(e); }
      });
  });
}

// find the word index where a beat's opening words start
function locate(words, beat) {
  const want = beat.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 4);
  if (!want.length) return 0;
  const norm = words.map(w => w.text.toLowerCase().replace(/[^a-z']/g, ''));
  for (let i = 0; i < norm.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) if (norm[i + k] !== want[k]) { ok = false; break; }
    if (ok) return i;
  }
  // loosen to the first two words
  for (let i = 0; i < norm.length; i++) if (norm[i] === want[0] && norm[i + 1] === want[1]) return i;
  return 0;
}

const key = words => crypto.createHash('md5').update(words.map(w => w.text).join(' ')).digest('hex').slice(0, 12);

async function writeShots(words) {
  const transcript = words.map(w => w.text).join(' ');
  try {
    const beats = await askClaude(transcript);
    const shots = beats.slice(0, 4).map((b, i) => {
      const p = prompt(i, String(b.line || '').trim(), String(b.object || 'a single bold geometric shape').trim());
      return { n: i + 1, word: locate(words, String(b.beat || '')), text: String(b.beat || '').slice(0, 120),
        onScreen: String(b.line || '').trim(), object: String(b.object || '').trim(), secs: p.secs, prompt: p.text, by: 'claude' };
    });
    return { shots, key: key(words), by: 'claude' };
  } catch (e) {
    const fallback = SUG.brollMoments(words).map(s => ({ ...s, secs: 4, by: 'regex' }));
    return { shots: fallback, key: key(words), by: 'regex', error: e.message };
  }
}

/* Ground a shot in something real. A reference image is the difference between a
   generated mood clip and one that looks like the thing being talked about, which is
   how Arcads and Creatify work: they never hand the model a blank frame. */
function refsFor(shot, opts = {}) {
  const out = [];
  if (opts.assetFor) { const a = opts.assetFor(shot); if (a) out.push(a); }
  if (opts.speakerFrame && out.length < 2) out.push(opts.speakerFrame);
  return out;
}

module.exports = { writeShots, key, refsFor };
