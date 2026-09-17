# Architecture

YAML automations for Signal K. Engine in `lib/`, SK glue in `plugin/index.js`, dashboard in `public/`.

## Runtime

On `start`, `Runtime.load()` reads YAML from plugin-data `live/` if present, else `automationsDir`. Helpers are initialised from YAML `on_start` plus `state.json`. Path deltas go through `handlePathChange`; cron triggers via a 15s tick. A trigger list is **any** (path, helper, or schedule); conditions stay **all**. Trigger `round:` quantizes the changed value (nearest multiple; lat/lon for GPS) and skips the run when the quantized value did not change.

**Make live** (`activateCommit`) `git archive`s the commit, but only the `automationsDir` tree (so a plugin checkout with YAML in `examples/` does not dump `plugin/` / `lib/` into `live/`). Incoming YAML is validated **before** swapping `live/`; any error leaves the previous snapshot on disk.

**Reload automations** (`reloadWorkingTree`) copies `*.yaml` from `automationsDir` into `live/` the same way (validate first, keep previous on error), then the plugin unsubscribes and re-subscribes `collectPaths`. Plugin disable/enable re-runs `load()` but still prefers existing `live/` over the working tree. Full Signal K restart is only needed after plugin JS changes (`require` cache).

Actions: `put` (`putSelfPath` or `handleMessage`), `helper`, `notify`, `delay`, `run` (file under `scriptsDir` only). Decision records go to `traces/<id>.json` (newest first). Last result + helper values + per-automation on/off and Verbose live in `state.json` under `app.getDataDirPath()`. Default edge is `every` so choose policies re-evaluate on each matching path change. Verbose writes the trigger plus ✓/✗ conditions to the SK log and keeps those evaluations in traces. A finished evaluation is **OK** (including no matching choose branch or unmet condition) or **Failed** (missing path, script stderr, PUT error). The webapp polls `/status` lastRun and reloads traces when a run lands.

## HTTP

`registerWithRouter` (before `start`): GET `/status`, `/yaml`, `/commits`, `/diff`, `/automations/:id/traces`; POST `/live`, `/reload`, `/automations/:id/enabled`, `/automations/:id/verbose`, `/automations/:id/run`, `/helpers/:id/reset`; PUT `/helpers/:id`.

`signalKApiRoutes`: same GETs under `/signalk-automation-plugin/…` (SK 2.x MFD/readonly). Writes stay on `/plugins/`.

## Site YAML

`automationsDir` is a separate folder (usually its own git). This plugin does not ship a vessel’s automations. `examples/` is a fictional sample. On/off and Verbose are webapp switches in plugin-data, not YAML keys.
