'use strict';
// Where the command line tools live. Homebrew puts them in a different place on
// Intel and Apple Silicon, so check both before falling back to the PATH.
const fs = require('fs');
const find = name => ['/opt/homebrew/bin/' + name, '/usr/local/bin/' + name].find(p => fs.existsSync(p)) || name;
module.exports = { find, FFMPEG: find('ffmpeg'), FFPROBE: find('ffprobe'), WHISPER: find('whisper-cli') };
