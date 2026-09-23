---
name: cua-computer-use
description: Drive native desktop apps and browser windows on the thread's machine through the cua_* tools (Cua Driver). Use when the user asks to operate, automate, test, or inspect a real GUI application, or when a task's outcome lives in a window rather than in files or a shell.
---

# Computer use with Cua Driver

The `cua_*` tools run on the machine that owns this thread's environment.
They act in the background by default: no focus steal, no cursor hijack.
This skill is condensed from the upstream Cua Driver skill pack (MIT, Cua AI,
Inc.); tool names here carry the `cua_` prefix.

## Pick the narrowest route first

1. Non-GUI outcome (file move, data export, build) → use your shell, files,
   or an API. Do not imitate a user for something a command can do.
2. Typed outcome → `cua_set_window_frame`, `cua_invoke_menu`, browser tools,
   clipboard tools. Verify in the same domain.
3. Background accessibility action → `cua_click`, `cua_type_text`,
   `cua_set_value`, `cua_press_key` with an `element_token`.
4. Background pixel action → same tools with window-local `x`, `y` taken from
   the screenshot you already have.
5. Foreground delivery → `delivery_mode: "foreground"`, only after a refusal
   or a confirmed no-op, and only if the user accepts visible control.
6. Desktop scope → `cua_get_desktop_state` plus `scope: "desktop"` as a last
   resort for screen-absolute work.

## The invariant: snapshot before, verify after

- Before any element action call `cua_get_window_state({pid, window_id})`.
  It returns the accessibility tree with `element_token`s and a screenshot.
  Tokens die on the next snapshot; never reuse one across snapshots.
- After the action call `cua_verify_state` with a bounded predicate, or take
  a fresh snapshot and read it. `unknown` never means success.
- Read the action result: `effect` is `confirmed`, `partial`, `unverifiable`,
  `suspected_noop`, or `refused`. `escalation.recommended` tells you the next
  rung (`pixel`, `foreground`, `page`). Escalate on a real signal only.

## Canonical loop

```
cua_list_apps                                  # find pid (or cua_launch_app)
cua_list_windows {pid}                         # pick window_id by title / z_index
cua_get_window_state {pid, window_id}          # tree + screenshot
cua_click {pid, element_token}                 # act by token
cua_verify_state {pid, window_id, expect:[{element:{selector:{label_contains:"Saved"},exists:true}}]}
```

Pass `pid` on keyboard tools (`cua_press_key`, `cua_hotkey`,
`cua_type_text`) so input reaches that process without changing focus.

## Browser windows (Chrome, Edge, Electron)

Bind the native window once with `cua_get_browser_state({pid, window_id})`,
then act through `cua_browser_click`, `cua_browser_type`,
`cua_browser_navigate`, and `cua_browser_pointer` using the returned
`target_id`, `tab_id`, and `ref`. Refs expire on the next snapshot; take them
from `refs` in a `snapshot_format: "semantic_v2"` read, narrowed with `query`.

- A Chrome or Edge window people use daily is a signed-in profile. Attaching
  needs `cua_browser_prepare({pid, window_id, strategy: {kind:
  "existing_profile"}})` and the **Signed-in browser profiles** setting; if the
  tool says the setting is off, ask the user instead of working around it.
- On macOS, background clicks need `input_route: "dom_event"`; the default
  trusted route is refused unless the window may come to the front.
- `cua_browser_download` saves into an existing absolute directory the user
  approved (`destination_root`); confirm the folder before downloading.
- Refusals come back as ordinary results reading `refused (<code>)` with a
  `next_action`; read them, they are not successes. If the driver refuses,
  say so instead of retrying the same call.

## Readiness and errors

- `cua_status` reports install, version, service, and macOS permissions for
  this thread's machine. Run it once when a tool reports the driver is not
  installed or refuses with `permission_required`.
- `No cached AX state` or `stale_element_token`: re-snapshot, then act.
- `ambiguous_window_target`: pass an explicit `window_id`.
- `AXPress returned -25204` right after launching an app: the app is still
  busy; re-snapshot and retry once.
- Sessions are managed for you: every call in this thread shares one Cua
  session, renewed automatically if the driver ended it.
- Long tail tools (recording, cursor themes, sessions, `page`) are reachable
  through `cua_call {tool, arguments}`; read the schema with `cua_describe`.

## Things to avoid

- Do not launch apps or run destructive GUI steps (delete, send, submit,
  close unsaved work) without explicit user intent for that step.
- Do not compute pixel coordinates from the tree; take them from the image.
- Do not use foreground delivery to "just make it work"; it steals focus from
  the user.
- Do not replace verified Cua actions with shell scripts that poke the UI.
