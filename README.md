# Computer Use for bb

Computer use for [bb](https://getbb.app) agents, powered by
[Cua Driver](https://cua.ai/docs) from Cua AI, Inc.

Agents running in bb threads get `cua_*` tools that observe and operate native
desktop apps and Chromium browser windows **on the machine that runs the
thread**, in the background, without stealing focus. Routing is per provider:
harnesses that ship their own computer use (Codex today) can keep it while
Claude Code, Pi, ACP agents, and everything else use Cua Driver. Or force Cua
Driver everywhere, or turn it off.

This is a community plugin. It is not affiliated with or endorsed by Cua AI,
Inc. or the bb team. See [NOTICE.md](NOTICE.md) for attribution.

## What you get

| Surface | Details |
| --- | --- |
| Agent tools | 35 tools: 21 desktop (`cua_list_apps`, `cua_launch_app`, `cua_get_window_state`, `cua_get_accessibility_tree`, `cua_click`, `cua_type_text`, `cua_press_key`, `cua_hotkey`, `cua_scroll`, `cua_drag`, `cua_set_value`, `cua_invoke_menu`, `cua_verify_state`, `cua_set_window_frame`, `cua_bring_to_front`, `cua_zoom`, ...), 9 browser (including `cua_browser_download` and `cua_browser_set_input_files`), 2 clipboard, and 3 meta (`cua_call` for any upstream tool, `cua_describe`, `cua_status`). Each tool advertises Cua Driver's own input schema and forwards arguments untouched. Screenshots come back as images the model can see. |
| Agent skill | `cua-computer-use`, adapted from the upstream Cua Driver skill: snapshot-before-action, verify-after, the escalation ladder, and the pitfalls list. |
| Settings UI | Routing mode, per-provider overrides, an expandable setup checklist for every machine, guided install and permission actions, tool-group toggles. |
| CLI | `bb cua status`, `bb cua policy`, `bb cua mode`, `bb cua tools`, `bb cua call`, `bb cua install`, `bb cua update`, `bb cua grant`. |
| Multi-machine | Tool calls run on the host that owns the thread's environment through bb's host RPC, so remote enrolled machines work the same as the local one. |

## Requirements

- bb `>=0.39` with plugin SDK `>=0.4.16`.
- **Cua Driver installed on each machine that should be driven.** The plugin
  never installs it silently: either run the commands below yourself, or click
  **Install Cua Driver…** next to a machine in the plugin settings (or run
  `bb cua install --yes`), which downloads Cua's official install script and
  runs it on that machine after you confirm. macOS 14+, Windows 10/11, or
  Linux x86_64 with X11 or XWayland plus AT-SPI 2:

  ```sh
  # macOS / Linux
  /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
  cua-driver doctor
  # macOS only: grant Accessibility + Screen Recording, then relaunch CuaDriver.app
  cua-driver permissions grant
  ```

  ```powershell
  # Windows
  irm https://cua.ai/driver/install.ps1 | iex
  cua-driver autostart kick
  ```

  Install docs: <https://cua.ai/docs/how-to-guides/driver/install>.

## Install

```sh
bb plugin install https://github.com/juanbermudez/bb-plugin-cua-driver
# or pin a release range
bb plugin install git:https://github.com/juanbermudez/bb-plugin-cua-driver.git@^0.1.0
```

From a checkout:

```sh
npm install
bb plugin install .
```

## Staying current with Cua Driver

Tool schemas come from Cua Driver itself. `src/upstream-schemas.generated.ts`
is a snapshot of `tools/list` (tested against Cua Driver 0.28.2); regenerate it
after updating the driver and review the diff:

```sh
npm run sync:schemas
```

Arguments are forwarded untouched, so a newer driver's parameters work before
the snapshot is refreshed, and a machine whose driver version differs from the
snapshot advertises its own `tools/list` to agents once it has been read.

When a newer release exists, the machine's checklist offers **Update to
vX…**, `cua_status` says so, and `bb cua update --yes` stops the driver, runs
Cua's official installer, and starts it again.

## Signed-in browser profiles

Cua Driver 0.28 treats any Chrome or Edge window with a real profile as a
person's signed-in profile: reading it needs the driver service started with
`--grant existing-profile`. Turn on **Signed-in browser profiles** in the plugin
settings to allow it. The plugin then restarts the service on macOS with that
grant (through LaunchServices, so it keeps CuaDriver.app's permissions) and
agents attach with `cua_browser_prepare({pid, window_id, strategy: {kind:
"existing_profile"}})`. With the setting off, the plugin refuses that attach
itself. Turning the setting off blocks those attaches at once, but the running
service keeps the grant until it restarts: run `cua-driver stop` to drop it
now. The plugin never removes a grant itself, since someone else may have
started the service that way. On Linux and Windows, start
`cua-driver serve --grant existing-profile` yourself.

## Configure

Open **Settings → Plugins → Computer Use**, or use the CLI.

Each enrolled machine has an expandable checklist for its bb connection, Cua
Driver installation, service state, and macOS Accessibility, Screen Recording,
and direct-capture consent. Machines needing attention open automatically.
Actions to install, grant permissions, and re-check setup stay inside that
machine's panel.

### Routing mode

| Mode | Codex | Claude Code, Pi, ACP agents, others |
| --- | --- | --- |
| `prefer-native` (default) | keeps its own computer use, no Cua tools | Cua Driver tools |
| `cua-everywhere` | Cua Driver tools | Cua Driver tools |
| `off` | no Cua tools | no Cua tools |

A per-provider override (`cua`, `native`, `off`, or `inherit`) beats the mode.

```sh
bb plugin config cua-driver set mode cua-everywhere
bb cua policy codex native        # keep Codex on its own computer use
bb cua policy pi cua
bb cua policy                     # show the effective decision per provider
```

Tool and skill changes apply when a thread's next provider session starts,
never mid-session (a bb rule for every plugin).

"Native" means the plugin steps aside. Whether a harness's own computer use is
actually available inside bb depends on that harness and its bb provider
bridge; the plugin does not enable or configure it.

### Other settings

| Setting | Default | Effect |
| --- | --- | --- |
| Browser tools | on | Expose `cua_get_browser_state`, `cua_browser_*`. |
| Clipboard tools | on | Expose `cua_clipboard_read` / `cua_clipboard_write`. |
| Passthrough tools | on | Expose `cua_call` and `cua_describe` for the long tail (recording, cursor themes, sessions, `page`). |
| Session label prefix | `bb` | Each active thread run gets a unique label beginning with `<prefix>-<threadId>`; the label shows in the agent cursor badge. |

## How it works

```
thread turn ──▶ bb server (plugin server.ts)
                 │  bb.agents.configure(): policy → tool set per provider
                 │  cua_* tool execute(): thread → environment → hostId
                 ▼
             bb host daemon on that machine (plugin host.ts)
                 │  spawns `cua-driver mcp` once, keeps one MCP stdio session
                 ▼
             Cua Driver runtime ──▶ desktop / browser
```

- The host worker talks to `cua-driver mcp` over stdio using MCP JSON-RPC, so
  the plugin ships no native binaries and works on every enrolled machine that
  has Cua Driver on `PATH`, `~/.local/bin`, `%LOCALAPPDATA%\Programs\Cua`, or
  `CUA_DRIVER_PATH`.
- One persistent transport per machine keeps browser refs, recordings, and
  named sessions valid across calls. It disconnects after 10 idle minutes and
  reconnects on the next call.
- The bb plugin tools are a curated, typed subset of the upstream catalog.
  `cua_call` reaches everything else with the upstream name and arguments.
- When a thread goes idle, fails, or is archived, the plugin ends that thread's
  Cua session.

## Installing from bb (opt-in)

The settings page shows **Install Cua Driver…** for any online machine where
the driver is missing. Clicking it shows exactly what will run and asks for a
second click. The host worker then:

1. downloads `https://cua.ai/driver/install.sh` (or `install.ps1` on Windows)
   into the worker's temp directory,
2. runs it as your user with `/bin/bash` (or `powershell -ExecutionPolicy
   Bypass -File`) while a modal shows estimated phase progress and keeps the
   raw output under expandable installation details,
3. on macOS starts `CuaDriver.app` in the background; on Windows runs
   `cua-driver autostart kick`,
4. re-checks readiness.

No admin rights are requested. On macOS a **Grant permissions** button then
runs `cua-driver permissions grant`, which triggers the system prompts for
Accessibility and Screen Recording; approve both and fully relaunch
`CuaDriver.app` if macOS asks. A one-time direct-capture consent prompt may
also appear on the first screenshot. The CLI equivalents are `bb cua install --yes` and
`bb cua grant`; `install` refuses to run without `--yes`.

Before each computer-use action, the plugin checks a recent readiness snapshot.
If the driver or a required macOS permission is missing, it stops before the
action and returns a direct link to **Settings → Plugins → Computer Use** with
the exact recovery step. Permission failures returned later by Cua Driver are
normalized into the same guided recovery instead of inviting blind retries.

## Permissions and safety

- Cua Driver's own authorization stack applies unchanged. The plugin runs the
  driver in its default `standard` permission mode; bounded or unrestricted
  modes and capability manifests are configured on the machine, outside bb
  (see <https://cua.ai/docs/reference/cua-driver/permission-modes>).
- Attaching to a signed-in Chromium profile requires a launch grant on the
  machine (`--grant existing-profile`). The plugin never passes grants.
- Agents are instructed never to launch apps or perform destructive GUI steps
  without explicit user intent. Review actions in the thread timeline; every
  tool call is a labeled row.
- Cua Driver sends content-free telemetry to Cua by default. Disable it on the
  machine with `cua-driver telemetry disable` (see
  <https://cua.ai/docs/reference/cua-driver/telemetry>). The plugin itself
  sends nothing anywhere.

## Development

```sh
npm install            # add --ignore-scripts if better-sqlite3 fails to build, then: PYTHON=/usr/bin/python3 npm rebuild better-sqlite3
npm run typecheck
npm test
npm run build          # bb plugin build → dist/
bb plugin install .    # then `bb plugin dev` for the rebuild-on-save loop
```

Layout:

```
server.ts          plugin factory: settings, tools, configure(), rpc, cli, events
host.ts            host entry: find cua-driver, probe readiness, MCP session, tool calls
app.tsx            settings section UI
src/catalog.ts     curated tool definitions (zod schemas, labels, groups)
src/policy.ts      routing decision logic (pure)
src/contract.ts    server ⇄ host RPC contract
src/mcp-client.ts  minimal MCP stdio JSON-RPC client
skills/            agent skill injected when Cua tools are active
docs/              spec, architecture, settings UI, tasks, marketplace
```

## License

MIT. Cua Driver is MIT licensed by Cua AI, Inc.; see [NOTICE.md](NOTICE.md).
