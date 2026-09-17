'use strict';
// Birch as an MCP server over stdio, so Claude Code can cut a clip by asking.
// It talks to the same local server the browser app uses, and starts it if needed.
const fs = require('fs');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOOLS = [
  {
    name: 'birch_setup',
    description: 'Check whether Birch is set up on this Mac. If it is not, opens the setup page in the browser, where the user finishes it.',
    inputSchema: { type: 'object', properties: { open: { type: 'boolean', description: 'open the setup page if something is missing (default true)' } } },
  },
  {
    name: 'birch_cut',
    description: 'Cut a talking video into a finished reel: removes pauses and retakes, finds the speaker, adds a name card, big-word pops, captions and music, and renders an mp4. Takes a few minutes for a one minute clip. Returns the output path.',
    inputSchema: {
      type: 'object', required: ['file'],
      properties: {
        file: { type: 'string', description: 'absolute path to the video on this Mac' },
        aspect: { type: 'string', enum: ['9:16', '1:1', '16:9'], description: 'default 9:16' },
        format: { type: 'string', description: 'auto (Birch picks, default), none, or one of: pops, split, list, shrink, plate, scrawl, reply, story, jolt' },
        captions: { type: 'string', description: 'auto (match the format, default), none, minimal, clean, pop, plate, seam, scrawl, story' },
        music: { type: 'string', enum: ['speech', 'street', 'drive', 'none'], description: 'default speech' },
        name: { type: 'string', description: 'speaker name for the name card, if Birch should not work it out' },
        role: { type: 'string', description: 'one line under the name' },
        wait: { type: 'boolean', description: 'wait for the render (default true). false returns the project id right after import' },
      },
    },
  },
  {
    name: 'birch_status',
    description: 'Where a Birch project is up to: transcription, the plan Birch read from the clip, and the latest render.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
  {
    name: 'birch_open',
    description: 'Open Birch in the browser, optionally on one project, so the user can review and change the edit.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  },
  {
    name: 'birch_projects',
    description: 'List recent Birch projects.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function serve(ctx) {
  const { start, request, BASE, openUrl } = ctx;
  const setupUrl = BASE + '/birch';

  async function ensureReady(open = true) {
    await start();
    const st = (await request('GET', '/api/birch/setup')).json;
    if (!st.ready && open) openUrl(setupUrl);
    return st;
  }
  async function waitTask(project, type, since, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const ts = (await request('GET', '/api/tasks')).json || [];
      const t = ts.filter(x => x.project === project && x.type === type && x.started >= since - 2000).pop();
      if (t && (t.stage === 'done' || t.stage === 'error')) return t;
      await sleep(2000);
    }
    return null;
  }

  const handlers = {
    async birch_setup({ open = true }) {
      const st = await ensureReady(open);
      const s = st.steps;
      const lines = [
        `ready: ${st.ready ? 'yes' : 'no'}`,
        `GitHub star and follow: ${s.github.done ? 'done (' + s.github.login + ')' : 'missing'}`,
        `ffmpeg and whisper: ${s.tools.done ? 'done' : 'missing'}`,
        `speech model: ${s.model.done ? 'done' : 'missing'}`,
        `face tools: ${s.vision.done ? 'done' : 'missing'}`,
        `Claude Code: ${s.claude.done ? 'found' : 'not found (optional)'}`,
      ];
      if (!st.ready) lines.push(`The setup page is open at ${setupUrl}. Ask the user to finish it there.`);
      return lines.join('\n');
    },

    async birch_cut(a) {
      const file = path.resolve(String(a.file || ''));
      if (!fs.existsSync(file)) throw new Error('No file at ' + file);
      const st = await ensureReady(true);
      if (!st.ready) throw new Error(`Birch isn't set up yet. The setup page is open at ${setupUrl}; ask the user to finish it, then try again.`);

      const imp = await request('POST', '/api/importPath', { file });
      if (!imp.json || !imp.json.id) throw new Error((imp.json && imp.json.error) || 'Birch could not read that file.');
      const id = imp.json.id;
      for (;;) {
        const j = (await request('GET', '/api/job?id=' + id)).json || {};
        if (j.stage === 'error') throw new Error(j.error || 'transcription failed');
        if (j.stage === 'done') break;
        await sleep(1500);
      }
      if (a.wait === false) return `Imported as ${id}. Birch is reading it now. Check with birch_status, or open ${BASE}/birch?project=${id}`;

      // the read: who is talking, which format, which words
      let direction = null;
      for (let i = 0; i < 150; i++) {
        const d = (await request('GET', '/api/birch/direction?id=' + id)).json || {};
        if (d.direction) { direction = d.direction; break; }
        if (!d.running && d.error) break;
        await sleep(2000);
      }
      const project = (await request('GET', '/api/project?id=' + id)).json;
      const words = project.words || [];
      const firstKept = Math.max(0, words.findIndex(w => w.keep !== false));

      const beds = (await request('GET', '/api/birch/beds')).json || [];
      const bed = beds.find(b => b.name === (a.music || 'speech'));
      const format = !a.format || a.format === 'auto' ? (direction && direction.format) : (a.format === 'none' ? null : a.format);
      const capStyle = a.captions && a.captions !== 'auto' ? a.captions : (format ? null : 'minimal');
      const settings = base => {
        const s = { ...(base || {}), styleChosen: true, aspect: a.aspect || '9:16', gapMax: (base && base.gapMax) ?? 0.5, normalize: true,
          sound: { bed: a.music === 'none' ? null : (bed ? bed.file : null), bedGain: 0.32, sfx: true } };
        if (capStyle) { s.captions = capStyle !== 'none'; s.capStyle = capStyle === 'none' ? 'minimal' : capStyle; }
        return s;
      };
      await request('POST', '/api/settings', { id, settings: settings(project.settings) });

      const name = a.name || (direction && direction.speaker.name) || '';
      const role = a.role || (a.name ? '' : (direction && direction.speaker.role)) || '';
      const moments = ((direction && direction.moments) || []).filter(m => words[m.word] && words[m.word].keep !== false);
      if (format) {
        const since = Date.now();
        const r = await request('POST', '/api/template/apply', { id, template: format, planned: !!(name || moments.length), settingsOnly: format === 'pops',
          extra: 'The editor already placed a name card and big word pops. Do not add pops or titles of your own.' });
        if (r.json && r.json.task) await waitTask(id, 'edit', since, 240000);
      }
      await request('POST', '/api/birch/clear', { id });
      if (name) await request('POST', '/api/birch/namecard', { id, word: firstKept, seconds: 3, name, role });
      for (const m of moments) await request('POST', '/api/pop', { id, word: m.word, seconds: 1.2, by: 'birch', pop: { kind: 'pop', text: m.text, look: ['plate', 'pops'].includes(format) ? 'block' : ((direction && direction.wordLook) || 'clean') } });

      const inserts = ((direction && direction.inserts) || []).filter(x => words[x.word] && words[x.word].keep !== false);
      const made = [];
      for (const ins of inserts) {
        const r = await request('POST', '/api/birch/insert', { id, insert: ins }, 300000);
        if (r.json && r.json.ok) made.push(ins.type + ': ' + (ins.term || ins.value || ins.text || ins.url));
      }
      const fresh = (await request('GET', '/api/project?id=' + id)).json;
      const since = Date.now();
      await request('POST', '/api/render', { id, settings: settings(fresh.settings) });
      const t = await waitTask(id, 'export', since, 20 * 60000);
      if (!t) return `Still rendering. Check with birch_status id ${id}.`;
      if (t.stage === 'error') throw new Error('Render failed: ' + t.note);
      const out = path.join(ctx.root || path.join(__dirname, '..'), 'projects', id, 'final.mp4');
      return [
        `Done: ${out}`,
        `speaker: ${name ? name + (role ? ', ' + role : '') : 'no name in the clip, so no name card'}${direction && direction.speaker.how && !a.name ? ' (' + direction.speaker.how + ')' : ''}`,
        `format: ${format || 'just captions'}`,
        `on screen: ${moments.map(m => m.text).join(', ') || 'nothing extra'}`,
        `animated inserts: ${made.join('; ') || 'none'}`,
        `review: ${t.note}`,
        `open to change anything: ${BASE}/birch?project=${id}`,
      ].join('\n');
    },

    async birch_status({ id }) {
      await start();
      const job = (await request('GET', '/api/job?id=' + encodeURIComponent(id))).json || {};
      const d = (await request('GET', '/api/birch/direction?id=' + encodeURIComponent(id))).json || {};
      const ts = ((await request('GET', '/api/tasks')).json || []).filter(t => t.project === id);
      const exp = ts.filter(t => t.type === 'export').pop();
      return JSON.stringify({ transcription: job.stage, reading: d.running ? 'running' : d.direction ? 'done' : d.error || 'not started',
        direction: d.direction, render: exp ? { stage: exp.stage, pct: exp.pct, note: exp.note } : null, url: `${BASE}/birch?project=${id}` }, null, 2);
    },

    async birch_open({ id }) {
      await start();
      const url = id ? `${BASE}/birch?project=${encodeURIComponent(id)}` : `${BASE}/birch`;
      openUrl(url);
      return 'Opened ' + url;
    },

    async birch_projects() {
      await start();
      const list = (await request('GET', '/api/projects')).json || [];
      return list.slice(0, 20).map(p => `${p.id}  ${p.name || 'untitled'}  ${Math.round(p.duration || 0)}s`).join('\n') || 'no projects yet';
    },
  };

  const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line) handle(line);
    }
  });
  process.stdin.on('end', () => process.exit(0));

  async function handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    if (id === undefined) return;                       // notifications need no answer
    try {
      if (method === 'initialize') {
        return send({ jsonrpc: '2.0', id, result: {
          protocolVersion: (params && params.protocolVersion) || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'birch', version: require('../package.json').version },
          instructions: 'Birch cuts talking videos into reels on this Mac. Call birch_setup first if unsure it is installed. birch_cut does the whole edit and returns the mp4 path.',
        } });
      }
      if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
      if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      if (method === 'tools/call') {
        const h = handlers[params.name];
        if (!h) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool ' + params.name } });
        try {
          const text = await h(params.arguments || {});
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
        } catch (e) {
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e.message }], isError: true } });
        }
      }
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
  }
}

module.exports = { serve, TOOLS };
