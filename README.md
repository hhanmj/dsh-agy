# DSH × Antigravity (agy) Subagent

A DSH (DeepSeek Harness) plugin for delegating real coding tasks to the logged-in Google Antigravity CLI. Based on [ZEM17/dsh-subagent-agy](https://github.com/ZEM17/dsh-subagent-agy), MIT licensed.

**Version: 0.4.1.** The production-style one-shot task, follow-up and DSH Jobs workflows have been tested locally on DSH 0.2.0-rc.2. Native continuable child sessions are an **opt-in experimental feature**, tested with mocks, **not yet verified end-to-end in the DSH UI**.

## Features

- Foreground `antigravity` delegation through `ctx.subagents.start()`.
- Background AGY jobs, live output through DSH Jobs, cancel and independent working-tree evidence.
- `antigravity_followup` uses AGY's own conversation ID.
- **Experimental `antigravity_native_start`** uses real DSH `startContinuable()` to create a native DSH Agent and Session. A separate text-only model adapter delegates execution to AGY CLI and stores conversation ID mappings locally. The source default is off, but the v0.4.1 bundle patch explicitly enables the preview. Existing installations can toggle it using `scripts/set-native-preview.ps1`; not a GUI toggle.

## Install

Requires DSH 0.2.0-rc.2-compatible runtime, Node.js and the `agy` binary installed and logged in.

```powershell
npm ci
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stage-local-install.ps1
dsh plugin --profile web add ".\deploy\dsh-subagent-agy-reviewed"
```

**For DSH Desktop/Tauri install from the persistent directory, not a local `.tgz` file.** We observed its startup recovery report `INTERNAL_PLUGIN_DANGLING_LINK_UNINSTALLING` and remove a plugin registered via `file:...tgz`, along with its Profile config. The staged directory contains only packaged source output, is gitignored, and remains in place for the next start. Install using the profile actually started by your host, and restart the backend. This directory workaround still needs a restart test on the target Desktop. Avoid concurrent plugin-manager writes.

## Experimental native child sessions

The staged v0.4.1 bundle configuration includes `nativeContinuableEnabled: true`; **no separate toggle is necessary for the directory installation**. For an already installed and intact plugin whose configuration lacks that setting, enable it with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "F:\\agy-subagebt\\scripts\\set-native-preview.ps1" -Enable
```

Use `-Disable` to turn it off. The script backs up your profile patch and defaults to `web` (override with `-Profile`). Restart the DSH backend and inspect `dsh --profile web --dump-config` for `nativeContinuableEnabled: true`. **This is a command-line toggle, not a graphical marketplace setting.** Then invoke `antigravity_native_start({description, prompt})` from a DSH Agent. The tool returns a durable DSH child Session ID after the initial prompt was accepted; it **does not wait for AGY to finish**. Inspect the native subagent tree and use the DSH `send_message` tool for follow-ups to that direct child.

This is **not** a fully capable DSH tools adapter: AGY CLI uses its own tools, while DSH-host tool declarations are intentionally blocked for the child. Native child-to-parent proactive messaging is not implemented. Text requests only. The first CLI call assembles the DSH text prompt, and subsequent calls use AGY `--conversation`. Native mappings are local state under `~/.dsh`, never repository content.

## Security

- `--dangerously-skip-permissions` is enabled by default in this plugin. **Only delegate inside a trusted and explicitly authorized repository / Git worktree**. This option bypasses normal AGY approval.
- No credential, OAuth token, API key, user profile, private task log, or `~/.dsh` state is bundled or checked into this repository.
- AGY/Google account or service terms may restrict access through third-party integration. Review applicable terms before opting in. No Google private APIs or token extraction are used.
- Task evidence is initially `review_status: pending`: the parent must review actual code changes and independently run tests.
- Experimental native adapter deliberately fails on unsupported media or native DSH tools instead of claiming to execute them.

## Development

```powershell
npm run build
node --test scripts/evidence.test.mjs scripts/plugin-smoke.test.mjs scripts/native-manager.test.mjs scripts/native-continuable.test.mjs
```

`npm test` additionally checks for a locally installed `agy` CLI and does not send prompts unless you explicitly run `npm run selftest:e2e`.

## License and acknowledgements

MIT. Original work: [ZEM17/dsh-subagent-agy](https://github.com/ZEM17/dsh-subagent-agy). See `LICENSE`.