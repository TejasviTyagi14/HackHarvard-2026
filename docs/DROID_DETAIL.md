# Level of detail, controlled by Droid

The assistant can say more or less, depending on what the user asks for. A request like "give me more
detail" or "just the basics" goes to Droid (Factory's agent). Droid works out what the user means and
proposes new values for a fixed set of parameters. The page checks those values before using them.

While the app runs, you can say or type these requests in the conversation (mic, **A** key, or the text
box). The assistant spots them (`DETAIL` in `js/assistant.js`), says "One moment.", and hands the words to
Droid. Then it says Droid's acknowledgement, and the next answers use the new settings. Questions about the
scene ("tell me more", "what else", "is anything less than 2 meters") are not affected.

You can also send a request straight to Droid from the browser console with
`stereo.detail('give me more detail')`, or from a terminal with
`python3 tools/droid_bridge.py --ask "more detail"`.

## The parameters (`js/detail.js`)

Before this change, all of these were hard-coded. Their defaults reproduce the old answers exactly.

| Parameter | Type | Range | Default | Was hard-coded at | Effect |
|---|---|---|---|---|---|
| `maxItems` | integer | 1–10 | 4 | `list.slice(0, 4)` in `describe`, `direction`, `withinAnswer`, `more` (assistant.js) | Objects read out before "say what else" |
| `summary` | boolean | | true | `describe` | The opening "I see 5 things: 2 chairs, …" |
| `clock` | boolean | | true | `shortLine` | "at 11 o'clock" on each listed object |
| `lateral` | boolean | | true | `lateral()` | "about 1 meter to your left" |
| `reasons` | boolean | | true | `whereIs`, `between`, `compare` | Why an object has no distance |
| `caveats` | boolean | | true | `path` | "I only recognize about 80 kinds of things…" |
| `precision` | coarse / normal / fine | | normal | `sayDistance` | Half meters / 0.1 m / centimeters (feet: whole / half / feet and inches) |
| `updateItems` | integer | 1–6 | 3 | `speechSummary` (scene.js) | Measured objects per periodic spoken update |

There are also three presets, `brief`, `normal` and `detailed`. Droid can pick one and then adjust
individual values on top of it. The values are saved with the other settings under
`state.settings.detail`, and settings export and import include them.

## How it works

```
"keep it short" ─► assistant.js (DETAIL) ─► action.detail ─► requestDetailChange (app.js)
                   │
request text ──► DetailController.handleRequest(text)          js/detail.js  (browser)
                   │ POST /api/detail {request, current, schema}
                   ▼
                 tools/droid_bridge.py                          (localhost only)
                   │ droid exec -o json, read-only, --only-tools TodoWrite,
                   │ empty cwd, tools/detail_prompt.md as system prompt
                   ▼
                 Droid ──► {"preset", "set": {...}, "reply"}
                   ▲
   applyDetailUpdate(): unknown keys and bad types are rejected, numbers are clamped
                   ▼
   setDetail() → state.settings.detail → scene.detail → assistant.js reads it
```

- **Droid only proposes values.** It never edits files or settings. It runs at the default read-only
  autonomy (no `--auto`), with every tool removed except TodoWrite, which the CLI won't let you remove.
  It also runs in an empty temporary folder, so it can't read the repo or pick up an `AGENTS.md`.
- **One schema, kept in one place.** The schema lives in `js/detail.js`. It is sent with every request, so
  the prompt and the checks can't drift apart. Validation happens in the page, so a broken bridge or
  a bad reply can never put the app in a bad state.
- **Failures keep the current values.** If the bridge is down, Droid times out, the call fails to
  authenticate, or Droid replies with something that isn't JSON, nothing changes and a warning is logged.
  A newer request cancels an older one that hasn't finished.
- The user's words are passed to Droid as quoted data. The system prompt tells Droid to ignore anything
  in them that isn't about the amount of detail.

## Setup

1. Install Droid (`curl -fsSL https://app.factory.ai/cli | sh`) and create an API key at
   https://app.factory.ai/settings/api-keys.
2. `export FACTORY_API_KEY=fk-...`
3. Run `npm run start:droid` (or `python3 tools/droid_bridge.py`) instead of `npm start`. It serves
   the same site on port 8765 and adds `/api/detail`, but not phone calling, which needs `npm start`
   (the Node server on port 8766). Without the bridge, detail requests get "I couldn't change how
   much I say right now." and everything else works as before.

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `DROID_MODEL` | `anthropic-latest-fast` | Any `droid exec -m` ID or tier alias. A fast model keeps requests quick. |
| `DROID_REASONING` | model default | Reasoning effort, for example `low` |
| `DROID_TIMEOUT` | 40 | Seconds to wait before giving up |
| `DROID_BIN` | `droid` | Path to the CLI |

The bridge also passes `cloudSessionSync: false` through `--settings`, so these short requests stay out of
the Factory session list.

## Tests

- `node --test`: the parameters, presets, validation, and every answer shape each parameter changes. It
  also covers the controller against a mocked bridge: success, error, timeout, and replies that are not
  objects.
- `python3 -m unittest discover tests`: the bridge against a fake `droid`. It checks the exact flags
  (read-only, tools restricted, empty cwd), parsing a reply wrapped in a code fence, and each failure
  path. One live test calls the real Droid; it runs only when `FACTORY_API_KEY` is set and `node` is
  installed.

## What the Factory docs say (docs.factory.com), and the choices made

- `droid exec` is the non-interactive mode for scripts. `-o json` returns one object with `is_error`,
  `result`, `session_id`, `duration_ms` and `usage`.
  ([droid exec](https://docs.factory.com/cli/droid-exec/overview))
- By default it is read-only. `--auto low|medium|high` unlocks more. The local CLI (v0.244) uses the
  flags `--only-tools`, `--add-tools` and `--remove-tools`; the docs call them `--restrict-tools`,
  `--additional-tools` and `--disabled-tools`. ([CLI reference](https://docs.factory.com/reference/cli-reference))
- Custom droids (`.factory/droids/*.md`) run only through the Task tool, which is blocked in read-only
  exec, so `--append-system-prompt-file` is used instead.
  ([custom droids](https://docs.factory.com/cli/configuration/custom-droids))
- The docs list no flag for structured (JSON) output in `droid exec`. Only the TypeScript SDK has it
  (`outputFormat: JsonSchema`). This design asks for JSON in the prompt and validates the result itself.
  ([TypeScript SDK](https://docs.factory.com/sdk/typescript))

**Alternatives considered:**
- **TypeScript SDK (`@factory/droid-sdk`):** it can keep a session open, which avoids the CLI's startup
  cost on every request, and it enforces structured output. It would add Node and npm dependencies to a
  project that currently needs neither to run.
- **Custom droid or MCP tool:** this would let Droid call `set_detail_params` itself. That means giving
  it a write tool, and a JSON reply validated in the page does the same job with less risk.

**Known limits:**
- Every request starts a new `droid exec`, which takes a few seconds. That's fine for an occasional "more
  detail"; if requests become frequent, switch to the SDK with a persistent session. Only
  `tools/droid_bridge.py` would need to change.
- The map page (`map.html`) uses the default detail, because it doesn't pass `scene.detail`.
- Live calls weren't tested here, because there was no Factory API key. The real CLI accepted every
  flag the bridge passes and reached the authentication step.
