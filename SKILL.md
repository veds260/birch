---
name: birch
description: Cut a talking-head video into a finished reel on this Mac with Birch. Use when someone asks to cut, tighten, caption or turn a clip into a reel or short, add a name card, or reframe a wide video to vertical.
---

# Birch

Birch is a local server with a `birch` command. If the Birch MCP tools (`birch_cut`, `birch_setup`) are available, use those: `birch_cut` does everything below in one call. Otherwise talk to the server over HTTP on 127.0.0.1 as described here.

## 1. Make sure it's running and set up

```sh
command -v birch >/dev/null || curl -fsSL https://birch.video/install | sh
birch doctor
```

If doctor lists anything missing, run `birch` and ask the user to finish the setup page it opens. Imports and renders are refused until setup is done.

## 2. Import the clip

```sh
curl -s -X POST http://127.0.0.1:8796/api/importPath \
  -H 'content-type: application/json' -d '{"file":"/Users/me/Movies/talk.mov"}'
# → {"id":"..."}
```

Poll `GET /api/job?id=ID` until `stage` is `done`. That covers transcription, alignment and the automatic cut of pauses, retakes and filler.

## 3. Read the plan

Birch starts reading the clip on import. Poll `GET /api/birch/direction?id=ID` until `running` is false. You get:

- `direction.speaker`: name, role, and `how` it was found. The name is empty when the clip doesn't say it, so ask the user rather than guessing.
- `direction.format`: the suggested format key from `refs/templates.json`
- `direction.moments`: word indexes with one or two words to show

If `error` mentions the claude CLI, skip the plan and just render captions.

## 4. Apply and render

Order matters, because overlays are drawn for the frame shape that's saved.

1. `POST /api/settings` with `{id, settings: {aspect: "9:16", captions: true, capStyle: "minimal", gapMax: 0.5, normalize: true}}`
2. Optional format: `POST /api/template/apply` with `{id, template: KEY, planned: true}`. If it returns a `task`, wait for that task in `GET /api/tasks` to finish.
3. `POST /api/birch/clear` with `{id}`, then add the plan:
   - name card: `POST /api/birch/namecard` with `{id, word, seconds: 3, name, role}`
   - big word: `POST /api/pop` with `{id, word, seconds: 1.2, by: "birch", pop: {kind: "pop", text}}`
4. Read the project back with `GET /api/project?id=ID`, then `POST /api/render` with `{id, settings: project.settings}`.
5. Wait for the `export` task in `GET /api/tasks` to finish. The file is at `~/.birch/projects/ID/final.mp4`, and the task note lists anything the automatic review flagged.

## Notes

- Word cuts can be changed with `POST /api/keep` and `{id, keeps: {"12": false}}`.
- Caption styles are minimal, clean, pop, plate, seam, scrawl, story, single, karaoke, outline and box.
- Don't delete anything in `projects/` without asking. Those folders are the user's footage.
