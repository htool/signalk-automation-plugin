# signalk-automation-plugin

YAML automations for [Signal K](https://signalk.org), in the spirit of Home Assistant: files you can git, helpers with restart behaviour, and a small webapp for last-run / decision records.

Not Node-RED. Not a Home Assistant YAML clone. Actions are Signal K PUTs, helper writes, notifications, delays, and optional scripts.

## In

- YAML in an automations directory (preferably a git repo). Live snapshot lives in plugin data, not plugin options.
- Helpers (`boolean` / `number` / `string` / `select`) with `on_start`:
  - `restore` — survive reboot (save in plugin data, restore on start)
  - `default` — set `default` on every start
  - `none` — do nothing on start
- Path triggers, `choose`, zones, cron `schedule`
- Trigger `round:` quantizes numbers (and lat/lon) so 230.1 V and 230.4 V do not both fire
- Actions: `put`, `helper`, `notify`, `delay`, `run`
- `run:` executes a file under configured `scriptsDir`. **stdout is the value; any stderr is fail**
- Webapp: per-automation on/off, last result, last N decision records, live YAML, activate another git commit

## Out

- Node-RED flows
- HA templates / Jinja
- Arbitrary shell strings (only files under `scriptsDir`, no `..`)

## Plugin config

| Option | Meaning |
| --- | --- |
| Automations git / YAML directory | Folder with `*.yaml` at the top level. Git repo (or a subdir of one) → commit list in the webapp; “make live” archives only this folder |
| Allowed scripts directory | Only relative `run.file` paths under this dir |
| Decision records to keep | Ring buffer per automation |
| Script timeout | Seconds |

Do not paste automations into the admin form. Runtime state is `~/.signalk/plugin-config-data/signalk-automation-plugin/` (`state.json`, `live/`, `traces/`).

## Example

See `examples/automations.yaml`. Boatnet live YAML is `git@github.com:htool/boatnet_automations.git` (`automationsDir` on the Pi). On/off and Verbose are plugin-data switches, not YAML keys.

```yaml
helpers:
  starlink_manual:
    type: boolean
    default: false
    on_start: restore   # survive reboot
    latch_on_external_put: electrical.switches.starlink.state

automations:
  - id: starlink_standby
    trigger:
      - schedule: "0 4 * * *"
    condition:
      - zone: home_harbour
      - helper: starlink_manual
        is: false
    action:
      - put: electrical.switches.starlink.state
        value: true
      - delay: 15m
      - put: electrical.switches.starlink.state
        value: false
```

```yaml
- path: electrical.switches.dolphinCharger.voltage
  round: 1          # nearest volt; 230.1 and 230.4 do not both fire
```

```yaml
- run:
    file: check-harbour.py
  as: harbour_ok          # optional helper id to store stdout
```

## Webapp

Webapps → **Automations**. Reads go through `/signalk/v1/api/signalk-automation-plugin/` (SK 2.x). Writes (on/off, make live, helper reset) use `/plugins/signalk-automation-plugin/` and need an admin session.

## Auto-publish

GitHub Action `.github/workflows/release.yml` patch-bumps and publishes to npm at most once per UTC day when `plugin/`, `lib/`, or `public/` changed. Trusted Publisher (OIDC), workflow filename **must stay** `release.yml`.

The first npm version cannot use OIDC. Publish `0.0.1` once from a logged-in machine, then add the trusted publisher for `htool/signalk-automation-plugin` / `release.yml`.
