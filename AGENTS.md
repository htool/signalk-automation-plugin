# Agents

This plugin: YAML automations for Signal K (helpers, path/schedule triggers, PUT/notify/script actions, git-live snapshot). It does not run Node-RED or speak Home Assistant YAML 1:1.

Follow [Signal K AI approach](https://github.com/htool/signalk-ai-approach). Do not copy those pages into this tree. Do not load `signalk-server` `src/` unless a client contract is undefined.

## Fill this file

This index is a **draft** from the first scaffold. Show it to the human. **Wait for confirmation** before treating it as law. Then add `docs/architecture.md`, `docs/adr/`, `docs/features.md`, `docs/known-gaps.md`, `skills/` the same way.

Keep this file an index. Detail lives in `docs/` and skills, loaded on demand.

## Read first

1. [README.md](README.md) — scope card (job, in, out)
2. Plugin source under `plugin/` and `lib/` — never import `signalk-server` `src/`
3. Tests under `test/` — every behaviour slice needs one

## Overlap

| Repo | Role |
| --- | --- |
| This plugin | YAML engine, helpers, traces, git-live, webapp |
| `signalk-rules` | JSON rules + webapp editor (not this tree) |
| `signalk-anchoralarm-plugin` | Anchor watch implementation; this plugin only PUTs |
| `signalk-starlink` / charger / BMS plugins | Device paths this YAML refers to |
| `signalk-trigger` | IF without THEN; do not extend it here |

If a slice cannot be done from these files, fix the docs. Do not grow the prompt.

## Rules

- Automations live in YAML files / git, never in plugin options (Save would wipe them).
- Helper `on_start` is `restore` \| `default` \| `none` only.
- `run:` scripts: relative to `scriptsDir`, stdout = value, **stderr = fail**.
- `registerWithRouter` and `signalKApiRoutes` stay on the plugin object (callable before `start`). SK 2.x: GET on `/signalk/v1/api/signalk-automation-plugin/`, writes on `/plugins/`.
- Do not bump `package.json` version in a feature commit; release.yml owns publish bumps.
- `npm test` must stay a real suite. Feature work is not done until a test would catch a regression.
