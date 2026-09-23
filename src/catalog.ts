import { z } from "zod";

import { UPSTREAM_SCHEMAS } from "./upstream-schemas.generated.js";

export const TOOL_GROUPS = ["desktop", "browser", "clipboard", "meta"] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/**
 * Arguments the plugin supplies itself. `session` carries the thread's Cua
 * session label, so an agent never names (or borrows) another thread's session.
 */
export const PLUGIN_MANAGED_ARGUMENTS: readonly string[] = ["session"];

export interface CatalogEntry {
  name: string;
  /** The Cua Driver tool this forwards to; null for the plugin's own meta tools. */
  upstream: string | null;
  group: ToolGroup;
  description: string;
  /**
   * The JSON schema providers see. Upstream tools advertise Cua Driver's own
   * schema (minus plugin-managed arguments) and forward arguments untouched,
   * so Cua Driver stays the single validator and a driver update can never be
   * silently narrowed by a stale copy here.
   */
  inputSchema: Record<string, unknown>;
  /** Only the meta tools validate in the plugin; upstream tools pass through. */
  parameters: z.ZodObject<z.ZodRawShape> | null;
  labels: { pending: string; completed: string };
}

/** Cua Driver's schema as agents should see it: without the arguments the plugin owns. */
export function advertisedSchema(schema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const properties =
    typeof schema.properties === "object" && schema.properties !== null
      ? { ...(schema.properties as Record<string, unknown>) }
      : {};
  for (const key of PLUGIN_MANAGED_ARGUMENTS) delete properties[key];
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string" && !PLUGIN_MANAGED_ARGUMENTS.includes(key))
    : [];
  const next: Record<string, unknown> = { ...schema, type: "object", properties };
  if (required.length > 0) next.required = required;
  else delete next.required;
  return next;
}

/** bb's cap on a schema that configure() returns for one tool. */
const SCHEMA_OVERRIDE_MAX_BYTES = 128 * 1024;

function hasReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasReference);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => key === "$ref" || key === "$dynamicRef" || hasReference(child));
}

/**
 * A machine's live schema as a per-session override, or null to keep the
 * bundled one. bb rejects an override that is too large or has a recursive
 * reference, and one rejected override drops every tool the plugin selected
 * for that session, so anything doubtful falls back. Arguments are forwarded
 * untouched either way.
 */
export function overridableSchema(schema: Readonly<Record<string, unknown>>): Record<string, unknown> | null {
  const advertised = advertisedSchema(schema);
  if (hasReference(advertised)) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(advertised)).byteLength;
  return bytes > SCHEMA_OVERRIDE_MAX_BYTES ? null : advertised;
}

function tool(
  upstream: string,
  group: ToolGroup,
  description: string,
  labels: { pending: string; completed: string },
): CatalogEntry {
  const schema = UPSTREAM_SCHEMAS[upstream];
  if (schema === undefined) {
    throw new Error(`No bundled Cua Driver schema for ${upstream}; run npm run sync:schemas.`);
  }
  return {
    name: `cua_${upstream}`,
    upstream,
    group,
    description,
    inputSchema: advertisedSchema(schema),
    parameters: null,
    labels,
  };
}

function meta(
  name: string,
  description: string,
  parameters: z.ZodObject<z.ZodRawShape>,
  labels: { pending: string; completed: string },
): CatalogEntry {
  return {
    name,
    upstream: null,
    group: "meta",
    description,
    inputSchema: z.toJSONSchema(parameters, { io: "input" }) as Record<string, unknown>,
    parameters,
    labels,
  };
}

export const CATALOG: readonly CatalogEntry[] = [
  tool("list_apps", "desktop", "List running and installed desktop apps with pid and bundle id or launch path. Start here to find a target app.", { pending: "Listing desktop apps", completed: "Listed desktop apps" }),
  tool("list_windows", "desktop", "List top-level windows with window_id, title, bounds, and z_index (higher is frontmost). Filter by pid.", { pending: "Listing windows", completed: "Listed windows" }),
  tool("launch_app", "desktop", "Launch an app in the background without stealing focus. macOS uses bundle_id; Windows and Linux use name or a launch path. Returns pid and windows. Confirm with the user before launching apps they did not ask for.", { pending: "Launching app", completed: "Launched app" }),
  tool("get_window_state", "desktop", "Snapshot one window: accessibility tree with element_token per element plus a screenshot. Call before every element action; tokens expire on the next snapshot.", { pending: "Reading window state", completed: "Read window state" }),
  tool("get_desktop_state", "desktop", "Capture the full primary display at native resolution. Use only for desktop-scope work with no single target window.", { pending: "Capturing desktop", completed: "Captured desktop" }),
  tool("get_screen_size", "desktop", "Return the logical display size in points and the backing scale factor.", { pending: "Reading screen size", completed: "Read screen size" }),
  tool("get_accessibility_tree", "desktop", "Lightweight desktop overview: running apps and on-screen windows with bounds, z-order and owner pid. Cheaper than a screenshot for finding a target window.", { pending: "Reading desktop overview", completed: "Read desktop overview" }),
  tool("click", "desktop", "Click an element by element_token (preferred) or window-local x,y. Background delivery by default. Check effect and escalation in the result before retrying.", { pending: "Clicking", completed: "Clicked" }),
  tool("double_click", "desktop", "Double-click an element or window-local coordinates.", { pending: "Double-clicking", completed: "Double-clicked" }),
  tool("right_click", "desktop", "Right-click an element or window-local coordinates to open a context menu.", { pending: "Right-clicking", completed: "Right-clicked" }),
  tool("drag", "desktop", "Press, drag, and release between two window-local points.", { pending: "Dragging", completed: "Dragged" }),
  tool("type_text", "desktop", "Insert text into a focused or targeted element. Element form sets the value through accessibility; x,y form clicks to focus first, which fixes web and Electron inputs.", { pending: "Typing text", completed: "Typed text" }),
  tool("press_key", "desktop", "Press one key (for example Return, Escape, Tab, a) with optional modifiers, targeted at a pid or element.", { pending: "Pressing key", completed: "Pressed key" }),
  tool("hotkey", "desktop", "Press a key combination such as [\"cmd\",\"c\"] or [\"ctrl\",\"s\"] against a pid without changing focus.", { pending: "Pressing hotkey", completed: "Pressed hotkey" }),
  tool("set_value", "desktop", "Set the whole value of a non-text control (popup button, checkbox, slider) through accessibility. Also the reliable commit path for minimized windows.", { pending: "Setting value", completed: "Set value" }),
  tool("scroll", "desktop", "Scroll an element or window by wheel events or keystrokes; `by` takes line or page.", { pending: "Scrolling", completed: "Scrolled" }),
  tool("invoke_menu", "desktop", "Invoke a native application menu path such as [\"File\",\"Save\"]. Refuses missing, ambiguous, or disabled items; verify the effect afterwards.", { pending: "Invoking menu", completed: "Invoked menu" }),
  tool("set_window_frame", "desktop", "Move and resize a window to an exact frame, then read the geometry back.", { pending: "Setting window frame", completed: "Set window frame" }),
  tool("bring_to_front", "desktop", "Activate an app and leave it in the foreground. Use only when the user asked for a visible window or background delivery was refused.", { pending: "Bringing window to front", completed: "Brought window to front" }),
  tool("verify_state", "desktop", "Verify bounded predicates against one window, for example that an element with a label exists. Returns satisfied, unsatisfied, or unknown; unknown never means success.", { pending: "Verifying window state", completed: "Verified window state" }),
  tool("zoom", "desktop", "Capture a cropped, full-resolution image of a window region for reading small text.", { pending: "Zooming into window", completed: "Zoomed into window" }),
  tool("get_browser_state", "browser", "Bind a Chrome, Edge, or Electron window to its page and return a semantic snapshot with refs for browser_click and browser_type. Refs are session-scoped and expire on the next snapshot.", { pending: "Reading browser state", completed: "Read browser state" }),
  tool("browser_prepare", "browser", "Prepare a DevTools endpoint for a browser. With allow_launch it can start a separate, isolated driver-owned Chromium; attaching to a signed-in profile needs the Signed-in browser profiles plugin setting.", { pending: "Preparing browser", completed: "Prepared browser" }),
  tool("browser_navigate", "browser", "Navigate a bound tab to an http, https, or about URL.", { pending: "Navigating browser", completed: "Navigated browser" }),
  tool("browser_click", "browser", "Click a page element by ref from get_browser_state or by viewport coordinates.", { pending: "Clicking in browser", completed: "Clicked in browser" }),
  tool("browser_type", "browser", "Type into a page element by ref.", { pending: "Typing in browser", completed: "Typed in browser" }),
  tool("browser_pointer", "browser", "Hover, right-click, double-click, scroll, or drag inside a bound tab.", { pending: "Pointer action in browser", completed: "Pointer action in browser" }),
  tool("browser_dialog", "browser", "Inspect or resolve a JavaScript alert, confirm, or prompt dialog.", { pending: "Handling browser dialog", completed: "Handled browser dialog" }),
  tool("browser_download", "browser", "Trigger one download from a live page ref and save it inside an approved, existing absolute directory. Confirm the destination with the user.", { pending: "Downloading in browser", completed: "Downloaded in browser" }),
  tool("browser_set_input_files", "browser", "Attach explicit absolute local files to a live <input type=file> ref. Only upload files the user asked you to upload.", { pending: "Attaching files in browser", completed: "Attached files in browser" }),
  tool("clipboard_read", "clipboard", "List clipboard content types and optionally return the plain text.", { pending: "Reading clipboard", completed: "Read clipboard" }),
  tool("clipboard_write", "clipboard", "Replace the clipboard with text, an image file, or a file reference.", { pending: "Writing clipboard", completed: "Wrote clipboard" }),
  meta(
    "cua_call",
    "Call any Cua Driver tool by its upstream name with a JSON argument object. Use for tools without a dedicated cua_* tool (recording, cursor themes, sessions, page). Read the schema with cua_describe first.",
    z.object({
      tool: z.string().min(1).describe("Upstream tool name such as start_recording"),
      arguments: z.record(z.string(), z.unknown()).default({}),
    }),
    { pending: "Calling Cua Driver", completed: "Called Cua Driver" },
  ),
  meta(
    "cua_describe",
    "Return the description and JSON input schema of one Cua Driver tool, or list every available tool when tool is omitted.",
    z.object({ tool: z.string().min(1).optional() }),
    { pending: "Describing Cua tool", completed: "Described Cua tool" },
  ),
  meta(
    "cua_status",
    "Report whether Cua Driver is installed, running, up to date, and permitted on this thread's machine, with install and permission instructions when it is not.",
    z.object({}),
    { pending: "Checking Cua Driver", completed: "Checked Cua Driver" },
  ),
];

export const CATALOG_BY_NAME: ReadonlyMap<string, CatalogEntry> = new Map(
  CATALOG.map((entry) => [entry.name, entry]),
);

export function toolNamesForGroups(groups: ReadonlySet<ToolGroup>): string[] {
  return CATALOG.filter((entry) => groups.has(entry.group)).map((entry) => entry.name);
}
