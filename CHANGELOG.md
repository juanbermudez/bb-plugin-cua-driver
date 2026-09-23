# Changelog

## 0.2.0

Validated live against Cua Driver 0.28.2 on macOS (see `docs/TASKS.md`, M2).

- Tool schemas now come from Cua Driver itself (`npm run sync:schemas`), and
  arguments are forwarded untouched. The hand-written 0.1.0 schemas had
  drifted: they rejected the valid `scroll` `by: "line"` and `"page"`, and
  silently dropped newer parameters such as `click` `target` and `from_zoom`,
  `browser_prepare` `profile` and `strategy`, and `launch_app`
  `creates_new_application_instance`.
- A machine whose driver version differs from the bundled snapshot advertises
  its own `tools/list` to agents.
- New tools: `cua_browser_download`, `cua_browser_set_input_files`,
  `cua_get_accessibility_tree`.
- Sessions: a dropped driver connection ends every session it carried, and
  Cua Driver refuses a reused label ("session … has ended"). The plugin now
  forgets a machine's session labels when its connection drops and retries a
  refused call once with a fresh label.
- **Signed-in browser profiles** setting: restarts the driver service with
  `--grant existing-profile` on macOS when on; refuses existing-profile
  attaches when off. (`cua-driver mcp --grant` is refused while a daemon
  listens, so the grant belongs to the service.)
- Update awareness: status reports the newest release, the machine checklist
  offers **Update to vX…**, and `bb cua update --yes` stops the driver before
  running the installer so the new binary is the one that restarts.
- The skill covers 0.28 browser behavior: `input_route: "dom_event"` for
  background clicks on macOS, refusals returned as ordinary results, and
  approved download folders.
- `live.test.ts` (`npm run test:live`) drives Calculator and an attached Chrome
  through the plugin's own server and host code.

## 0.1.0 (unreleased)

- First release: 30 `cua_*` agent tools, `cua-computer-use` skill, per-provider
  routing (`prefer-native`, `cua-everywhere`, `off` plus overrides), driver
  readiness per machine, `bb cua` CLI, multi-machine execution through the bb
  host daemon and one persistent `cua-driver mcp` session per machine.
- Opt-in installer and macOS permission request from the settings page and
  the CLI (`bb cua install --yes`, `bb cua grant`); never runs without an
  explicit confirmation.
- Settings use separate cards for routing, provider overrides, machines, and
  Cua attribution. Secondary lists and commands are collapsible, and row
  details sit behind a hover `?` tooltip so every row stays on one line. The
  tool list is available from `bb cua tools`.
- The installer runs in a reopenable progress dialog with phase estimates,
  status animation, retry states, and expandable terminal output.
- Machine setup is now an expandable checklist with install, service, and
  macOS permission state, including direct-capture guidance. Tool calls preflight
  readiness and link permission failures directly back to the settings panel.
- Resuming an idle thread now starts a fresh Cua session label instead of
  reusing the ended label from the previous turn.
- The user-facing plugin name is **Computer Use**; Cua Driver and Cua AI remain
  credited and linked in the listing, settings, README, and notice.
