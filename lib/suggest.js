'use strict';
// Reads the transcript and works out what should go on screen, so you do not
// have to go hunting for it.
const https = require('https');
// read at call time, the server sets it after this module loads
const KEY = () => process.env.TWITTERAPI_KEY || '';

const get = url => new Promise((resolve, reject) => {
  https.get(url, { headers: { 'X-API-Key': KEY() } }, r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

const STOP = new Set(['i', 'a', 'the', 'and', 'but', 'so', 'it', 'this', 'that', 'we', 'you',
  'they', 'he', 'she', 'is', 'was', 'are', 'to', 'of', 'in', 'on', 'for', 'with', 'my', 'our',
  'hello', 'hey', 'okay', 'well', 'now', 'then', 'here', 'there', 'what', 'when', 'why', 'how',
  'if', 'as', 'at', 'by', 'from', 'or', 'not', 'no', 'yes', 'um', 'uh', 'ah', 'today', 'basically']);

// rebuild sentences so we can reason about whole thoughts, keeping word indexes
function sentences(words) {
  const out = [];
  let cur = { text: '', a: 0, b: 0 };
  words.forEach((w, i) => {
    if (!cur.text) cur.a = i;
    cur.text += (cur.text ? ' ' : '') + w.text;
    cur.b = i;
    if (/[.?!]$/.test(w.text)) { out.push(cur); cur = { text: '', a: 0, b: 0 }; }
  });
  if (cur.text) out.push(cur);
  return out;
}

// @handles, plus capitalised runs that are not just the start of a sentence
function entities(words) {
  const found = new Map();
  const sents = sentences(words);
  const startIdx = new Set(sents.map(s => s.a));
  words.forEach((w, i) => {
    const raw = w.text.replace(/[^\w@'.]/g, '');
    if (!raw) return;
    if (raw.startsWith('@') && raw.length > 2) {
      const h = raw.slice(1).toLowerCase();
      if (!found.has(h)) found.set(h, { name: raw, handle: h, word: i, kind: 'handle' });
      return;
    }
    if (!/^[A-Z][a-zA-Z]{2,}$/.test(raw)) return;
    if (startIdx.has(i)) return;                       // sentence-initial capital means nothing
    if (STOP.has(raw.toLowerCase())) return;
    // glue a following capital on, so "Open Campus" stays together
    let name = raw, j = i;
    while (j + 1 < words.length && /^[A-Z][a-zA-Z]{2,}[,.]?$/.test(words[j + 1].text)) {
      name += ' ' + words[j + 1].text.replace(/[^\w]/g, ''); j++;
    }
    const k = name.toLowerCase();
    if (!found.has(k)) found.set(k, { name, word: i, kind: 'name' });
  });
  // "Second City" already covers "City", so drop the shorter overlapping ones
  const all = [...found.values()];
  return all.filter(e => !all.some(o => o !== e && o.kind === e.kind &&
    o.name.length > e.name.length && o.name.toLowerCase().includes(e.name.toLowerCase())));
}

async function tweetFor(ent) {
  // searching on a bare name pulled back unrelated tweets, so only a spoken
  // @handle is trustworthy enough to place a card automatically
  if (!KEY() || ent.kind !== 'handle') return null;
  const q = `from:${ent.handle} -filter:replies`;
  try {
    const d = await get('https://api.twitterapi.io/twitter/tweet/advanced_search?queryType=Top&query=' +
      encodeURIComponent(q));
    const t = (d.tweets || [])[0];
    if (!t) return null;
    return { id: t.id, text: (t.text || '').slice(0, 90),
      author: t.author?.userName, likes: t.likeCount || 0 };
  } catch { return null; }
}

/* A kinetic-type insert, as the video models are best used for it:
   a five to eight second clip, flat background, one or two objects that snap in,
   a few exact words that stamp in, a sound hit, a static camera, a punch out.
   The prompt is art direction, and the creators write it as a numbered shot
   list with the on-screen text capped at six words. So that is what this makes. */

const PALETTES = [
  { bg: 'pure black (#0D0D0D) with subtle film grain', ink: 'white', hot: 'signal red (#E8222A)' },
  { bg: 'cream (#F3EEE4) with a faint grid pattern', ink: 'near-black (#141414)', hot: 'bold red (#D7263D)' },
  { bg: 'acid yellow (#F5E31C), flat', ink: 'black', hot: 'white' },
  { bg: 'deep navy (#0B1530) with soft vignette', ink: 'white', hot: 'electric blue (#3B82F6)' },
  { bg: 'off-white paper (#F7F5F0) with torn newspaper edges and halftone dots', ink: 'black', hot: 'red marker' },
];

// an object that stands for the idea, drawn as a thing that can snap in
const OBJECTS = [
  [/money|pay|cost|price|revenue|sell|buy|afford|dollar|profit/, 'a stack of banknotes', 'coins dropping one by one'],
  [/idea|think|creative|imagine|brain|insight/, 'a 3D glowing lightbulb', 'a lightbulb flickering on'],
  [/time|slow|fast|wait|hour|day|year|deadline/, 'a wall clock with a sweeping hand', 'an hourglass'],
  [/listen|hear|attention|focus|voice|talk|speak/, 'a vintage microphone', 'sound-wave bars pulsing'],
  [/grow|scale|increase|more|double|bigger/, 'a bar chart with bars rising', 'an arrow bending sharply upward'],
  [/fail|wrong|mistake|broke|stuck|lost/, 'a cracked phone screen', 'a red X stamping in'],
  [/people|team|friend|customer|audience|everyone/, 'a row of paper cut-out figures', 'chat bubbles stacking'],
  [/brand|logo|company|business|startup/, 'brand logos appearing one by one', 'a storefront sign lighting up'],
  [/learn|teach|school|class|study|skill/, 'an open notebook with pen marks', 'a graduation cap dropping in'],
  [/phone|app|screen|online|scroll|post|video/, 'a phone mockup tilting in', 'a play button pulsing'],
];

const MOVES = [
  'snapping in from blur with a hard bounce (ease-out-back, 0.2s settle)',
  'sliding up from the bottom edge and overshooting slightly',
  'scaling from 0 to 100% with a quick pop, then a small shake',
  'stamping in with a flash frame, then holding still',
  'rotating in 15 degrees and settling flat',
];
const HITS = ['a dramatic bass-thud', 'a sharp camera-shutter click', 'a paper-rip', 'a deep whoosh', 'a single piano note'];
const OUTS = ['quick zoom-punch into black', 'flash to white then hard cut', 'the object shrinks to a dot and vanishes',
              'hard cut, no transition', 'wipe right on a paper tear'];

let shotN = 0;

// the six words that go on screen, pulled from the line itself
function onScreen(sentence) {
  const s = sentence.replace(/[^\w\s'$%.,!?-]/g, ' ').replace(/\s+/g, ' ').trim();
  const stop = new Set([...STOP, 'about', 'really', 'going', 'would', 'could', 'should', 'thing', 'things',
    'stuff', 'because', 'which', 'where', 'there', 'their', 'these', 'those', 'have', 'been', 'just',
    'like', 'very', 'much', 'more', 'some', 'into', 'than', 'then', 'them', 'they', 'were', 'will', 'with']);
  const strong = s.split(' ').filter(w => w.length > 3 && !stop.has(w.toLowerCase().replace(/[^a-z]/g, '')));
  const pick = strong.slice(0, 4).join(' ').replace(/[,.]$/, '');
  const line = pick.length >= 8 ? pick : s.split(' ').slice(0, 5).join(' ');
  return line.charAt(0).toUpperCase() + line.slice(1).replace(/[.,!?]+$/, '') + '.';
}

function shotPrompt(sentence, text) {
  const s = sentence.toLowerCase();
  const pal = PALETTES[shotN % PALETTES.length];
  const hit = OBJECTS.find(([re]) => re.test(s));
  const obj = hit ? hit[1 + (shotN % 2)] : 'a single bold geometric shape';
  const move = MOVES[shotN % MOVES.length];
  const sfx = HITS[shotN % HITS.length];
  const out = OUTS[shotN % OUTS.length];
  const words = text.replace(/\.$/, '').split(' ');
  const first = words.slice(0, Math.ceil(words.length / 2)).join(' ');
  const rest = words.slice(Math.ceil(words.length / 2)).join(' ');
  shotN++;
  return `Vertical 9:16 portrait video, 6 seconds. ${pal.bg} background. ` +
    `${obj[0].toUpperCase() + obj.slice(1)} on the left third of frame, ${move}, ` +
    `then holds. Simultaneously, bold ${pal.ink} grotesque text stamps in at center right: ` +
    `"${first}" in ${pal.ink}` + (rest ? `, then below it "${rest}" in ${pal.hot}, larger, scale-in from 120% to 100% in 0.15s` : '') +
    `. No other text anywhere, no captions, no logos. ${sfx.charAt(0).toUpperCase() + sfx.slice(1)} sound hit on the reveal, ` +
    `then a low instrumental bed at 90 BPM. Camera: completely static. Transition out: ${out}.`;
}

// sentences worth cutting away to: concrete, mid-length, not the opener
function brollMoments(words, max = 4) {
  const sents = sentences(words).filter(s => s.text.split(' ').length >= 6);
  return sents
    .map(s => {
      const nouns = (s.text.match(/\b[a-z]{5,}\b/g) || []).filter(w => !STOP.has(w));
      return { ...s, score: nouns.length };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .sort((a, b) => a.a - b.a)
    .map((s, i) => { const label = onScreen(s.text); return { n: i + 1, word: s.a,
      text: s.text.slice(0, 120), onScreen: label, prompt: shotPrompt(s.text, label) }; });
}

/* Find tweets worth dropping in without anyone pasting a link. The earlier
   version searched bare names and got junk, so now every query is a phrase or a
   named thing, and a result only survives if it shares two or more key terms
   with the transcript. Likes break ties. */
const CONTENT_STOP = new Set([...STOP, 'about', 'really', 'going', 'would', 'could', 'should',
  'thing', 'things', 'stuff', 'because', 'which', 'where', 'there', 'their', 'these', 'those',
  'have', 'been', 'just', 'like', 'very', 'much', 'more', 'some', 'into', 'than', 'then', 'them',
  'were', 'will', 'with', 'what', 'when', 'your', 'from', 'that', 'this', 'also', 'even', 'only',
  'other', 'first', 'said', 'says', 'want', 'know', 'think', 'make', 'made', 'take', 'people']);

const WEAK = new Set(['started','start','starting','taking','took','take','show','shows','showed',
  'each','other','every','going','went','come','came','give','gave','look','looks','looked','told',
  'tell','say','said','get','got','getting','used','using','use','way','ways','lot','lots','done','doing',
  'need','needs','needed','still','back','again','never','always','right','little','long','good','best']);

function keyTerms(words) {
  const freq = new Map();
  for (const w of words) {
    const k = w.text.toLowerCase().replace(/[^a-z']/g, '');
    if (k.length < 4 || CONTENT_STOP.has(k) || WEAK.has(k)) continue;
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

function queries(words) {
  const out = [];
  const ents = entities(words).filter(e => e.kind === 'name');
  for (const e of ents.slice(0, 5)) out.push({ q: `"${e.name}"`, word: e.word, why: e.name, entity: true });
  // strong two-word phrases from the sentences themselves
  const terms = new Set(keyTerms(words).slice(0, 14));
  for (const s of sentences(words)) {
    const toks = s.text.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean);
    for (let i = 0; i + 1 < toks.length; i++) {
      if (terms.has(toks[i]) && terms.has(toks[i + 1])) {
        const q = `"${toks[i]} ${toks[i + 1]}"`;
        if (out.some(o => o.q.toLowerCase() === q)) continue;   // a name already covers this
        out.push({ q, word: s.a, why: toks[i] + ' ' + toks[i + 1] });
      }
    }
  }
  // fall back to the top single terms paired, so a plain talk still gets a search
  const top = keyTerms(words).slice(0, 4);
  if (out.length < 4 && top.length >= 2) out.push({ q: `${top[0]} ${top[1]}`, word: 0, why: top[0] + ' ' + top[1] });
  return out.slice(0, 8);
}

async function search(q) {
  if (!KEY()) return [];
  try {
    const base = `${q} min_faves:40 lang:en -filter:replies -filter:retweets`;
    const [a, b] = await Promise.all(['Top', 'Latest'].map(k =>
      get('https://api.twitterapi.io/twitter/tweet/advanced_search?queryType=' + k + '&query=' +
        encodeURIComponent(base)).catch(() => ({}))));
    return [...(a.tweets || []), ...(b.tweets || [])].slice(0, 16);
  } catch { return []; }
}

async function findTweets(words) {
  const terms = new Set(keyTerms(words).slice(0, 25));
  const ents = entities(words).filter(e => e.kind === 'name');
  const seen = new Set();
  const found = [];
  for (const qq of queries(words)) {
    for (const t of await search(qq.q)) {
      if (!t.id || seen.has(t.id)) continue;
      seen.add(t.id);
      const toks = new Set((t.text || '').toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/));
      const hits = [...terms].filter(k => toks.has(k));
      if (hits.length < 2 || hits.every(h => WEAK.has(h))) continue;
      const text = (t.text || '').toLowerCase();
      if (qq.entity && !text.includes(qq.why.toLowerCase())) continue;   // the name, as a phrase
      // a name can mean something else entirely (Tartu is Estonia's "second city"), so an
      // entity match also needs one more term from the talk in the tweet
      const why = qq.why.toLowerCase();
      // a topical term is a noun-ish word the talk leans on, not any long word that overlaps
      const SOFT = new Set(['wonderful', 'understand', 'classes', 'second', 'importance', 'everyone',
        'anyone', 'something', 'nothing', 'because', 'behind', 'before', 'through', 'without']);
      const extraHits = hits.filter(h => !why.includes(h) && h.length >= 5 && !SOFT.has(h));
      if (qq.entity && extraHits.length < 1) continue;
      const author = (t.author?.userName || '').toLowerCase() + ' ' + (t.author?.name || '').toLowerCase();
      // the named person's own account: match the whole name, or a surname that is
      // actually a surname, never a generic word like "city" or "campus"
      const GENERIC = new Set(['city', 'campus', 'school', 'company', 'group', 'team', 'club', 'house', 'world', 'news']);
      const byNamed = ents.some(e => {
        const full = e.name.toLowerCase(), last = full.split(' ').pop();
        return author.includes(full) || (full.includes(' ') && last.length >= 5 && !GENERIC.has(last) && author.includes(last));
      });
      // extra hits beyond the query phrase mean the tweet is about the same thing, not just the same words
      const extra = extraHits.length;
      found.push({ word: qq.word, why: qq.why, hits, byNamed,
        score: (1 + extra) * Math.log10(10 + (t.likeCount || 0)) + (byNamed ? 6 : 0),
        tweet: { id: t.id, text: (t.text || '').slice(0, 140), author: t.author?.userName,
          likes: t.likeCount || 0, views: t.viewCount || 0 } });
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, 5);
}

async function suggest(words) {
  const ents = entities(words).filter(e => e.kind === 'handle').slice(0, 6);
  const names = entities(words).filter(e => e.kind === 'name').slice(0, 6);
  const tweets = [];
  for (const e of ents) {
    const t = await tweetFor(e);
    if (t) tweets.push({ ...e, tweet: t });
  }
  const found = await findTweets(words);
  return { tweets, found, names, broll: brollMoments(words) };
}

module.exports = { suggest, entities, brollMoments, sentences, findTweets };
