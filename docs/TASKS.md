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

## M2 — Live validation (⏳, 1–2 days)

- ⏳ Install Cua Driver on a macOS machine, grant permissions, run
  `bb cua status` and confirm version/permission parsing against real
  `permissions status --json` output; adjust `parsePermissions` keys.
- ⏳ Confirm `cua-driver status` exit-code semantics for `daemonRunning`.
- ⏳ Drive the tutorial task ("open Calculator, compute 6×7") from a Claude
  Code thread and a Pi thread; check screenshots render in the timeline.
- ⏳ Verify Codex thread receives no `cua_*` tools in `prefer-native` and
  does in `cua-everywhere`.
- ⏳ Browser flow: `cua_get_browser_state` → `cua_browser_click` on Chrome.
- ⏳ Remote machine: enroll a second host, run a thread there, confirm the
  host RPC path and idle disconnect (10 min) release the worker.
- ⏳ Windows via WSL2 note: bb's daemon runs inside WSL2, so the Windows
  desktop is not reachable from bb today. Document as unsupported unless the
  daemon gains a native Windows path.
- ⏳ Linux X11 pass on Ubuntu with AT-SPI.

## M3 — Release and marketplace (☐, half a day)

- ☐ Create the public GitHub repository, push, tag `v0.1.0` (annotated).
- ☐ Capture 2–3 screenshots ≥1200 px wide for `screenshots/cua-driver/`.
- ☐ Fork `get-bb/marketplace`, add `entries/cua-driver.json` and the vendored
  icon (see `docs/MARKETPLACE.md`), run `npm ci && npm run build && npm test
  && npm run gate:v1 && npm run check`, open the PR.
- ☐ Notify Cua (Discord / GitHub discussion) with a link; ask whether they
  want to be listed as co-maintainers or have branding notes.

## M4 — Follow-ups (☐)

- ☐ Live schema narrowing from the machine's `tools/list` via
  `configure()` parameter overrides.
- ☐ Thread header chip (session state, stop button).
- ☐ Trajectory recording panel with MP4 preview.
- ☐ Upstream bb proposal: `provider.capabilities.supportsNativeComputerUse`.
- ☐ Per-project allowlist setting.
- ☐ Optional in-process SDK path (`@trycua/cua-driver`) when the package is
  present on the machine, for lower latency than stdio.
