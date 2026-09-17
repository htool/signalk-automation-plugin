# ADR 002 — Helper on_start

- Status: accepted, implemented
- Date: 2026-09-14

## Decision

Each helper has `on_start`: `restore` | `default` | `none`.

| Value | Start | Persist in `state.json` |
| --- | --- | --- |
| `restore` | last saved value, else YAML `default` | yes |
| `default` | always YAML `default` | no |
| `none` | unset until set | no |

## Why

Hans’s HA-helper behaviour: survive reboot, reset to default every start, or do nothing. Not three separate YAML keys.

## Note

`latch_on_external_put` can set a boolean helper when another path changes and `$source` is not this plugin. Latch only on a **changed** on/off (not the first seed of the path, not 0 vs false). Otherwise a replayed switch state at start looks like a manual override.
