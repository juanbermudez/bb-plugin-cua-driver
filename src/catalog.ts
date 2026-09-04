import { z } from "zod";

export const TOOL_GROUPS = ["desktop", "browser", "clipboard", "meta"] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

export interface CatalogEntry {
  name: string;
  upstream: string | null;
  group: ToolGroup;
  description: string;
  parameters: z.ZodObject<z.ZodRawShape>;
  labels: { pending: string; completed: string };
}

const pid = z.number().int().describe("Process id from launch_app or list_apps");
const windowId = z.number().int().describe("Window id from list_windows or launch_app");
const elementToken = z
  .string()
  .describe("Opaque element_token from the latest get_window_state snapshot");
const elementIndex = z
  .number()
  .int()
  .describe("Visible element index; requires snapshot_id from the same snapshot");
const snapshotId = z.string().describe("snapshot_id returned by get_window_state");
const deliveryMode = z
  .enum(["background", "foreground"])
  .describe("background (default) never steals focus; foreground activates the window");
const scope = z
  .enum(["window", "desktop"])
  .describe("desktop uses screen-absolute coordinates from get_desktop_state");
const modifiers = z
  .array(z.enum(["cmd", "ctrl", "alt", "shift", "fn", "win"]))
  .describe("Modifier keys held during the action");

const elementTarget = {
  pid: pid.optional(),
  window_id: windowId.optional(),
  element_token: elementToken.optional(),
  element_index: elementIndex.optional(),
  snapshot_id: snapshotId.optional(),
  x: z.number().optional().describe("Window-local x in points (pixel form)"),
  y: z.number().optional().describe("Window-local y in points (pixel form)"),
  delivery_mode: deliveryMode.optional(),
  scope: scope.optional(),
};

const browserTab = {
  target_id: z.string().describe("Browser target id from get_browser_state"),
  tab_id: z.string().describe("Tab id from get_browser_state"),
};

function tool(
  upstream: string,
  group: ToolGroup,
  description: string,
  shape: z.ZodRawShape,
  labels: { pending: string; completed: string },
): CatalogEntry {
  return {
    name: `cua_${upstream}`,
    upstream,
    group,
    description,
    parameters: z.object(shape),
    labels,
  };
}

export const CATALOG: readonly CatalogEntry[] = [
  tool(
    "list_apps",
    "desktop",
    "List running and installed desktop apps with pid and bundle id or launch path. Start here to find a target app.",
    {},
    { pending: "Listing desktop apps", completed: "Listed desktop apps" },
  ),
  tool(
    "list_windows",
    "desktop",
    "List top-level windows with window_id, title, bounds, and z_index (higher is frontmost). Filter by pid.",
    {
      pid: pid.optional(),
      on_screen_only: z.boolean().optional(),
    },
    { pending: "Listing windows", completed: "Listed windows" },
  ),
  tool(
    "launch_app",
    "desktop",
    "Launch an app in the background without stealing focus. macOS uses bundle_id; Windows and Linux use name or a launch path. Returns pid and windows. Confirm with the user before launching apps they did not ask for.",
    {
      bundle_id: z.string().optional(),
      name: z.string().optional(),
      urls: z.array(z.string()).optional().describe("Files or URLs to open"),
      additional_arguments: z.array(z.string()).optional(),
    },
    { pending: "Launching app", completed: "Launched app" },
  ),
  tool(
    "get_window_state",
    "desktop",
    "Snapshot one window: accessibility tree with element_token per element plus a screenshot. Call before every element action; tokens expire on the next snapshot.",
    {
      pid,
      window_id: windowId,
      include_accessibility_tree: z.boolean().optional(),
      include_screenshot: z.boolean().optional(),
      max_depth: z.number().int().optional(),
      max_elements: z.number().int().optional(),
      max_dimension: z.number().int().optional().describe("Downscale the screenshot"),
      query: z.string().optional().describe("Only return elements matching this text"),
    },
    { pending: "Reading window state", completed: "Read window state" },
  ),
  tool(
    "get_desktop_state",
    "desktop",
    "Capture the full primary display at native resolution. Use only for desktop-scope work with no single target window.",
    {},
    { pending: "Capturing desktop", completed: "Captured desktop" },
  ),
  tool(
    "get_screen_size",
    "desktop",
    "Return the logical display size in points and the backing scale factor.",
    {},
    { pending: "Reading screen size", completed: "Read screen size" },
  ),
  tool(
    "click",
    "desktop",
    "Click an element by element_token (preferred) or window-local x,y. Background delivery by default. Check effect and escalation in the result before retrying.",
    {
      ...elementTarget,
      button: z.enum(["left", "right", "middle"]).optional(),
      action: z
        .enum(["press", "show_menu", "confirm", "cancel", "pick"])
        .optional()
        .describe("Accessibility action to invoke; press is the default"),
      modifier: modifiers.optional(),
      count: z.number().int().min(1).max(3).optional(),
    },
    { pending: "Clicking", completed: "Clicked" },
  ),
  tool(
    "double_click",
    "desktop",
    "Double-click an element or window-local coordinates.",
    { ...elementTarget, pid },
    { pending: "Double-clicking", completed: "Double-clicked" },
  ),
  tool(
    "right_click",
    "desktop",
    "Right-click an element or window-local coordinates to open a context menu.",
    { ...elementTarget, pid, modifier: modifiers.optional() },
    { pending: "Right-clicking", completed: "Right-clicked" },
  ),
  tool(
    "drag",
    "desktop",
    "Press, drag, and release between two window-local points.",
    {
      pid: pid.optional(),
      window_id: windowId.optional(),
      from_x: z.number(),
      from_y: z.number(),
      to_x: z.number(),
      to_y: z.number(),
      duration_ms: z.number().int().optional(),
      steps: z.number().int().optional(),
      modifier: modifiers.optional(),
      delivery_mode: deliveryMode.optional(),
      scope: scope.optional(),
    },
    { pending: "Dragging", completed: "Dragged" },
  ),
  tool(
    "type_text",
    "desktop",
    "Insert text into a focused or targeted element. Element form sets the value through accessibility; x,y form clicks to focus first, which fixes web and Electron inputs.",
    { ...elementTarget, text: z.string(), delay_ms: z.number().int().optional() },
    { pending: "Typing text", completed: "Typed text" },
  ),
  tool(
    "press_key",
    "desktop",
    "Press one key (for example Return, Escape, Tab, a) with optional modifiers, targeted at a pid or element.",
    { ...elementTarget, key: z.string(), modifiers: modifiers.optional() },
    { pending: "Pressing key", completed: "Pressed key" },
  ),
  tool(
    "hotkey",
    "desktop",
    "Press a key combination such as [\"cmd\",\"c\"] or [\"ctrl\",\"s\"] against a pid without changing focus.",
    { ...elementTarget, keys: z.array(z.string()).min(1) },
    { pending: "Pressing hotkey", completed: "Pressed hotkey" },
  ),
  tool(
    "set_value",
    "desktop",
    "Set the whole value of a non-text control (popup button, checkbox, slider) through accessibility. Also the reliable commit path for minimized windows.",
    {
      pid,
      window_id: windowId.optional(),
      element_token: elementToken.optional(),
      element_index: elementIndex.optional(),
      snapshot_id: snapshotId.optional(),
      value: z.string(),
    },
    { pending: "Setting value", completed: "Set value" },
  ),
  tool(
    "scroll",
    "desktop",
    "Scroll an element or window by wheel events or keystrokes.",
    {
      ...elementTarget,
      direction: z.enum(["up", "down", "left", "right"]),
      by: z.enum(["lines", "pages", "pixels"]).optional(),
      amount: z.number().int().optional(),
    },
    { pending: "Scrolling", completed: "Scrolled" },
  ),
  tool(
    "invoke_menu",
    "desktop",
    "Invoke a native application menu path such as [\"File\",\"Save\"]. Refuses missing, ambiguous, or disabled items; verify the effect afterwards.",
    { pid, window_id: windowId, path: z.array(z.string()).min(1) },
    { pending: "Invoking menu", completed: "Invoked menu" },
  ),
  tool(
    "set_window_frame",
    "desktop",
    "Move and resize a window to an exact frame, then read the geometry back.",
    {
      pid,
      window_id: windowId,
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    },
    { pending: "Setting window frame", completed: "Set window frame" },
  ),
  tool(
    "bring_to_front",
    "desktop",
    "Activate an app and leave it in the foreground. Use only when the user asked for a visible window or background delivery was refused.",
    { pid, window_id: windowId.optional() },
    { pending: "Bringing window to front", completed: "Brought window to front" },
  ),
  tool(
    "verify_state",
    "desktop",
    "Verify bounded predicates against one window, for example that an element with a label exists. Returns satisfied, unsatisfied, or unknown; unknown never means success.",
    {
      pid,
      window_id: windowId,
      expect: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe("Predicates such as {element:{selector:{label_contains:\"Saved\"},exists:true}}"),
      timeout_ms: z.number().int().optional(),
      stable_samples: z.number().int().optional(),
      include_screenshot: z.boolean().optional(),
    },
    { pending: "Verifying window state", completed: "Verified window state" },
  ),
  tool(
    "zoom",
    "desktop",
    "Capture a cropped, full-resolution image of a window region for reading small text.",
    {
      pid: pid.optional(),
      window_id: windowId,
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
    },
    { pending: "Zooming into window", completed: "Zoomed into window" },
  ),
  tool(
    "get_browser_state",
    "browser",
    "Bind a Chrome, Edge, or Electron window to its page and return a semantic snapshot with refs for browser_click and browser_type. Refs are session-scoped and expire on the next snapshot.",
    {
      pid: pid.optional(),
      window_id: windowId.optional(),
      target_id: z.string().optional(),
      tab_id: z.string().optional(),
      snapshot_format: z.string().optional(),
      query: z.string().optional(),
      scope_ref: z.string().optional(),
      continuation: z.string().optional(),
      include_screenshot: z.boolean().optional(),
    },
    { pending: "Reading browser state", completed: "Read browser state" },
  ),
  tool(
    "browser_prepare",
    "browser",
    "Prepare a driver-owned DevTools endpoint for a browser window. Attaching to a signed-in profile needs a launch grant the user configures outside bb.",
    {
      pid: pid.optional(),
      window_id: windowId.optional(),
      allow_launch: z.boolean().optional(),
    },
    { pending: "Preparing browser", completed: "Prepared browser" },
  ),
  tool(
    "browser_navigate",
    "browser",
    "Navigate a bound tab to an http, https, or about URL.",
    { ...browserTab, url: z.string() },
    { pending: "Navigating browser", completed: "Navigated browser" },
  ),
  tool(
    "browser_click",
    "browser",
    "Click a page element by ref from get_browser_state or by viewport coordinates.",
    {
      ...browserTab,
      ref: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      input_route: z.string().optional(),
    },
    { pending: "Clicking in browser", completed: "Clicked in browser" },
  ),
  tool(
    "browser_type",
    "browser",
    "Type into a page element by ref.",
    {
      ...browserTab,
      ref: z.string(),
      text: z.string(),
      mode: z.string().optional(),
      replace: z.boolean().optional(),
    },
    { pending: "Typing in browser", completed: "Typed in browser" },
  ),
  tool(
    "browser_pointer",
    "browser",
    "Hover, right-click, double-click, scroll, or drag inside a bound tab.",
    {
      ...browserTab,
      action: z.string(),
      ref: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      destination_ref: z.string().optional(),
      to_x: z.number().optional(),
      to_y: z.number().optional(),
      delta_x: z.number().optional(),
      delta_y: z.number().optional(),
      input_route: z.string().optional(),
    },
    { pending: "Pointer action in browser", completed: "Pointer action in browser" },
  ),
  tool(
    "browser_dialog",
    "browser",
    "Inspect or resolve a JavaScript alert, confirm, or prompt dialog.",
    {
      ...browserTab,
      action: z.string(),
      dialog_id: z.string().optional(),
      prompt_text: z.string().optional(),
    },
    { pending: "Handling browser dialog", completed: "Handled browser dialog" },
  ),
  tool(
    "clipboard_read",
    "clipboard",
    "List clipboard content types and optionally return the plain text.",
    { include_text: z.boolean().optional() },
    { pending: "Reading clipboard", completed: "Read clipboard" },
  ),
  tool(
    "clipboard_write",
    "clipboard",
    "Replace the clipboard with text, an image file, or a file reference.",
    {
      text: z.string().optional(),
      image_path: z.string().optional(),
      file_path: z.string().optional(),
    },
    { pending: "Writing clipboard", completed: "Wrote clipboard" },
  ),
  {
    name: "cua_call",
    upstream: null,
    group: "meta",
    description:
      "Call any Cua Driver tool by its upstream name with a JSON argument object. Use for tools without a dedicated cua_* tool (recording, cursor themes, sessions, page). Read the schema with cua_describe first.",
    parameters: z.object({
      tool: z.string().min(1).describe("Upstream tool name such as start_recording"),
      arguments: z.record(z.string(), z.unknown()).default({}),
    }),
    labels: { pending: "Calling Cua Driver", completed: "Called Cua Driver" },
  },
  {
    name: "cua_describe",
    upstream: null,
    group: "meta",
    description:
      "Return the description and JSON input schema of one Cua Driver tool, or list every available tool when tool is omitted.",
    parameters: z.object({ tool: z.string().min(1).optional() }),
    labels: { pending: "Describing Cua tool", completed: "Described Cua tool" },
  },
  {
    name: "cua_status",
    upstream: null,
    group: "meta",
    description:
      "Report whether Cua Driver is installed, running, and permitted on this thread's machine, with install and permission instructions when it is not.",
    parameters: z.object({}),
    labels: { pending: "Checking Cua Driver", completed: "Checked Cua Driver" },
  },
];

export const CATALOG_BY_NAME: ReadonlyMap<string, CatalogEntry> = new Map(
  CATALOG.map((entry) => [entry.name, entry]),
);

export function toolNamesForGroups(groups: ReadonlySet<ToolGroup>): string[] {
  return CATALOG.filter((entry) => groups.has(entry.group)).map((entry) => entry.name);
}
