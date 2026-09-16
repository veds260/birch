"use strict";
// whisper mishears names and jargon, and the captions show it. This asks the local
// claude CLI for corrections only, never a rewrite, and applies them word for word.
const { execFile } = require("child_process");

function ask(words) {
  const text = words.map(w => w.text).join(" ");
  const prompt = `Below is an automatic transcript of someone speaking. It contains mishearings, especially of names, places, brands and jargon. Correct SINGLE WORDS only, one word replaced by one word. List ONLY the words that are actually wrong and what they should be. Do not rewrite, do not fix grammar, do not change wording, do not fix punctuation. If nothing is clearly wrong, return an empty array.

Return ONLY JSON: [{"wrong":"exact word as it appears","right":"corrected word"}]

TRANSCRIPT:
${text}`;
  return new Promise((resolve, reject) => {
    execFile("claude", ["-p", "--output-format", "text", prompt], { timeout: 150000, maxBuffer: 1 << 20 },
      (err, out) => {
        if (err) return reject(err);
        const m = String(out).match(/\[[\s\S]*\]/);
        if (!m) return resolve([]);
        try { resolve(JSON.parse(m[0])); } catch { resolve([]); }
      });
  });
}

// apply to the word list, keeping every timestamp exactly where it was
function apply(words, fixes) {
  const map = new Map();
  for (const f of fixes || []) {
    if (!f || !f.wrong || !f.right) continue;
    // one word for one word. Anything longer is a rewrite of what he said, and the
    // transcript is a record, not a draft.
    if (/\s/.test(String(f.wrong).trim()) || /\s/.test(String(f.right).trim())) continue;
    map.set(String(f.wrong).toLowerCase().replace(/[^a-z0-9\']/g, ""), String(f.right));
  }
  let n = 0;
  for (const w of words) {
    const bare = w.text.toLowerCase().replace(/[^a-z0-9\']/g, "");
    if (!map.has(bare)) continue;
    const tail = w.text.match(/[^\w]+$/);
    w.text = map.get(bare) + (tail ? tail[0] : "");
    n++;
  }
  return n;
}

module.exports = { ask, apply };
