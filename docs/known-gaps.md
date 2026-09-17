# Known gaps

- No HA templates, `wait_for_trigger`, or `mode: queued`. `for:` only on the first trigger that has it.
- Script `allow_stderr` does not exist; any stderr fails the run.
- PUT source tagging is `$source` contains plugin id. Another plugin that PUTs the latched path will look “external” and set the helper.
- Admin plugin list JSON from `/skServer/plugins` may be empty; status GET + webapp are the smoke path.
