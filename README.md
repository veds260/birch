# Birch

<img src="public/birch/hero-cut.webp" width="180" align="right" alt="Birch the beaver">

Birch cuts your talking videos into reels ([birch.video](https://birch.video)). Drop in a clip and he takes out the pauses and retakes, works out who's talking, puts their name on screen, throws the words they lean on up in big type and lays music underneath. You get an mp4.

It runs on your Mac. Transcription is whisper.cpp, faces come from Apple's Vision framework and rendering is ffmpeg. The part that plans the edit goes through Claude Code, so it uses the Claude plan you already have. No API keys, no uploads.

## Install

```sh
curl -fsSL https://birch.video/install | sh
```

That puts Birch in `~/.birch`, gives you a `birch` command and opens the setup page in your browser. The page installs ffmpeg and whisper, downloads the speech model and builds the face tools, each with a button. It also asks you to star this repo and follow [@veds260](https://github.com/veds260) before it unlocks.

After that:

```sh
birch                  # opens Birch
birch cut talk.mov     # starts a clip and opens it
birch doctor           # what's set up and what isn't
birch update           # pulls the latest version
```

You need macOS with [Homebrew](https://brew.sh). For names and the auto plan you also need [Claude Code](https://docs.claude.com/en/docs/claude-code/setup). Without it Birch still cuts, captions and adds music.

## MCP

Birch ships an MCP server. The setup page has a button for this, or run:

```sh
claude mcp add --scope user birch -- birch mcp
```

Then tell Claude something like "cut ~/Movies/talk.mov into a vertical reel" and it calls `birch_cut`, which runs the whole edit and hands back the file path. There's also `birch_setup`, `birch_status`, `birch_open` and `birch_projects` for checking on things.

## Features

- **Cuts on the audio, not the transcript.** Whisper's word times slip by about a word after every pause, so cutting on them removes the wrong syllable. Birch transcribes each stretch of speech on its own to find out which words really sit where, then lands every cut in the quietest 30ms nearby. A pause shrinks to a breath, a little longer at the end of a sentence.
- **Drops retakes and stumbles.** Say a line more than once and it keeps the last take. A stumble like "that that" loses one of them.
- **Follows whoever is talking.** It reads lip movement against the audio, so in a wide shot it finds the person at the podium and not the biggest face in the crowd. When a 16:9 clip becomes 9:16 the crop stays on them, and captions move out of their way.
- **Knows who's talking when the clip tells it.** A spoken intro, a name on screen or the file name is enough. It never guesses from a face.
- **Adds animated inserts.** When the speaker names a company, person or place, a real photo from Wikipedia slides in with its credit. A number they say counts up, a website they mention shows up as a live screenshot in a browser window, and the main idea can land as a kinetic headline. They're HTML animations rendered on your Mac with [HyperFrames](https://github.com/heygen-com/hyperframes), and the templates are in `motion/` if you want to change them.
- **Picks a format.** Big word pops, split screen, numbered list, picture in picture, loud captions, handwritten, comment reply, story, or one big jolt. Birch marks the one it would use and you can change it.

## Code layout

```
bin/birch          the command, and the MCP server entry
server.js          the local server
lib/align.js       re-seats whisper's words onto the real speech
lib/media.js       cut ranges, captions, overlays, the ffmpeg render
lib/talkers.js     finds the speaker from mouth movement
lib/director.js    asks Claude who is talking and what goes on screen
lib/setup.js       the setup page's checks and installs
lib/mcp.js         the MCP tools
lib/motion.js      renders the animated inserts
motion/            the insert templates, plain HTML and GSAP
tools/*.swift      Vision passes: faces and text, lips, person mask
public/birch/      the app
site/              the landing page
```

Projects live in `~/.birch/projects`, one folder per clip, and never leave your machine.

## Options

- `TWITTERAPI_KEY` turns a spoken @handle into a live tweet card.
- `BIRCH_NO_CLAUDE=1` stops Birch reading clips automatically on import.
- `BIRCH_PORT` changes the port from 8796.

## License

MIT
