# Credits

Birch is MIT licensed. It uses these, and installs or downloads them on your machine
rather than shipping copies:

- ffmpeg, for reading and writing video. LGPL or GPL depending on the build you have.
- whisper.cpp, for turning speech into words. MIT. Built from source on Linux,
  installed with Homebrew on macOS.
- faster-whisper, used on Windows where whisper.cpp needs a compiler. MIT.
- The whisper small.en model, from OpenAI. MIT.
- Apple's Vision framework on macOS, and MediaPipe elsewhere, for faces and lips.
  MediaPipe is Apache 2.0, and its model bundles are downloaded on first use.
- HyperFrames, which renders the animated inserts. Fetched with npx when you use them.
- GSAP, loaded from a CDN inside those animation templates.
- Pillow, OpenCV and NumPy, for drawing captions and reading frames.

The sound effects in `sound/sfx` were generated from scratch with ffmpeg, so they are
covered by this repository's licence. Birch ships no music: the Sound step reads
whatever `.wav` files you put in `beds/`.

Photos in the picture insert come from Wikimedia Commons, only when the file is on
Commons under a free licence, and the author and licence are printed on the card.
Anything a picture shows may still be someone's trademark, so think before you post.
