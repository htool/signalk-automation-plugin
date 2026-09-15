# Known gaps

- First npm publish cannot use OIDC. Package is still 404. After `npm publish --access public` once: Trusted Publisher https://www.npmjs.com/package/signalk-automation-plugin/access — GitHub Actions, `htool` / `signalk-automation-plugin` / `release.yml`, environment empty, allow `npm publish`.
- Boatnet YAML git is `htool/boatnet_automations` (`/home/pi/src/boatnet_automations`). Plugin `examples/` remains the bundled copy. On/off is plugin-data, not YAML.
- No HA templates, `wait_for_trigger`, or `mode: queued`. `for:` only on the first trigger that has it.
- Script `allow_stderr` does not exist; any stderr fails the run.
- PUT source tagging is `$source` contains plugin id. Other plugins that PUT Starlink will look “external” and latch `starlink_manual`.
- Admin plugin list JSON from `/skServer/plugins` was not used in the boatnet smoke test (empty body). Status GET + webapp were.
- Hop `AGENTS.md` confirmation edit may be uncommitted relative to `origin/main` `2955fe1`.
