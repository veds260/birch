'use strict';
// The opening is the product. Meta puts 47% of a video's value in the first three
// seconds and TikTok says 71% of viewers decide inside them, so the one thing worth
// making several of is the hook. Write a few, render each as a short clip, pick one.
const { execFile } = require('child_process');

const SHAPES = [
  ['bold claim', 'a flat statement that sounds wrong until you hear the rest'],
  ['question', 'a question the viewer cannot answer and wants to'],
  ['number', 'a specific figure, said plainly'],
  ['pattern interrupt', 'a line that contradicts what everyone assumes'],
  ['problem named', 'the thing the viewer is quietly annoyed by, said out loud'],
];

function ask(transcript, n = 4) {
  const shapes = SHAPES.slice(0, n).map(([k, d], i) => `${i + 1}. ${k}: ${d}`).join('\n');
  const prompt = `Below is a transcript of a short video. Write ${n} different opening hooks for it, one of each shape:

${shapes}

Each hook is ONE line of at most 5 words, because it has to be read in under three seconds that goes on screen over the first seconds. It must be true to the transcript, never a quote from it, and never a paraphrase of the first sentence. Also give a short second line of at most 7 words.

Return ONLY JSON: [{"shape":"bold claim","headline":"...","subline":"..."}]

TRANSCRIPT:
${transcript}`;
  return new Promise((resolve, reject) => {
    execFile('claude', ['-p', '--output-format', 'text', prompt], { timeout: 150000, maxBuffer: 1 << 20 },
      (err, out) => {
        if (err) return reject(err);
        const m = String(out).match(/\[[\s\S]*\]/);
        if (!m) return reject(new Error('no JSON in the reply'));
        try { resolve(JSON.parse(m[0])); } catch (e) { reject(e); }
      });
  });
}
module.exports = { ask, SHAPES };
