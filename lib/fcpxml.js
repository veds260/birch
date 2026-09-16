'use strict';
// Hand the cut to a real editor. The rough cut is the boring part and the tool is
// good at it; colour, sound and taste are better done in Resolve or Premiere.
// FCPXML is the one interchange all three read.
const path = require('path');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// FCPXML wants rational time in seconds, on a common timebase
function rt(sec, fps) {
  const d = Math.round(fps * 100);
  return `${Math.round(sec * d)}/${d}s`;
}

function build({ name, src, fps = 30, width = 1920, height = 1080, ranges, markers = [] }) {
  const f = Math.round(fps) || 30;
  const total = ranges.reduce((s, r) => s + (r.end - r.start), 0);
  const fmtId = 'r1', assetId = 'r2';
  let off = 0;
  const clips = ranges.map((r, i) => {
    const dur = r.end - r.start;
    const el = `        <asset-clip name="${esc(name)} ${i + 1}" ref="${assetId}" offset="${rt(off, f)}" ` +
      `start="${rt(r.start, f)}" duration="${rt(dur, f)}" format="${fmtId}" tcFormat="NDF" audioRole="dialogue"/>`;
    off += dur;
    return el;
  }).join('\n');
  const marks = markers.map(m =>
    `        <marker start="${rt(m.at, f)}" duration="${rt(0.1, f)}" value="${esc(m.label)}"/>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="${fmtId}" name="FFVideoFormat" frameDuration="1/${f}s" width="${width}" height="${height}"/>
    <asset id="${assetId}" name="${esc(name)}" start="0s" hasVideo="1" hasAudio="1" format="${fmtId}" audioSources="1" audioChannels="2">
      <media-rep kind="original-media" src="file://${encodeURI(src)}"/>
    </asset>
  </resources>
  <library>
    <event name="${esc(name)}">
      <project name="${esc(name)} cut">
        <sequence format="${fmtId}" duration="${rt(total, f)}" tcStart="0s" tcFormat="NDF">
          <spine>
${clips}
${marks}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}
module.exports = { build };
