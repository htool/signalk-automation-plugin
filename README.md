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
| Automations git / YAML directory | Folder with `*.yaml` at the top level. Git repo → commit list in the webapp |
| Allowed scripts directory | Only relative `run.file` paths under this dir |
| Decision records to keep | Ring buffer per automation |
| Script timeout | Seconds |

Do not paste automations into the admin form. Runtime state is `~/.signalk/plugin-config-data/signalk-automation-plugin/` (`state.json`, `live/`, `traces/`).

## Example

See `examples/automations.yaml`. Copy or point `automationsDir` at a repo of your own; bundled examples are `enabled: false`.

```yaml
helpers:
  starlink_manual:
    type: boolean
    default: false
    on_start: restore   # survive reboot
    latch_on_external_put: electrical.switches.starlink.state

automations:
  - id: start_anchorwatch
    trigger:
      - path: winches.windlass.rode
        above: 2
        unit: m
        for: 10s
    action:
      - put: navigation.anchor.watch
        value: true
```

Script action:

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
