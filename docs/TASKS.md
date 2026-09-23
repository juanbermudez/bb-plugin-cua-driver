# Task breakdown

Legend: ✅ done in this repo · ⏳ needs a live machine with Cua Driver · ☐ todo

## M0 — Research (✅)

- ✅ Read bb plugin SDK 0.4.16 surface: `registerTool` (image results,
  `presentation.label`), `configure()` context (`provider.id`, `host.id`),
  `bb.hosts.experimental_client`, host entry lifecycle, testing harnesses.
- ✅ Confirm Claude Code, Codex, and Pi bridges accept dynamic plugin tools
  (`plugins/provider-*/src/bridge`).
- ✅ Read Cua Driver docs: integration options, MCP tool catalog (56 tools),
  CLI, permission modes, process model, platform support, telemetry, skill.
- ✅ Decide transport: MCP stdio from the host worker (no native deps in the
  host artifact; persistent session; full catalog discoverable).

## M1 — Core plugin (✅)

- ✅ `src/policy.ts` routing logic + tests.
- ✅ `src/contract.ts` server⇄host RPC contract.
- ✅ `src/mcp-client.ts` minimal MCP client + tests.
- ✅ `src/catalog.ts` 30 curated tools with zod schemas and labels.
- ✅ `host.ts` binary lookup, readiness probe, session management + tests.
- ✅ `server.ts` settings, tool registration, `configure()`, rpc, CLI,
  session cleanup on thread events + tests.
- ✅ `app.tsx` settings section + test.
- ✅ `skills/cua-computer-use/SKILL.md`.
- ✅ Manifest, icon, LICENSE, NOTICE, README, CONTRIBUTING, CHANGELOG, CI.
- ✅ `npm run check` green; `bb plugin build` emits server/app/host artifacts.
- ✅ Opt-in installer (`install` / `installState` host RPCs, `installChanged`
  signal, two-step confirm in the UI, `bb cua install --yes`) and macOS
  `grantPermissions` (`bb cua grant`) + tests.

## M2 — Live validation (partly ✅, against Cua Driver 0.28.2 on macOS 26)

`live.test.ts` (`npm run test:live`) runs the plugin's own server code in the
SDK's fake bb host wired to its real host entry, so each call takes the path a
thread's would: agent tool → server → host RPC → `cua-driver mcp` → daemon.

- ✅ Updated Cua Driver 0.23.2 → 0.28.2 with the official installer; version
  and `permissions status --json` parsing confirmed against real output (the
  0.28.2 payload is a fixture in `host.test.ts`).
- ✅ `cua-driver status` exits 0 exactly when the daemon is running.
- ✅ Calculator 6×7 through the plugin's tools (launch → window state →
  element-token clicks → reads 42), in the background.
- ✅ Browser flow: attach to a running Chrome (`existing_profile`), navigate,
  semantic snapshot, `cua_browser_download` of a CSV into an approved folder.
- ⏳ The same tasks from a real Claude Code thread and a Pi thread in bb.app;
  check screenshots render in the timeline.
- ⏳ Verify Codex thread receives no `cua_*` tools in `prefer-native` and
  does in `cua-everywhere`.
- ⏳ Remote machine: enroll a second host, run a thread there, confirm the
  host RPC path and idle disconnect (10 min) release the worker.
- ⏳ Windows via WSL2 note: bb's daemon runs inside WSL2, so the Windows
  desktop is not reachable from bb today. Document as unsupported unless the
  daemon gains a native Windows path.
- ⏳ Linux X11 pass on Ubuntu with AT-SPI.

### What 0.28 changed underneath 0.1.0 (fixed in 0.2.0)

- The hand-written schemas had drifted: `scroll` `by` rejected the valid
  `"line"`/`"page"`, and newer parameters (`click` `target`/`from_zoom`,
  `browser_prepare` `profile`/`strategy`, `launch_app`
  `creates_new_application_instance`) were stripped before reaching the
  driver. Schemas now come from `tools/list`.
- A session ends with the connection that carried it, and a reused label is
  refused ("session '…' has ended … use a new session id"). Any MCP restart
  broke every thread on that machine until the plugin restarted.
- `browser_prepare` with `allow_launch` is refused for a user-installed Chrome
  ("no vendor-signed system Chromium executable"), so agents attach to an
  existing window instead. That needs the daemon started with
  `--grant existing-profile`; `cua-driver mcp --grant` is refused while a
  daemon listens.
- Background clicks in a browser need `input_route: "dom_event"` on macOS.
- Refusals come back as ordinary results (`isError: false`, "refused (code)").
- AX presses right after an app launches can fail with -25204; a fresh
  snapshot and retry succeeds.

## M3 — Release and marketplace (☐, half a day)

- ☐ Create the public GitHub repository, push, tag `v0.1.0` (annotated).
- ☐ Capture 2–3 screenshots ≥1200 px wide for `screenshots/cua-driver/`.
- ☐ Fork `get-bb/marketplace`, add `entries/cua-driver.json` and the vendored
  icon (see `docs/MARKETPLACE.md`), run `npm ci && npm run build && npm test
  && npm run gate:v1 && npm run check`, open the PR.
- ☐ Notify Cua (Discord / GitHub discussion) with a link; ask whether they
  want to be listed as co-maintainers or have branding notes.

## M4 — Follow-ups (☐)

- ✅ Live schemas from the machine's `tools/list` via `configure()` parameter
  overrides when its driver version differs from the bundled snapshot (0.2.0).
- ☐ Thread header chip (session state, stop button).
- ☐ Trajectory recording panel with MP4 preview.
- ☐ Upstream bb proposal: `provider.capabilities.supportsNativeComputerUse`.
- ☐ Per-project allowlist setting.
- ☐ Optional in-process SDK path (`@trycua/cua-driver`) when the package is
  present on the machine, for lower latency than stdio.
