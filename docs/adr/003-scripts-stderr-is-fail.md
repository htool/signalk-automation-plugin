# ADR 003 — Script stderr is fail

- Status: accepted, implemented
- Date: 2026-09-14

## Decision

`run:` executes a file relative to plugin option `scriptsDir` via `execFile` (`.py` → `python3`, `.sh` → `bash`). Absolute paths and `..` are rejected. **Any non-empty stderr is failure**, even if exit 0 and stdout is present. Stdout (trimmed; JSON/bool/number parsed) is the value. Optional `as:` writes that value to a helper.

## Why

Hans: use the output; stderr means fail. Quiet success, noisy failure. No shell strings (RCE surface).
