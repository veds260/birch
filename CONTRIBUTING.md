# Contributing

Pull requests are welcome, especially fixes for things that break on a machine I
cannot test on.

Getting set up is the same as using it: `./install.sh` on macOS or Linux,
`install.ps1` on Windows, then `./start.sh`. Everything runs locally and there are no
dependencies to install for the server itself, so a clone plus Node is enough to poke
at it.

Before you open a pull request:

- Run it on a real clip and watch the export. There are no unit tests worth the name,
  the render is the test.
- Keep the server dependency free. The whole thing is Node with no packages, and that
  is worth protecting.
- Match the surrounding style: plain code, comments that say why rather than what.
- The workflows in `.github/workflows` install Birch from scratch on Ubuntu and
  Windows and cut a clip. If you change how it installs, run those.

If you are adding something that talks to a paid service, it has to be optional and
off by default. Birch is meant to run on what people already have.
