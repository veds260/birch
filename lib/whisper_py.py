"""Speech to words, without a C++ compiler.

whisper.cpp is what Birch uses everywhere it can be installed. On Windows it has to
be built with MSVC, which somebody who just wants to cut a video does not have, so
the same job runs here through faster-whisper in Birch's own python environment.

This takes the flags whisper-cli takes and writes the same JSON, so lib/media.js and
lib/align.js call it without knowing the difference:

    python whisper_py.py -m MODEL -f FILE [-f FILE ...] -oj -ojf -ml 1 -sow -of BASE

With -of it writes BASE.json, otherwise FILE.json next to each input. Progress goes
to stderr as "progress = 42%", which is the line media.js watches for.

    python whisper_py.py --fetch DIR       download the model into DIR and stop
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# small.en, converted for faster-whisper. Same family as ggml-small.en.bin.
REPO = "Systran/faster-whisper-small.en"
LOCAL = os.path.join(ROOT, "models", "faster-whisper-small.en")


def model_dir():
    env = os.environ.get("BIRCH_WHISPER_MODEL")
    if env and os.path.isdir(env):
        return env
    if os.path.isfile(os.path.join(LOCAL, "model.bin")):
        return LOCAL
    return REPO          # faster-whisper downloads it on first use


def fetch(target=None):
    from huggingface_hub import snapshot_download
    target = target or LOCAL
    os.makedirs(target, exist_ok=True)
    snapshot_download(repo_id=REPO, local_dir=target,
                      allow_patterns=["*.bin", "*.json", "*.txt"])
    print(target)


def stamp(ms):
    ms = max(0, int(ms))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)


def piece(text, start, end):
    a, b = int(round(start * 1000)), int(round(end * 1000))
    return {"timestamps": {"from": stamp(a), "to": stamp(b)},
            "offsets": {"from": a, "to": b},
            "text": text,
            "tokens": []}


def parse(argv):
    files, out, threads = [], None, 0
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-f", "--file"):
            i += 1; files.append(argv[i])
        elif a in ("-of", "--output-file"):
            i += 1; out = argv[i]
        elif a in ("-t", "--threads"):
            i += 1
            try: threads = int(argv[i])
            except ValueError: threads = 0
        elif a in ("-m", "--model", "-ml", "--max-len", "-wt", "--word-thold",
                   "-bs", "--beam-size", "-bo", "--best-of", "-l", "--language"):
            i += 1                      # taken and ignored, the python side has its own
        i += 1
    return files, out, threads


def main():
    argv = sys.argv[1:]
    if argv and argv[0] == "--fetch":
        return fetch(argv[1] if len(argv) > 1 else None)
    files, out, threads = parse(argv)
    if not files:
        sys.stderr.write("whisper_py: nothing to transcribe\n")
        return 1

    from faster_whisper import WhisperModel
    model = WhisperModel(model_dir(), device="cpu", compute_type="int8",
                         cpu_threads=threads or 0,
                         download_root=os.path.join(ROOT, "models"))

    done = 0.0
    total = 0.0
    for f in files:
        try: total += probe_seconds(f)
        except Exception: total += 1.0

    for f in files:
        segments, info = model.transcribe(
            f, language="en", beam_size=5, word_timestamps=True,
            condition_on_previous_text=False, vad_filter=False)
        words = []
        length = info.duration or 1.0
        last = -1
        for seg in segments:
            for w in (seg.words or []):
                text = w.word
                if not text.strip():
                    continue
                words.append(piece(text, w.start, w.end))
            pc = int(min(100.0, (done + min(seg.end, length)) / max(total, 0.01) * 100))
            if pc != last:
                last = pc
                sys.stderr.write("progress = %d%%\n" % pc)
                sys.stderr.flush()
        done += length
        base = out if out else f
        with open(base + ".json", "w", encoding="utf-8") as fh:
            json.dump({"model": {"type": "faster-whisper small.en"},
                       "params": {"model": model_dir(), "language": "en"},
                       "transcription": words}, fh)
    sys.stderr.write("progress = 100%\n")
    return 0


def probe_seconds(path):
    """Length of a 16 kHz mono wav from its header, so nothing else has to run."""
    import wave
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


if __name__ == "__main__":
    sys.exit(main() or 0)
