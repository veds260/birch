'use strict';
// Edit by asking. The instruction, the transcript with timestamps, what is already
// on screen, and an optional reference look go to the local claude CLI, which
// returns a list of operations the server can apply with the tools it already has.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const REFS = () => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'refs', 'refs.json'), 'utf8')); } catch { return {}; } };

const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function transcriptWithTimes(words) {
  // one line per sentence with its start time and first word index, so the model
  // can name a moment either way
  const out = []; let cur = null;
  words.forEach((w, i) => {
    if (!cur) cur = { i, t: w.start, text: '' };
    cur.text += (cur.text ? ' ' : '') + w.text;
    if (/[.?!]$/.test(w.text)) { out.push(cur); cur = null; }
  });
  if (cur) out.push(cur);
  return out.map(s => `[${mmss(s.t)} w${s.i}] ${s.text}`).join('\n');
}

function currentState(m) {
  const ov = (m.overlays || []).map(o => `- ${o.type} "${o.label || ''}" at w${o.word} for ${o.dur}s`).join('\n') || '- nothing';
  const ls = (m.lists || []).map(l => `- ${l.look || 'list'}: ${l.lines.map(x => x.text).join(' / ')}`).join('\n') || '- none';
  const rf = (m.reframes || []).map(r => `- speaker shrunk to ${r.corner} at w${r.word} for ${r.dur}s`).join('\n') || '- none';
  const v = m.vision ? `What the camera sees: ${m.vision.seconds}s of footage, a face in ${m.vision.withFace}s of it, ${m.vision.cuts} shot changes, shots mostly ${Object.entries(m.vision.shots || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || 'medium'}; looks like: ${(m.vision.tags || []).slice(0, 6).join(', ')}${m.vision.screen?.length ? '; screen-recording stretches at ' + m.vision.screen.map(s => mmss(s.start) + '-' + mmss(s.end)).join(', ') : ''}.` : '';
  return `${v}\nOn screen now:\n${ov}\nLists:\n${ls}\nReframes:\n${rf}\nCaption style: ${m.settings?.capStyle || 'minimal'}, shape ${m.settings?.aspect || 'source'}`;
}

const CONTRACT = `Return ONLY a JSON array of operations. Allowed ops:
{"op":"title","at":"m:ss","headline":"...","subline":"...","face":"ultra|condensed|rounded|serif|scrawl","accent":"#hex","seconds":4,"upper":true}
{"op":"card","at":"m:ss","headline":"...","lines":["..."],"body":"...","highlight":"...","band":{"y":0.0,"h":0.3}|null,"seconds":4}
{"op":"list","at":["m:ss","m:ss"],"lines":["...","..."],"look":"plain|pills"}
{"op":"reframe","at":"m:ss","seconds":6,"corner":"split|bl|br|tl|tr","scale":0.42}   (split = white panel on top, speaker full width below; put the insert in the panel with slot:"top")
{"op":"cut","from":"m:ss","to":"m:ss"}
{"op":"captions","style":"minimal|clean|seam|scrawl|story|plate|pop|single|karaoke|outline|box","on":true,"dynamic":true|false,"behind":true|false}   (dynamic = each line moves to the empty side of the head and short lines go bigger; behind = the person is in front of the words)
{"op":"shape","aspect":"9:16|4:5|1:1|16:9|source"}
{"op":"shot","at":"m:ss","line":"...","object":"...","seconds":4}
{"op":"tweet","at":"m:ss","url":"https://x.com/...","slot":"top"|null}
{"op":"asset","at":"m:ss","term":"the thing by its real name","seconds":3}   (a real free photo of a named company, person or place; evidence beats atmosphere, use this whenever the thing actually exists)
{"op":"pop","at":"m:ss","text":"ONE OR TWO WORDS","seconds":1.2}   (a big orange keyword with a confetti burst, on a word the speaker stresses)
{"op":"cloud","at":"m:ss","words":["...","..."],"seconds":3}       (6-10 words scattered round the head, for a spoken run of items)
{"op":"gradient","at":"m:ss","text":"two\nlines","sub":"smaller line","seconds":3}   (green-to-white hook type, centre-low)
{"op":"comment","at":"m:ss","handle":"someone","text":"the comment","seconds":4}   (an Instagram reply card, for a comment-reply hook)
{"op":"letterbox","on":true}   (cinematic bars for story footage; pair with captions style story)
{"op":"cow","at":"m:ss","seconds":0.7}   (the purple cow: a sudden zoom punch, purple shift and bass hit on the one beat that deserves a jolt; use at most once)
{"op":"spotlight","at":"m:ss","seconds":3,"x":0.1,"y":0.3,"w":0.8,"h":0.3}   (everything outside a rectangle dims; use on a screen-recording stretch to point at one thing)
{"op":"grade","name":"warm|film|clean|punch|mono|cool"}   (the whole video)
{"op":"section","from":"m:ss","to":"m:ss","captions":true|false,"grade":"film","letterbox":true|false}   (a look that belongs to ONE stretch, not the timeline)
Times must come from the transcript. Never invent quotes. Keep on-screen lines under seven words and never a paraphrase of the sentence; reframe it.

Restraint matters more than coverage. A move used once lands; the same move every ten seconds is wallpaper. Use any one kind of thing at most twice in a short video, leave long stretches with nothing but the speaker, and never put two things on screen in the same second. If a look only suits one passage, scope it with a section rather than applying it to the whole timeline.`;

function ask(instruction, m, refKey) {
  const refs = REFS();
  const ref = refKey && refs[refKey] ? `Reference look to match: ${refs[refKey].look}. Tags: ${refs[refKey].tags.join(', ')}.` : 'No reference look given.';
  const p = `You are editing a short vertical talking-head video. ${ref}\n\n${currentState(m)}\n\nTRANSCRIPT (time, word index, sentence):\n${transcriptWithTimes(m.words)}\n\nINSTRUCTION FROM THE EDITOR:\n${instruction}\n\n${CONTRACT}`;
  return new Promise((resolve, reject) => {
    execFile('claude', ['-p', '--output-format', 'text', p], { timeout: 180000, maxBuffer: 1 << 20 }, (err, out) => {
      if (err) return reject(err);
      const mm = String(out).match(/\[[\s\S]*\]/);
      if (!mm) return reject(new Error('no JSON in the reply'));
      try { resolve(JSON.parse(mm[0])); } catch (e) { reject(e); }
    });
  });
}

// "1:23" -> the index of the first word at or after that time
function wordAt(words, at) {
  const [mm, ss] = String(at).split(':').map(Number);
  const t = (isNaN(ss) ? Number(at) : mm * 60 + ss) || 0;
  const i = words.findIndex(w => w.start >= t - 0.05);
  return i < 0 ? words.length - 1 : i;
}

module.exports = { ask, wordAt, REFS, transcriptWithTimes };
