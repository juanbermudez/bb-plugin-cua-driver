/**
 * Live end-to-end checks against the Cua Driver installed on this machine.
 * They run the plugin's own server code in the SDK's fake bb host, wired to its
 * real host entry, so every call takes the same path a bb thread's would:
 * agent tool → server → host RPC → `cua-driver mcp` → the daemon.
 *
 * Skipped unless CUA_LIVE=1. They drive real apps in the background:
 *   CUA_LIVE=1 npx vitest run live.test.ts
 * The browser check also needs a Chrome started with remote debugging and its
 * own profile, and its pid:
 *   open -g -na "Google Chrome" --args --remote-debugging-port=9555 \
 *     --user-data-dir=/tmp/cua-live-profile --no-first-run about:blank
 *   CUA_LIVE=1 CUA_LIVE_CHROME_PID=<pid> npx vitest run live.test.ts
 */
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { afterAll, describe, expect, it } from "vitest";
import hostEntry from "./host.js";
import plugin from "./server.js";

const LIVE = process.env.CUA_LIVE === "1";
const CHROME_PID = Number(process.env.CUA_LIVE_CHROME_PID ?? "");

type Json = Record<string, unknown>;

function textOf(result: PluginAgentToolResult): string {
  if (typeof result === "string") return result;
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** The host appends Cua Driver's structuredContent as a trailing JSON text block. */
function structuredOf(result: PluginAgentToolResult): Json {
  const text = textOf(result);
  const marker = text.lastIndexOf("structuredContent:\n");
  if (marker < 0) return {};
  try {
    return JSON.parse(text.slice(marker + "structuredContent:\n".length)) as Json;
  } catch {
    return {};
  }
}

const disposers: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const dispose of disposers.reverse()) await dispose();
}, 30_000);

async function livePlugin(settings: Record<string, string | boolean> = {}) {
  const controller = new AbortController();
  const context = {
    lifecycle: { signal: controller.signal },
    signal: controller.signal,
    experimental_retainWorker: () => ({ dispose: async () => undefined }),
    experimental_emitSignal: async () => undefined,
    experimental_paths: { tempDir: mkdtempSync(join(tmpdir(), "cua-live-")) },
  };
  const handlers = hostEntry.handlers as unknown as Record<string, (input: unknown, context: unknown) => unknown>;
  const { bb, harness } = createFakePluginHost({
    pluginId: "cua-driver",
    settings,
    agentSkillIds: ["cua-computer-use"],
    sdk: {
      threads: { get: async () => ({ ...makeThreadResponse({ id: "thr_live" }), environmentId: "env_live" }) },
      environments: { get: async () => ({ id: "env_live", hostId: "this-mac" }) },
      hosts: { list: async () => [{ id: "this-mac", name: "this Mac", status: "connected" }] },
      providers: { list: async () => [{ id: "claude-code", displayName: "Claude Code", available: true }] },
      plugins: { updateSettings: async () => ({}) },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      const handler = handlers[method];
      if (handler === undefined) throw new Error(`no host handler ${method}`);
      return handler(input, context);
    },
  });
  await plugin(bb);
  disposers.push(() => {
    handlers.disconnect?.(null, context);
    controller.abort();
  });
  const call = (tool: string, args: Json) => harness.behavior.callAgentTool(tool, args);
  return { call };
}

describe.skipIf(!LIVE)("live against the installed Cua Driver", () => {
  it("computes 6 × 7 in Calculator through the plugin's tools", async () => {
    const { call } = await livePlugin();
    const launched = structuredOf(await call("cua_launch_app", { bundle_id: "com.apple.calculator" }));
    const pid = launched.pid as number;
    let windowId = (launched.windows as Array<{ window_id: number }> | undefined)?.[0]?.window_id;
    if (windowId === undefined) {
      const windows = structuredOf(await call("cua_list_windows", { pid }));
      windowId = (windows.windows as Array<{ window_id: number }>)[0]!.window_id;
    }
    try {
      // The clear key reads "All Clear" on a zero display and "Clear" otherwise.
      const keys: Array<[string, RegExp]> = [
        ["Clear", /^(all )?clear$/i],
        ["6", /^6$/],
        ["Multiply", /^multiply$/i],
        ["7", /^7$/],
        ["Equals", /^equals$/i],
      ];
      for (const [query, pattern] of keys) {
        // A freshly launched app can refuse AX presses for a moment (-25204,
        // "cannot complete"); re-snapshot and retry as Cua's agent loop advises.
        let clickedText = "";
        let pressed = false;
        for (let attempt = 0; attempt < 10 && !pressed; attempt += 1) {
          const state = structuredOf(await call("cua_get_window_state", { pid, window_id: windowId, query }));
          const elements = (state.elements ?? []) as Array<{ element_token: string; label?: string; title?: string; description?: string }>;
          const target = elements.find((element) => [element.label, element.title, element.description].some((value) => pattern.test(value ?? "")));
          if (target !== undefined) {
            const clicked = await call("cua_click", { pid, window_id: windowId, element_token: target.element_token });
            clickedText = textOf(clicked);
            pressed = typeof clicked === "string" || !clicked.isError;
          }
          if (!pressed) await new Promise((resolve) => setTimeout(resolve, 300));
        }
        expect(pressed, `click ${query}: ${clickedText.slice(0, 300)}`).toBe(true);
      }
      const final = await call("cua_get_window_state", { pid, window_id: windowId });
      expect(textOf(final)).toMatch(/\b42\b/);
    } finally {
      await call("cua_call", { tool: "kill_app", arguments: { pid } });
    }
  }, 120_000);

  it.skipIf(!Number.isInteger(CHROME_PID) || CHROME_PID <= 0)(
    "downloads a file from a page in an attached Chrome profile",
    async () => {
      const server: Server = createServer((_request, response) => {
        response.setHeader("content-type", "text/html");
        response.end(`<!doctype html><title>Live report</title><h1>Live report</h1>
<button id="get" type="button">Get report</button>
<script>
document.getElementById("get").addEventListener("click", () => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["VIN,Year\\n1HGCM82633A004352,2019\\n"], { type: "text/csv" }));
  link.download = "report.csv";
  document.body.appendChild(link);
  link.click();
});
</script>`);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      disposers.push(
        () =>
          new Promise<void>((resolve) => {
            // Chrome keeps its connection alive; close it so the server can stop.
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      );
      const address = server.address();
      const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/`;

      const { call } = await livePlugin({ signedInBrowserProfiles: true });
      const windows = structuredOf(await call("cua_list_windows", { pid: CHROME_PID }));
      const window = (windows.windows as Array<{ window_id: number; is_on_screen: boolean }>).find((entry) => entry.is_on_screen)
        ?? (windows.windows as Array<{ window_id: number }>)[0]!;
      const prepared = textOf(
        await call("cua_browser_prepare", { pid: CHROME_PID, window_id: window.window_id, strategy: { kind: "existing_profile" } }),
      );
      expect(prepared).toMatch(/endpoint available/);

      const bound = structuredOf(await call("cua_get_browser_state", { pid: CHROME_PID, window_id: window.window_id }));
      const target_id = bound.target_id as string;
      const tab_id = (bound.tabs as Array<{ tab_id: string }>)[0]!.tab_id;
      await call("cua_browser_navigate", { target_id, tab_id, url });

      let ref: string | undefined;
      for (let attempt = 0; attempt < 10 && ref === undefined; attempt += 1) {
        const snapshot = structuredOf(
          await call("cua_get_browser_state", { target_id, tab_id, snapshot_format: "semantic_v2", query: "Get report" }),
        );
        ref = ((snapshot.refs ?? []) as Array<{ name: string; ref: string }>).find((entry) => entry.name === "Get report")?.ref;
        if (ref === undefined) await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(ref).toBeDefined();

      const destination = realpathSync(mkdtempSync(join(tmpdir(), "cua-live-download-")));
      const downloaded = textOf(await call("cua_browser_download", { target_id, tab_id, ref, destination_root: destination }));
      expect(downloaded).toMatch(/download completed/);
      const [file] = readdirSync(destination);
      expect(readFileSync(join(destination, file!), "utf8")).toContain("1HGCM82633A004352");
    },
    120_000,
  );
});
