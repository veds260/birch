'use strict';
// Reads a clip the way an editor would before touching it: who is talking, what
// kind of video it is, and the few moments worth putting on screen. It goes to the
// claude CLI on this machine, so it runs on the user's own Claude plan.
//
// The speaker is named only from evidence in the clip: an introduction, a name
// someone says, text on screen, the file name. Never from what a face looks like.
const { execFile } = require('child_process');
const EP = require('./editprompt');

function screenText(log) {
  const seen = new Map();
  for (const r of log || []) {
    if (!r.text) continue;
    const k = r.text.trim().toLowerCase();
    if (k.length < 3) continue;
    if (!seen.has(k)) seen.set(k, { text: r.text.trim(), t: r.t, n: 0 });
    seen.get(k).n++;
  }
  return [...seen.values()].sort((a, b) => b.n - a.n).slice(0, 15)
    .map(x => `- "${x.text.slice(0, 80)}" (seen ${x.n}s, first at ${Math.floor(x.t / 60)}:${String(Math.floor(x.t % 60)).padStart(2, '0')})`).join('\n') || '- none';
}

function prompt(m, visionLog, formats) {
  const list = formats.map(f => `- ${f.key}: ${f.name}. ${f.what} Best for: ${f.when}`).join('\n');
  return `You are the editor on a short talking video. Read it and plan the edit.

FILE NAME: ${m.name || 'unknown'}
LENGTH: ${Math.round(m.duration || 0)}s
TEXT SEEN ON SCREEN (from OCR, may be noisy):
${screenText(visionLog)}

TRANSCRIPT (time, word index, sentence):
${EP.transcriptWithTimes(m.words || [])}

FORMATS YOU CAN PICK FROM:
${list}

Return ONLY this JSON object, nothing before or after it:
{
  "speaker": { "name": "", "role": "", "sure": false, "how": "" },
  "format": "one key from the list",
  "why": "under 15 words, plain",
  "title": "under 6 words, a claim or a question the video answers, not a quote",
  "moments": [ { "word": 0, "text": "ONE OR TWO WORDS" } ]
}

Rules for speaker: name them only if the clip itself tells you, through a self introduction, someone saying their name, a name or title on screen, the file name, or something they say that only one well known person could say about themselves (their own company, their own book). Never guess from appearance. If it's not in the clip, leave name and role empty and set sure to false. "how" says in a few words where you found it. Role is one short line, like "co-founder, Microsoft" or "host".

Rules for moments: 2 to 5 of them, spread out, none in the first 2 seconds or the last 2 seconds. Each is a word index from the transcript where the speaker stresses something, and text is the one or two words to throw on screen, taken from what they say, in capitals. Skip filler and generic words.`;
}

function direct(m, visionLog, formats) {
  return new Promise((resolve, reject) => {
    execFile('claude', ['-p', '--output-format', 'text', prompt(m, visionLog, formats)],
      { timeout: 240000, maxBuffer: 1 << 20 }, (err, out) => {
        if (err) return reject(new Error(err.code === 'ENOENT' ? 'the claude CLI is not installed' : String(err.message).slice(0, 200)));
        const mm = String(out).match(/\{[\s\S]*\}/);
        if (!mm) return reject(new Error('no plan in the reply'));
        let d;
        try { d = JSON.parse(mm[0]); } catch (e) { return reject(new Error('the plan was not valid JSON')); }
        const n = (m.words || []).length;
        const keys = new Set(formats.map(f => f.key));
        resolve({
          speaker: {
            name: String(d.speaker?.name || '').slice(0, 60), role: String(d.speaker?.role || '').slice(0, 80),
            sure: !!d.speaker?.sure, how: String(d.speaker?.how || '').slice(0, 120),
          },
          format: keys.has(d.format) ? d.format : null,
          why: String(d.why || '').slice(0, 140),
          title: String(d.title || '').slice(0, 60),
          moments: (Array.isArray(d.moments) ? d.moments : [])
            .filter(x => Number.isInteger(x.word) && x.word >= 0 && x.word < n && x.text)
            .slice(0, 5).map(x => ({ word: x.word, text: String(x.text).toUpperCase().slice(0, 24) })),
          at: Date.now(),
        });
      });
  });
}

module.exports = { direct, prompt };
