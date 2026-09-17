# Features

Ordered slices. **Tests on every feature slice.** Docs-only slices do not change `plugin/index.js`.

## Done

- YAML load (`helpers`, `zones`, `automations`); duplicate ids error
- Helper `on_start` restore / default / none + persist
- Engine: path above/below/is, zone, choose, schedule cron, PUT/helper/notify/delay/run; trigger `round:`
- Trigger list is any (path/helper/schedule); conditions stay all
- Script sandbox + stderr = fail
- Plugin lifecycle; SK 2.x GET vs `/plugins/` writes
- Webapp: left automations + helpers, right coloured YAML for the selection, git commit pulldown with diff + reset
- Auto-publish `release.yml` (first npm 0.0.1 still needs a logged-in publish)
- Git-live: archive only the `automationsDir` subtree; invalid YAML keeps previous `live/`
- Reload automations: `POST /reload` copies working-tree YAML into `live/` (validate first), re-subscribes paths; webapp button
- Webapp login for `/plugins/` writes (Run/Reload/on); Run + Git left-aligned; write routes registered `readwrite` when SK `router.access` exists
- UI **On** / **Verbose** live in `state.json` (YAML has no `enabled:`); survive webapp reload and SK restart once the POST succeeds
- `putSelfPath` treats SK PUT `statusCode >= 400` as failure (200 reply object is success)
- Site YAML lives in a separate `automationsDir` git (on/off in plugin-data, not YAML)
- Webapp run log polls `lastRun` (~1.5s) and refreshes traces when an automation has run

## Next

1. **Kit confirmation** — this file + architecture + ADRs + known-gaps + skill (docs only). Show Hans; wait.
2. **Site YAML** — lives in the configured `automationsDir` git, not this plugin. On/off is the webapp switch (plugin-data). Anchor watch is `signalk-anchoralarm-plugin`, not YAML.
