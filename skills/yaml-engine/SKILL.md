# YAML engine

## Do

- Keep automations in YAML / git / `live/`, never in plugin options.
- Helper `on_start`: `restore` | `default` | `none` only.
- Trigger `round:` is a positive step (volts, SOC fraction, or degrees). It only gates retriggering; conditions still see the real value.
- `run.file` relative to `scriptsDir`; treat stderr as fail.
- Add a test with every behaviour slice (`npm test`).
- SK 2.x: GET via `signalKApiRoutes`, writes via `registerWithRouter`.
- After boatnet code change: copy/pull `~/src/signalk-automation-plugin`, linker if needed, `docker compose restart signalk`. Do not PUT empty plugin config.
- Boatnet YAML lives in `git@github.com:htool/boatnet_automations.git` (`/home/pi/src/boatnet_automations`). On/off is the webapp switch in plugin-data, not a YAML `enabled:` key.

## Do not

- Node-RED, HA Jinja, or arbitrary `sh -c` strings.
- Bump `package.json` version in a feature commit.
- Load `signalk-server` `src/` unless a client contract is undefined.
- Enable example automations on the boat without Hans saying the live paths are right.
