'use strict';
// Frames drawn by a real browser instead of by hand in Pillow.
// Every overlay in this tool is already a PNG sequence that ffmpeg composites,
// so swapping the thing that draws those PNGs changes the motion without
// touching the render pipeline. CSS gives easing, springs, blur and real text
// layout, which is the gap between our captions and the ones he's referencing.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 9224;                        // 9223 is Flow's, never share it
const CHROME = require('./bin').chrome();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const httpJson = (url, method = 'GET') => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method },
    r => { let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } }); });
  req.on('error', reject); req.end();
});
const alive = async () => { try { await httpJson(`http://127.0.0.1:${PORT}/json/version`); return true; }
  catch { return false; } };

let proc = null;
async function ensure() {
  if (await alive()) return;
  if (!CHROME) throw new Error('No Chrome, Chromium, Brave or Edge found on this machine.');
  const prof = path.join(require('os').tmpdir(), 'vd-render-profile');
  fs.mkdirSync(prof, { recursive: true });
  proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-gpu', '--default-background-color=00000000', 'about:blank'],
    { detached: true, stdio: 'ignore' });
  proc.unref();
  for (let i = 0; i < 40; i++) { await sleep(250); if (await alive()) return; }
  throw new Error('Headless Chrome did not come up.');
}

class Frame {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); }
  static async open(W, H) {
    await ensure();
    // newer Chrome wants PUT for /json/new, and only a page target takes a
    // metrics override, so never fall back to the browser target
    let t = await httpJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, 'PUT').catch(() => null);
    if (!t || !t.webSocketDebuggerUrl) {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      t = (Array.isArray(list) ? list : []).find(x => x.type === 'page' && x.webSocketDebuggerUrl);
    }
    if (!t) throw new Error('Headless Chrome gave no page target.');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const f = new Frame(ws); f.target = t.id;
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && f.waits.has(m.id)) { f.waits.get(m.id)(m); f.waits.delete(m.id); }
    };
    await f.send('Page.enable');
    await f.send('Runtime.enable');
    await f.send('Emulation.setDeviceMetricsOverride',
      { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    // transparent, so ffmpeg can composite these straight over the footage
    await f.send('Emulation.setDefaultBackgroundColorOverride',
      { color: { r: 0, g: 0, b: 0, a: 0 } });
    return f;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(method + ' timed out')), 30000);
      this.waits.set(id, m => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async load(html) {
    // Chrome blocks a top-level data: navigation, so set the document directly
    const { frameTree } = await this.send('Page.getFrameTree');
    await this.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
    await sleep(350);
  }
  async seek(t) {
    // the page owns its own animation, we just tell it what time it is, so every
    // frame is deterministic rather than whatever the clock happened to be
    await this.send('Runtime.evaluate', { expression: `window.seek && window.seek(${t});`, awaitPromise: false });
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  close() { try { this.ws.close(); } catch {} 
    httpJson(`http://127.0.0.1:${PORT}/json/close/${this.target}`).catch(() => {}); }
}

// render an HTML page to a numbered PNG sequence
async function sequence(html, { W, H, dur, fps = 30, outDir, prefix = 'f' }) {
  fs.mkdirSync(outDir, { recursive: true });
  const f = await Frame.open(W, H);
  const files = [];
  try {
    await f.load(html);
    const n = Math.max(1, Math.round(dur * fps));
    for (let i = 0; i < n; i++) {
      await f.seek(i / fps);
      const file = path.join(outDir, `${prefix}${String(i).padStart(5, '0')}.png`);
      await f.shot(file);
      files.push(file);
    }
  } finally { f.close(); }
  return { files, fps };
}

module.exports = { sequence, Frame, PORT };
