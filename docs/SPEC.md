# Specification: Computer Use for bb

Status: v0.1 implemented. Sections marked *later* are planned, not shipped.

## 1. Goal

Give every bb agent thread the ability to observe and operate the desktop and
browser windows of the machine that runs the thread, using Cua Driver, while
letting users decide per provider whether the harness's own computer use or
Cua Driver is used.

## 2. Non-goals

- Silent installation, bundling the driver, granting OS permissions on the
  user's behalf, or changing its permission mode. The plugin offers an
  explicit, confirmed "run the official installer" action (FR-16) and a
  "request permissions" action that only triggers the OS prompts; the user
  still approves them.
- Replacing a harness's native computer use. "Native" means the plugin steps
  aside; it does not configure the harness.
- Cloud sandboxes (Cua Cloud Fleet, Lume VMs). A remote bb machine with Cua
  Driver installed already works through host RPC; provisioning is out of
  scope.
- Reproducing all 56 upstream tools as typed bb tools. A curated set is typed;
  the rest is reachable through `cua_call`.

## 3. Functional requirements

| ID | Requirement | Status |
| --- | --- | --- |
| FR-1 | Register typed `cua_*` tools for the desktop, browser, clipboard, and meta groups. | done |
| FR-2 | Advertise tools per provider according to the routing policy at `thread.start` / `turn.submit`. | done |
| FR-3 | Routing modes `prefer-native`, `cua-everywhere`, `off`; per-provider overrides `cua`, `native`, `off`, `inherit`. | done |
| FR-4 | Default native table: `codex` has native computer use; everyone else does not. Editable per provider. | done |
| FR-5 | Execute every tool on the host that owns the thread's environment. | done |
| FR-6 | One persistent `cua-driver mcp` transport per machine; idle disconnect after 10 min; reconnect on demand. | done |
| FR-7 | Unique Cua session label per active thread run, beginning with `<prefix>-<threadId>`; end it on thread idle/failed/archived/deleted and issue a fresh label when work resumes. | done |
| FR-8 | Return screenshots as image content the model can see; append `structuredContent` (element tokens) as text. | done |
| FR-9 | `cua_status` and the settings UI report install, version, service, and macOS permission state per machine, with fix instructions. | done |
| FR-10 | Inject the `cua-computer-use` skill and a readiness line into instructions when Cua tools are active. | done |
| FR-11 | `bb cua` CLI for status, policy, mode, tool catalog, raw calls. | done |
| FR-12 | Settings UI: mode radio, provider table with override selects, machine readiness with "Check", install/permission help. | done |
| FR-13 | Live schema refresh: narrow advertised parameter schemas from the machine's `tools/list`. | later |
| FR-14 | Optional trajectory recording toggle per thread with a panel to review the MP4. | later |
| FR-15 | Detect native computer use from a bb provider capability flag instead of a hardcoded table. | later (needs bb change) |
| FR-16 | Opt-in installer: after a two-step confirm, download Cua's official install script into the worker temp dir, run it as the user, stream output lines to the UI via host signals, re-probe readiness. CLI `bb cua install --yes`. | done |
| FR-17 | macOS "Grant permissions" action running `cua-driver permissions grant`; CLI `bb cua grant`. | done |
| FR-18 | Expandable setup checklist per machine, including install, service, Accessibility, Screen Recording, and direct-capture guidance. | done |
| FR-19 | Preflight tool calls against recent readiness and convert permission failures into an actionable plugin-settings link. | done |

## 4. Settings model

Declarative (`bb.settings.define`, editable via bb's form and
`bb plugin config cua-driver set <key> <value>`):

| Key | Type | Default |
| --- | --- | --- |
| `mode` | select `prefer-native` / `cua-everywhere` / `off` | `prefer-native` |
| `browserTools` | boolean | `true` |
| `clipboardTools` | boolean | `true` |
| `passthroughTools` | boolean | `true` |
| `sessionPrefix` | string | `bb` |

Plugin storage (`bb.storage.kv`):

| Key | Value |
| --- | --- |
| `policy-overrides` | `Record<providerId, "cua" \| "native" \| "off">` (inherit entries are removed) |
| `driver-status:<hostId>` | last `DriverStatus` probe for that machine |

Provider ids are dynamic (plugins add providers), so overrides live in kv and
the UI lists whatever `bb.sdk.providers.list()` returns.

## 5. Routing algorithm

```
decision(provider) =
  overrides[provider] if set and != inherit
  else mode == off            → off
  else mode == cua-everywhere → cua
  else (prefer-native)        → provider ∈ NATIVE ? native : cua
```

`configure()` returns `{ tools: enabledToolNames, skills: ["cua-computer-use"],
instructions }` for `cua`, and `{ tools: [], skills: [] }` otherwise. Group
toggles remove browser, clipboard, and meta tools; `cua_status` stays even when
passthrough is off so agents can always diagnose.

## 6. Tool surface

Names are `cua_<upstream>` for typed tools. Parameter names are identical to
upstream so agents can move between typed tools and `cua_call`. The `session`
parameter is never exposed; the server injects the thread label and the host
only forwards it to tools whose live schema declares `session`.

Result mapping: MCP `text` → text, `image` → image (base64 + mime), other →
JSON text, `structuredContent` → `structuredContent:\n<json>` text capped at
200 KB, empty → `(empty result)`. MCP `isError` maps to bb `isError`.

## 7. Host execution

`host.ts` runs inside the bb host daemon on the target machine:

1. Resolve the binary: `CUA_DRIVER_PATH`, each `PATH` entry, then
   `~/.local/bin/cua-driver` (macOS/Linux) or
   `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin\cua-driver.exe`. Cached 60 s.
2. `status`: `cua-driver --version`, optional `cua-driver status` (exit 0 =
   service running), and on macOS `cua-driver permissions status --json`
   parsed leniently for `accessibility` and `screen_recording` grants.
3. `callTool` / `listTools`: spawn `cua-driver mcp`, MCP `initialize` +
   `tools/list`, then `tools/call`. Retain the worker while connected; idle
   timer 10 min; lifecycle abort and `dispose` kill the child.
4. Signal `connectionChanged` to the server on connect and close.

On macOS `cua-driver mcp` proxies to `CuaDriver.app`, which owns the TCC
grants. On Windows and Linux the MCP process owns the runtime directly, so
the bb daemon must run in the interactive desktop session.

## 8. Errors

- Driver missing or macOS grants unconfirmed → the tool stops before acting and
  returns `isError` with the exact machine setup step and a direct plugin-settings
  link; configure instructions also carry the last known readiness.
- Transport death → in-flight calls reject, worker lease released, next call
  reconnects.
- Permission refusals returned by Cua Driver are normalized into the same guided
  settings recovery and retain a bounded driver detail. Other failures also link
  to the machine checklist. Stale-token failures retain the skill's guidance.

## 9. Security and privacy

- Full-trust plugin like every bb plugin; runs only what the user installed.
- No grants, manifests, or permission-mode changes are passed to the driver.
- Only `hostId`, tool name, and arguments cross the server/host boundary;
  screenshots travel back to the server as tool results, the same path any
  provider tool result takes.
- Cua telemetry is the machine's setting; documented in the README.

## 10. Compatibility

- bb `>=0.39`, plugin SDK `>=0.4.16` (uses `bb.hosts.experimental_client`,
  `bb.agents.configure`, `presentation.label` on tools).
- Cua Driver `>=0.17` for snapshot-bound element tokens; tested against docs
  for 0.23.x. No live driver was available in the authoring environment; the
  MCP wire format follows the MCP 2025-06-18 specification.
- Providers verified to accept plugin tools in bb source: Claude Code, Codex,
  Pi. ACP providers did not show dynamic-tool plumbing in the bb checkout
  used; treat ACP as untested.

## 11. Open questions

1. Should `native` for Codex also suppress the skill? Today it does.
2. Should bb expose `supportsNativeComputerUse` on `provider.capabilities` so
   the table in `src/policy.ts` disappears? Proposed upstream.
3. Per-project overrides (for example, only allow computer use in certain
   projects) may be worth adding via the `project` setting type.
