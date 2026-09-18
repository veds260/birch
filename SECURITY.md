# Reporting a problem

Birch runs on your own machine and listens only on 127.0.0.1, so most problems are
local. If you find something that lets another program, a web page or another person
on your network reach Birch or your files, please report it privately.

Use GitHub's private reporting on this repository: Security, then Report a
vulnerability. Please include what you did, what happened, and the version or commit.

I work on this alone, so expect a first reply within a week. Please give me a chance
to fix it before writing about it publicly.

Things that are known and deliberate:

- Birch serves an unauthenticated API on 127.0.0.1. Any program running as you can
  reach it. Requests carrying another site's origin are refused, so a web page in
  your browser cannot drive it.
- `birch cut` and the API can read video files anywhere under your home folder.
- The planning step sends that clip's transcript and three frames to the AI CLI you
  signed in to, and setting `BIRCH_NO_CLAUDE=1` turns that off.
