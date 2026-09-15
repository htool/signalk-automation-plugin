# ADR 001 — YAML files, not plugin options

- Status: accepted, implemented
- Date: 2026-09-14

## Decision

Automations, helpers, and zones live in `*.yaml` (git / `live/` snapshot). Plugin options only hold `automationsDir`, `scriptsDir`, `traceCount`, `scriptTimeoutSeconds`. Runtime state (`state.json`, traces, `live/`) uses `getDataDirPath()`.

## Why

The admin Save form overwrites plugin options. Buddy roster already learned that. YAML in git is diffable; enabling/disabling an automation at runtime must not rewrite the YAML.

## Not

No HA `configuration.yaml` compatibility. No storing the full rule set in `plugin-config-data/<id>.json` `configuration`.
