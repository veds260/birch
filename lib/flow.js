'use strict';
// Drives Google Flow in a real Chrome over the DevTools Protocol, using a profile
// that keeps your Google session. Flow has no free API, so this is the only way
// to generate on the Pro plan without paying per second.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 9223;                       // not 9222, so it never fights your own Chrome
const PROFILE = path.join(__dirname, '..', 'chrome-profile');
const STATE = path.join(__dirname, '..', 'flow-state.json');
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']
  .find(p => fs.existsSync(p));

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const writeState = s => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// /about is the logged-out marketing page, so treat it as not signed in
const isIn = url => !/accounts\.google\.com|ServiceLogin|flow\.google\.com\/about/.test(url || '');

const httpJson = url => new Promise((resolve, reject) => {
  http.get(url, r => { let d = ''; r.on('data', c => d += c);
    r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); })
    .on('error', reject);
});

async function alive() { try { await httpJson(`http://127.0.0.1:${PORT}/json/version`); return true; }
  catch { return false; } }

async function ensureChrome() {
  if (await alive()) return;
  if (!CHROME) throw new Error('No Chrome or Brave found in /Applications.');
  fs.mkdirSync(PROFILE, { recursive: true });
  spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
    'https://flow.google.com/'], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40; i++) { await sleep(500); if (await alive()) return; }
  throw new Error('Chrome would not start with debugging on.');
}

// Flow's Approve / Reject controls are not <button>s, so find the label's own
// element and click the nearest thing that looks clickable above it
const CLICK_BY_TEXT = `(re) => {
  const els = [...document.querySelectorAll('*')].filter(e => e.children.length < 4 &&
    re.test((e.innerText || '').trim()));
  const leaf = els.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
  if (!leaf) return false;
  let n = leaf;
  for (let i = 0; i < 6 && n; i++) {
    const r = n.getAttribute && (n.getAttribute('role') || '');
    // Approve / Always approve / Reject are radio rows in Flow, not buttons
    if (n.tagName === 'BUTTON' || /^(button|radio|option|menuitem)$/.test(r) || n.onclick ||
        /button|chip|action|option-row/i.test(n.className || ''))
      { n.click(); return n.tagName; }
    n = n.parentElement;
  }
  leaf.click(); return leaf.tagName;
}`;

// minimal CDP client, Node has WebSocket built in now
class Tab {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async open(url) {
    await ensureChrome();
    const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
    let t = list.find(x => x.type === 'page' && x.url.includes('flow.google.com'));
    if (!t) t = await httpJson(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const tab = new Tab(ws);
    tab.events = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && tab.waiting.has(m.id)) { tab.waiting.get(m.id)(m); tab.waiting.delete(m.id); }
      else if (m.method) tab.events.push(m);
    };
    return tab;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(method + ' timed out')), 45000);
      this.waiting.set(id, m => { clearTimeout(timer);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      // exceptionDetails.text is just "Uncaught", the real message is deeper
      throw new Error(d.exception?.description || d.exception?.value ||
        d.text + ' ' + (expr.slice(0, 60)));
    }
    return r.result.value;
  }
  async goto(url) {
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const s = await this.eval('document.readyState');
      if (s === 'complete') { await sleep(2500); return; }
    }
  }
  // Attach reference images to the prompt. This is the difference between a shot
  // that was invented and one that is grounded in the real thing, which is how
  // Arcads and Creatify get theirs to look right: they never let the model guess.
  async attachFiles(files) {
    if (!files || !files.length) return false;
    const clicked = await this.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /Add ingredients/i.test(x.getAttribute('aria-label') || ''));
      if (!b) return false; b.click(); return true; })()`);
    if (!clicked) return false;
    await sleep(1200);
    await this.eval(`(() => {
      const b = [...document.querySelectorAll('button,[role=menuitem]')].find(x => /Upload media/i.test(x.innerText || ''));
      if (b) b.click(); return !!b; })()`);
    await sleep(1200);
    await this.send('DOM.enable');
    const { root } = await this.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
    if (!nodeId) return false;
    await this.send('DOM.setFileInputFiles', { nodeId, files });
    // the upload has to finish before the prompt is sent
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      const ready = await this.eval(`/uploading|processing/i.test(document.body.innerText) ? false : true`);
      if (ready) break;
    }
    await sleep(1500);
    return true;
  }

  // Flow renders late, so nothing is read from the page until the thing is there
  async waitFor(selector, ms = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await this.eval(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
      await sleep(500);
    }
    return false;
  }
  close() { try { this.ws.close(); } catch {} }
}


async function status() {
  if (!(await alive())) return { running: false, project: readState().project || null };
  const tab = await Tab.open('https://flow.google.com/');
  try {
    const url = await tab.eval('location.href');
    // /about is the logged-out marketing page, so it counts as not signed in
    return { running: true, url, project: readState().project || null,
      signedIn: isIn(url) };
  } finally { tab.close(); }
}

// opens the window so you can sign in once, then the session sticks
async function login() {
  await ensureChrome();
  const tab = await Tab.open('https://flow.google.com/');
  await tab.goto('https://flow.google.com/');
  const url = await tab.eval('location.href');
  tab.close();
  return { url, needsLogin: !isIn(url) };
}

async function ensureProject(tab) {
  const st = readState();
  if (st.project) {
    await tab.goto(st.project);
    if (await tab.waitFor('.ProseMirror')) return st.project;
  }
  await tab.goto('https://flow.google.com/');
  await tab.eval(`(() => {
    const b = [...document.querySelectorAll('button,div[role=button]')]
      .find(e => /new project/i.test(e.innerText || ''));
    if (b) b.click();
  })()`);
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    const u = await tab.eval('location.href');
    if (/\/project\//.test(u)) {
      writeState({ ...st, project: u });
      await tab.waitFor('.ProseMirror');
      return u;
    }
  }
  throw new Error('Could not open a Flow project.');
}

async function generate(prompt, outDir, onStage, ingredients) {
  fs.mkdirSync(outDir, { recursive: true });
  const tab = await Tab.open('https://flow.google.com/');
  try {
    onStage && onStage('opening Flow');
    const url = await tab.eval('location.href');
    if (!isIn(url)) throw new Error('Not signed in to Flow in that window yet.');

    await ensureProject(tab);

    // a visible challenge is the user's to clear, never ours
    if (await tab.eval(`!!document.querySelector('iframe[title*="recaptcha challenge"]')`))
      throw new Error('Flow is showing a challenge. Clear it in the Flow window, then try again.');

    // anything still waiting for a yes is a stale prompt from an earlier run
    for (let i = 0; i < 4; i++) {
      const hit = await tab.eval(`(${CLICK_BY_TEXT})(/^Reject$/)`);
      if (!hit) break;
      await sleep(500);
    }

    if (ingredients && ingredients.length) {
      onStage && onStage(`attaching ${ingredients.length} reference image${ingredients.length > 1 ? 's' : ''}`);
      const ok = await tab.attachFiles(ingredients.filter(f => fs.existsSync(f)));
      if (!ok) onStage && onStage('could not attach references, going on without them');
    }

    onStage && onStage('typing the prompt');
    if (!(await tab.waitFor('.ProseMirror')))
      throw new Error('Flow never showed its prompt box.');
    await tab.eval(`(() => { const e = document.querySelector('.ProseMirror');
      e.focus(); document.execCommand('selectAll'); document.execCommand('delete'); })()`);
    await tab.send('Input.insertText', { text: prompt });
    await sleep(600);

    // watch the wire for the finished clip, which is the only reliable signal
    await tab.send('Network.enable');
    tab.events.length = 0;
    const seenBefore = new Set();
    const mediaUrls = () => {
      const out = [];
      for (const ev of tab.events) {
        if (ev.method !== 'Network.responseReceived') continue;
        const r = ev.params.response || {};
        const u = r.url || '';
        if (/video\/mp4|video\/webm/.test(r.mimeType || '') || /\.mp4(\?|$)/.test(u)) out.push(u);
      }
      return out;
    };
    onStage && onStage('asking Flow to generate');
    // the button flickers disabled for a beat after the text lands, so keep trying
    let clicked = false;
    for (let i = 0; i < 20 && !clicked; i++) {
      clicked = await tab.eval(`(() => {
        const b = [...document.querySelectorAll('button')]
          .find(x => /start generation/i.test(x.getAttribute('aria-label') || ''));
        if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
        b.click(); return true; })()`);
      if (!clicked) await sleep(500);
    }
    if (!clicked) throw new Error('The generate button was not ready.');

    for (const u of mediaUrls()) seenBefore.add(u);

    // Flow asks before spending credits. Say yes once for good, else yes for this one.
    onStage && onStage('approving the credit spend');
    // once "Always approve" has been picked, Flow stops asking, so a run that is
    // already generating counts as approved too
    // the card takes a few seconds to arrive, and older bubbles can contain the
    // same words, so the text fallback only counts after ten quiet seconds
    let approved = false;
    for (let i = 0; i < 40 && !approved; i++) {
      await sleep(1000);
      approved = !!(await tab.eval(`(() => {
        const rs = [...document.querySelectorAll('[role=radio]')]
          .filter(r => /Always approve\\s*$/.test(r.innerText) && r.getAttribute('aria-checked') !== 'true');
        const r = rs[rs.length - 1]; if (!r) return false; r.click(); return true; })()`));
      if (!approved && i >= 10)
        approved = !!(await tab.eval(`(() => {
          const last = [...document.querySelectorAll('flow-chat-bubble')].pop();
          return !!last && /generating|kicked off|in progress|rendering/i.test(last.innerText); })()`));
    }
    if (!approved) throw new Error('Flow never asked for approval and never started generating.');

    onStage && onStage('waiting on Flow, this takes a couple of minutes');
    let src = null;
    const t0 = Date.now();

    // Flow plays a finished clip through an MSE blob, so waiting for a non-blob
    // <video> src misses it: the clip is on screen and the poller still says
    // nothing arrived. Count the tiles instead, and once the grid grows, go and
    // resolve the real file.
    const countTiles = () => tab.eval(`(() => {
      const sel = 'video, [data-media-id], [class*="tile"] img, [class*="result"] video';
      return document.querySelectorAll(sel).length; })()`).catch(() => 0);
    const baseTiles = await countTiles();

    // pull a downloadable url for the newest result, trying the cheap routes first
    const resolveSrc = async () => {
      const fresh = mediaUrls().filter(u => !seenBefore.has(u) && !/blob:/.test(u));
      if (fresh.length) return fresh[fresh.length - 1];
      const direct = await tab.eval(`(() => {
        const out = [];
        for (const v of document.querySelectorAll('video')) {
          const s = v.currentSrc || v.src || '';
          if (s && !s.startsWith('blob:')) out.push(s);
          for (const c of v.querySelectorAll('source')) if (c.src) out.push(c.src);
        }
        for (const a of document.querySelectorAll('a[href*=".mp4"], a[download]')) out.push(a.href);
        return [...new Set(out)]; })()`).catch(() => []);
      const d = (direct || []).filter(u => u && !seenBefore.has(u));
      if (d.length) return d[d.length - 1];
      // last resort: play the newest tile so the network layer fetches the asset
      await tab.eval(`(() => {
        const v = [...document.querySelectorAll('video')].pop();
        if (v) { try { v.play(); } catch (e) {} }
        return !!v; })()`).catch(() => {});
      await sleep(2500);
      const after = mediaUrls().filter(u => !seenBefore.has(u) && !/blob:/.test(u));
      return after.length ? after[after.length - 1] : null;
    };

    let grewAt = 0;
    while (Date.now() - t0 < 30 * 60 * 1000) {          // queued jobs can sit a long time on a busy night
      await sleep(1500);

      const got = await resolveSrc();
      if (got) { src = got; break; }

      // the grid grew, so something finished even though no url surfaced yet
      const n = await countTiles();
      if (n > baseTiles) {
        if (!grewAt) { grewAt = Date.now(); onStage && onStage('clip is there, fetching it'); }
        if (Date.now() - grewAt > 20000) {
          throw new Error('Flow finished the clip but would not hand over the file. '
            + 'Open the Flow window, download it, and drop it in with Import.');
        }
      }

      if (await tab.eval(`/failed to generate|could not generate|generation failed|blocked/i
            .test(([...document.querySelectorAll('flow-chat-bubble')].pop() || {}).innerText || '')`))
        throw new Error('Flow reported the generation failed.');
      if (await tab.eval(`/out of credits|no credits left|daily limit/i.test(document.body.innerText)`))
        throw new Error('Flow says the daily credits are used up.');
      if (await tab.eval(`!!document.querySelector('iframe[title*="recaptcha challenge"]')`))
        throw new Error('Flow is showing a challenge. Clear it in the Flow window, then try again.');
      if (!grewAt)
        onStage && onStage('waiting on Flow, ' + Math.round((Date.now() - t0) / 1000) + 's');
    }
    if (!src) throw new Error('Flow did not return a clip in 30 minutes. It may still finish; use Collect from Flow.');

    onStage && onStage('downloading');
    const out = path.join(outDir, 'flow-' + Date.now().toString(36) + '.mp4');
    await new Promise(resolve =>
      execFile('curl', ['-sSL', '--max-time', '180', '-o', out, src], () => resolve()));
    if (!fs.existsSync(out) || fs.statSync(out).size < 5000) {
      // signed URL refused a bare curl, so pull it through the page's own session
      const b64 = await tab.eval(`fetch(${JSON.stringify(src)}).then(r => r.arrayBuffer()).then(b => {
        let s = ''; const a = new Uint8Array(b);
        for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
        return btoa(s); })`);
      fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    }
    if (!fs.existsSync(out) || fs.statSync(out).size < 5000)
      throw new Error('The clip came back empty.');
    return { file: out, src };
  } finally { tab.close(); }
}

// after a queue outlasts the watcher, the clip still lands in the project grid
async function collect(outDir, known = new Set()) {
  fs.mkdirSync(outDir, { recursive: true });
  const tab = await Tab.open('https://flow.google.com/');
  try {
    await tab.send('Network.enable');
    await ensureProject(tab);
    await sleep(4000);
    const urls = await tab.eval(`(() => {
      const out = [];
      for (const v of document.querySelectorAll('video')) { const s = v.currentSrc || v.src; if (s && !s.startsWith('blob:')) out.push(s); }
      for (const a of document.querySelectorAll('a[href*=".mp4"],a[download]')) out.push(a.href);
      return [...new Set(out)]; })()`);
    const got = [];
    for (const u of urls) {
      if (known.has(u)) continue;
      const out = path.join(outDir, 'flow-' + Date.now().toString(36) + got.length + '.mp4');
      await new Promise(r => execFile('curl', ['-sSL', '--max-time', '180', '-o', out, u], () => r()));
      if (fs.existsSync(out) && fs.statSync(out).size > 5000) got.push({ file: out, src: u });
      else { try { fs.unlinkSync(out); } catch {} }
    }
    return got;
  } finally { tab.close(); }
}

module.exports = { status, login, generate, collect, PROFILE, PORT };
