'use strict';
// Reads a clip the way an editor would before touching it: who is talking, what
// kind of video it is, and the few moments worth putting on screen. It goes to the
// Claude or Codex CLI on this machine, so it runs on the user's own Claude or ChatGPT plan.
//
// The speaker is named only from evidence in the clip: an introduction, a name
// someone says, text on screen, the file name. Never from what a face looks like.
const { execFile } = require('child_process');
const LLM = require('./llm');
const EP = require('./editprompt');
const fs = require('fs');
const path = require('path');
const BIN = require('./bin');

// three looks at the footage, with the face Birch is tracking boxed, so the plan is
// made by someone who has seen the speaker and not just read them
async function stills(m, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const dur = m.duration || 30, out = [];
  for (const [i, frac] of [0.2, 0.5, 0.8].entries()) {
    const t = +(dur * frac).toFixed(2);
    const sp = (m.speaker || []).reduce((best, x) => !best || Math.abs(x.t - t) < Math.abs(best.t - t) ? x : best, null);
    const box = sp && Math.abs(sp.t - t) < 3 ? sp.box : null;
    const draw = box ? `,drawbox=x=iw*${box[0]}:y=ih*${box[1]}:w=iw*${(box[2] - box[0]).toFixed(4)}:h=ih*${(box[3] - box[1]).toFixed(4)}:color=orange@0.95:t=4` : '';
    const file = path.join(dir, `look${i}.jpg`);
    await new Promise(r => execFile(BIN.FFMPEG, ['-y', '-loglevel', 'error', '-ss', String(t), '-i', m.src, '-frames:v', '1',
      '-vf', `scale=640:-2${draw}`, file], () => r()));
    if (fs.existsSync(file)) out.push({ file, t, boxed: !!box });
  }
  return out;
}

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

function prompt(m, visionLog, formats, looks = []) {
  const list = formats.map(f => `- ${f.key}: ${f.name}. ${f.what} Best for: ${f.when}`).join('\n');
  const shape = (m.width || 0) >= (m.height || 0) ? 'horizontal' : 'vertical';
  const seen = looks.length
    ? `FRAMES: read these images before planning. An orange box marks the face Birch is tracking as the speaker.\n${looks.map(l => `- ${l.file} (at ${l.t}s${l.boxed ? '' : ', no face tracked'})`).join('\n')}`
    : 'FRAMES: none available.';
  return `You are the editor on a short talking video. Look at it, read it, and plan the edit.

FILE NAME: ${m.name || 'unknown'}
LENGTH: ${Math.round(m.duration || 0)}s
SOURCE: ${m.width}x${m.height}, ${shape}. It will be delivered as a 9:16 vertical reel, cropped to follow the speaker.
${seen}
TEXT SEEN ON SCREEN (from OCR, may be noisy):
${screenText(visionLog)}

TRANSCRIPT (time, word index, sentence):
${EP.transcriptWithTimes(m.words || [])}

FORMATS YOU CAN PICK FROM:
${list}

Return ONLY this JSON object, nothing before or after it:
{
  "speaker": { "name": "", "role": "", "sure": false, "how": "" },
  "scene": "under 12 words: where they are and how they're framed",
  "nameCard": false,
  "tracked": "yes if the orange box is on the person doing the talking, no if it's on someone else, unsure",
  "tone": "formal, casual or hype",
  "wordLook": "clean or block",
  "format": "one key from the list",
  "why": "under 15 words, plain",
  "title": "under 6 words, a claim or a question the video answers, not a quote",
  "moments": [ { "word": 0, "text": "ONE OR TWO WORDS" } ],
  "inserts": [
    { "type": "photo", "word": 0, "term": "exact Wikipedia article title", "caption": "2 to 4 words" },
    { "type": "stat", "word": 0, "value": "$10,000", "label": "under 6 words" },
    { "type": "headline", "word": 0, "text": "under 6 words" },
    { "type": "site", "word": 0, "url": "domain.com" }
  ]
}

Rules for speaker: name them only if the clip itself tells you, through a self introduction, someone saying their name, a name or title on screen, the file name, or something they say that only one well known person could say about themselves (their own company, their own book). Never guess from appearance. If it's not in the clip, leave name and role empty and set sure to false. "how" says in a few words where you found it. Role is one short line, like "co-founder, Microsoft" or "host".

Rules for the look: pick a format the footage can actually carry. Story needs footage shot vertically or a wide cinematic shot with room around the speaker. Split screen needs something being shown or described on a screen. Picture in picture needs named things you could show a photo of. A formal speech or interview wants clean big words and restraint; loud, fast, casual talk can take block words. wordLook clean is white heavy type, block is ink on a yellow slab.

Rules for nameCard: reels don't label people, so this is false almost always. Set it true only when the clip is an interview or podcast where a guest is being introduced to the audience and their name matters to the story. A creator talking to camera, a speech, a vlog or a street clip never gets one.

Rules for inserts: these are animated pieces laid over the video, 2 to 4 per minute of clip at most, and zero is fine for a clip that doesn't earn any. Use only what the words give you:
- photo: when the speaker names a real, well known company, person, place, product or event that has a Wikipedia article. term is that article's exact title. Never the speaker themself, the viewer already sees them.
- stat: only for a number the speaker actually says, written the way they said it.
- headline: at most one, for the single idea the whole clip is about, at the moment it's first stated.
- site: only when a website or app is named by its domain.
Place each insert on the word where the thing is first said. Keep inserts at least 6 seconds apart, at least 3 seconds from any moment, and out of the first 2 seconds.

Rules for moments: 2 to 5 of them, spread out, none in the first 2 seconds or the last 2 seconds. Each is a word index from the transcript where the speaker stresses something, and text is the one or two words to throw on screen, taken from what they say, in capitals. Skip filler and generic words.`;
}

async function direct(m, visionLog, formats, dir) {
  const looks = dir ? await stills(m, dir).catch(() => []) : [];
  return new Promise((resolve, reject) => {
    LLM.call(prompt(m, visionLog, formats, looks), { images: looks.map(l => l.file), timeout: 300000 }, (err, out) => {
        if (err) return reject(err);
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
          scene: String(d.scene || '').slice(0, 100),
          nameCard: d.nameCard === true,
          tracked: ['yes', 'no', 'unsure'].includes(d.tracked) ? d.tracked : 'unsure',
          tone: ['formal', 'casual', 'hype'].includes(d.tone) ? d.tone : 'casual',
          wordLook: d.wordLook === 'block' ? 'block' : 'clean',
          saw: looks.length,
          inserts: (Array.isArray(d.inserts) ? d.inserts : [])
            .filter(x => x && ['photo', 'stat', 'headline', 'site'].includes(x.type) && Number.isInteger(x.word) && x.word >= 0 && x.word < n)
            .filter(x => (x.type === 'photo' && x.term) || (x.type === 'stat' && x.value) || (x.type === 'headline' && x.text) || (x.type === 'site' && x.url))
            .slice(0, 4).map(x => ({ type: x.type, word: x.word,
              ...(x.term ? { term: String(x.term).slice(0, 80) } : {}), ...(x.caption ? { caption: String(x.caption).slice(0, 40) } : {}),
              ...(x.value ? { value: String(x.value).slice(0, 16) } : {}), ...(x.label ? { label: String(x.label).slice(0, 40) } : {}),
              ...(x.text ? { text: String(x.text).slice(0, 48) } : {}), ...(x.url ? { url: String(x.url).slice(0, 120) } : {}) })),
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
