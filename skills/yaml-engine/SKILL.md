# YAML engine

## Do

- Keep automations in YAML / git / `live/`, never in plugin options.
- Helper `on_start`: `restore` | `default` | `none` only.
- Trigger `round:` is a positive step (volts, SOC fraction, or degrees). It only gates retriggering; conditions still see the real value.
- `run.file` relative to `scriptsDir`; treat stderr as fail.
- Add a test with every behaviour slice (`npm test`).
- SK 2.x: GET via `signalKApiRoutes`, writes via `registerWithRouter`.
- Site YAML and scripts live in `automationsDir` / `scriptsDir`, never in this plugin. `examples/` is fictional.
- `mode` is `parallel` (default), `restart`, or `single`. Action `if:` skips that step when clauses fail.

## Do not

- Node-RED, HA Jinja, or arbitrary `sh -c` strings.
- Bump `package.json` version in a feature commit.
- Load `signalk-server` `src/` unless a client contract is undefined.
- Copy a vessel’s helpers, zones, device paths, or coordinates into this plugin.
