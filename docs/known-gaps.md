# Known gaps

- No HA templates, `wait_for_trigger`, or `mode: queued`. `mode` is `parallel` (default), `restart`, or `single`. `for:` only on the first trigger that has it.
- Action `if:` skips that step when the clauses fail (used after `delay` so an off does not fire underway).
- Script `allow_stderr` does not exist; any stderr fails the run.
- PUT source tagging is `$source` contains plugin id. Another plugin that PUTs the latched path will look “external” and set the helper.
- If a path has more than one PUT handler, Signal K rejects a PUT without `source`. The plugin retries with the path `$source` (and other listed sources).
- Admin plugin list JSON from `/skServer/plugins` may be empty; status GET + webapp are the smoke path.
