import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import plugin from "./server.js";
import type { DriverStatus, ToolCallResult } from "./src/contract.js";

function context(providerId: string, hostId = "host_1") {
  return {
    thread: { id: "thr_1", title: null, parentThreadId: null, sourceThreadId: null },
    project: { id: "proj_1", kind: "standard" as const, name: "demo", gitRemoteUrl: null },
    environment: { id: "env_1", name: null, path: "/repo", workspaceProvisionType: "unmanaged" as const, branchName: null },
    host: { id: hostId, name: "laptop" },
    provider: { id: providerId, model: "m", capabilities: { supportsNativeUserQuestion: false } },
    origin: { kind: null, pluginId: null },
  };
}

function structured(result: PluginAgentToolResult): { content: Array<{ type: string; text?: string }>; isError?: boolean } {
  if (typeof result === "string") throw new Error(`expected structured result, got ${result}`);
  return result;
}

interface StateView {
  providers: Array<{ id: string; decision: string }>;
  hosts: Array<{ id: string; driver: { installed: boolean } | null }>;
}

function names(configuration: { tools: Array<{ name: string }> }): string[] {
  return configuration.tools.map((tool) => tool.name);
}

function readyStatus(overrides: Partial<DriverStatus> = {}): DriverStatus {
  return {
    platform: "darwin",
    installed: true,
    binaryPath: "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    version: "0.23.2",
    daemonRunning: true,
    permissions: { accessibility: true, screenRecording: true, directCapture: "not_checked" },
    connected: false,
    latestVersion: null,
    updateAvailable: null,
    toolCount: 56,
    error: null,
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function load(options: {
  settings?: Record<string, string | boolean>;
  status?: DriverStatus;
  toolResult?: ToolCallResult;
  /** Consumed in order before falling back to toolResult. */
  toolResults?: ToolCallResult[];
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
} = {}) {
  const hostCalls: Array<{ method: string; input: unknown; hostId: string }> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "cua-driver",
    settings: options.settings ?? {},
    agentSkillIds: ["cua-computer-use"],
    sdk: {
      threads: { get: async () => ({ ...makeThreadResponse({ id: "thr_1" }), environmentId: "env_1" }) },
      environments: { get: async () => ({ id: "env_1", hostId: "host_9" }) },
      hosts: { list: async () => [{ id: "host_9", name: "laptop", status: "connected" }] },
      providers: {
        list: async () => [
          { id: "codex", displayName: "Codex", available: true },
          { id: "claude-code", displayName: "Claude Code", available: true },
          { id: "pi", displayName: "Pi", available: false },
        ],
      },
      plugins: { updateSettings: async () => ({}) },
    },
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      hostCalls.push({ method, input, hostId });
      if (method === "callTool") {
        return options.toolResults?.shift() ?? options.toolResult ?? { content: [{ type: "text", text: "ok" }], isError: false };
      }
      if (method === "status") {
        return options.status ?? readyStatus();
      }
      if (method === "listTools") {
        return { tools: options.tools ?? [{ name: "click", description: "Click\nmore", inputSchema: { type: "object" } }] };
      }
      if (method === "install" || method === "installState") {
        return { running: method === "install", ok: null, exitCode: null, step: "starting", tail: [], startedAt: null, finishedAt: null };
      }
      if (method === "grantPermissions") return { ok: true, output: "Requested." };
      return { disconnected: false };
    },
  });
  await plugin(bb);
  return { bb, harness, hostCalls };
}

describe("cua-driver server", () => {
  it("offers cua tools to claude-code and pi but not to codex in prefer-native mode", async () => {
    const { harness } = await load();
    const claude = await harness.behavior.resolveAgentConfiguration(context("claude-code"));
    expect(names(claude)).toContain("cua_get_window_state");
    expect(names(claude)).toContain("cua_browser_click");
    expect(claude.skills).toEqual(["cua-computer-use"]);
    expect(claude.instructions).toMatch(/readiness .* unknown|call cua_status/i);

    const codex = await harness.behavior.resolveAgentConfiguration(context("codex"));
    expect(codex.tools).toEqual([]);
    expect(codex.skills).toEqual([]);

    const pi = await harness.behavior.resolveAgentConfiguration(context("pi"));
    expect(names(pi).length).toBeGreaterThan(20);
  });

  it("honours cua-everywhere, off, and per-provider overrides from the CLI", async () => {
    const { harness } = await load({ settings: { mode: "cua-everywhere" } });
    expect(names(await harness.behavior.resolveAgentConfiguration(context("codex")))).toContain("cua_click");

    const set = await harness.behavior.runCli(["policy", "codex", "native"]);
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toMatch(/codex\s+native\s+override=native/);
    expect(names(await harness.behavior.resolveAgentConfiguration(context("codex")))).toEqual([]);

    await harness.behavior.setSettings({ mode: "off" });
    expect(names(await harness.behavior.resolveAgentConfiguration(context("claude-code")))).toEqual([]);
    const rejected = await harness.behavior.runCli(["policy", "codex", "bogus"]);
    expect(rejected.exitCode).toBe(1);
  });

  it("drops tool groups when their settings are off", async () => {
    const { harness } = await load({ settings: { browserTools: false, clipboardTools: false, passthroughTools: false } });
    const tools = names(await harness.behavior.resolveAgentConfiguration(context("pi")));
    expect(tools).not.toContain("cua_browser_click");
    expect(tools).not.toContain("cua_clipboard_read");
    expect(tools).not.toContain("cua_call");
    expect(tools).toContain("cua_status");
    expect(tools).toContain("cua_click");
  });

  it("routes a tool call to the thread's host with a per-thread session label", async () => {
    const { harness, hostCalls } = await load();
    const result = await harness.behavior.callAgentTool("cua_click", { pid: 4, element_token: "s1:2" });
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }], isError: false });
    const toolCalls = hostCalls.filter((call) => call.method === "callTool");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      method: "callTool",
      input: { name: "click", arguments: { pid: 4, element_token: "s1:2" } },
      hostId: "host_9",
    });
    expect((toolCalls[0]!.input as { session: string }).session).toMatch(/^bb-/);

    await harness.behavior.callAgentTool("cua_call", { tool: "start_recording", arguments: { output_dir: "/tmp/x" } });
    expect(hostCalls.filter((call) => call.method === "callTool")[1]!.input).toMatchObject({
      name: "start_recording",
      arguments: { output_dir: "/tmp/x" },
    });

    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thread-test" }), lastAssistantText: null });
    await vi.waitFor(() => expect(hostCalls.some((call) => (call.input as { name: string }).name === "end_session")).toBe(true));

    const firstSession = (toolCalls[0]!.input as { session: string }).session;
    await harness.behavior.callAgentTool("cua_click", { pid: 4, element_token: "s1:3" });
    const resumed = hostCalls.filter(
      (call) => call.method === "callTool" && (call.input as { name: string }).name === "click",
    );
    expect((resumed[1]!.input as { session: string }).session).not.toBe(firstSession);
  });

  it("explains a missing driver through cua_status and the rpc state", async () => {
    const { harness, hostCalls } = await load({
      status: readyStatus({
        installed: false,
        binaryPath: null,
        version: null,
        daemonRunning: null,
        permissions: null,
        toolCount: null,
      }),
    });
    const status = structured(await harness.behavior.callAgentTool("cua_status", {}));
    expect(status.isError).toBeFalsy();
    expect(status.content[0]).toMatchObject({ type: "text" });
    expect(status.content[0]?.text).toMatch(/NOT installed/);

    const state = (await harness.behavior.callRpc("getState", null)) as StateView;
    expect(state.providers.map((provider) => [provider.id, provider.decision])).toEqual([
      ["codex", "native"],
      ["claude-code", "cua"],
      ["pi", "cua"],
    ]);
    expect(state.hosts[0]).toMatchObject({ id: "host_9", driver: { installed: false } });

    const blocked = structured(await harness.behavior.callAgentTool("cua_click", { pid: 4, element_token: "s1:2" }));
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]?.text).toContain("[Open Computer Use settings](/settings/plugins/cua-driver)");
    expect(blocked.content[0]?.text).toMatch(/Install Cua Driver/);
    expect(hostCalls.some((call) => call.method === "callTool")).toBe(false);

    const described = structured(await harness.behavior.callAgentTool("cua_describe", {}));
    expect(described.content[0]?.text).toBe("click: Click");
  });

  it("blocks desktop actions before macOS permissions are ready and links to setup", async () => {
    const { harness, hostCalls } = await load({
      status: readyStatus({ permissions: { accessibility: true, screenRecording: false, directCapture: "not_checked" } }),
    });

    const result = structured(await harness.behavior.callAgentTool("cua_click", { pid: 4, element_token: "s1:2" }));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Screen Recording/);
    expect(result.content[0]?.text).toContain("[Open Computer Use settings](/settings/plugins/cua-driver)");
    expect(result.content[0]?.text).toMatch(/Grant macOS permissions/);
    expect(hostCalls.some((call) => call.method === "callTool")).toBe(false);
  });

  it("turns an upstream permission failure into the same guided recovery", async () => {
    const { harness, hostCalls } = await load({
      toolResult: {
        content: [{ type: "text", text: "permissions_pending: Screen Recording permission is still pending" }],
        isError: true,
        structured: { exit_code: 75 },
      },
    });

    const result = structured(await harness.behavior.callAgentTool("cua_click", { pid: 4, element_token: "s1:2" }));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("[Open Computer Use settings](/settings/plugins/cua-driver)");
    expect(result.content[0]?.text).toMatch(/Driver detail:.*permissions_pending/);
    expect(hostCalls.some((call) => call.method === "callTool")).toBe(true);
    expect(hostCalls.filter((call) => call.method === "status")).toHaveLength(2);
  });

  it("forwards upstream arguments untouched but keeps the session plugin-owned", async () => {
    const { harness, hostCalls } = await load();
    await harness.behavior.callAgentTool("cua_click", {
      pid: 4,
      element_token: "s1:2",
      from_zoom: true,
      target: { window_id: 9 },
      session: "someone-elses-session",
    });
    const call = hostCalls.find((entry) => entry.method === "callTool")!.input as {
      arguments: Record<string, unknown>;
      session: string;
      grants: string[];
    };
    expect(call.arguments).toEqual({ pid: 4, element_token: "s1:2", from_zoom: true, target: { window_id: 9 } });
    expect(call.session).toMatch(/^bb-/);
    expect(call.grants).toEqual([]);
  });

  it("retries once with a fresh session after Cua Driver ended the old one", async () => {
    const ended: ToolCallResult = {
      content: [{ type: "text", text: "session 'bb-thr' has ended; tool call 'click' was rejected." }],
      isError: true,
    };
    const { harness, hostCalls } = await load({ toolResults: [ended] });
    const result = await harness.behavior.callAgentTool("cua_click", { pid: 4, element_token: "s1:2" });
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }], isError: false });
    const sessions = hostCalls
      .filter((entry) => entry.method === "callTool")
      .map((entry) => (entry.input as { session: string }).session);
    expect(sessions).toHaveLength(2);
    expect(sessions[1]).not.toBe(sessions[0]);
  });

  it("forgets a machine's sessions when its Cua connection drops", async () => {
    const { harness, hostCalls } = await load();
    await harness.behavior.callAgentTool("cua_click", { pid: 4, element_token: "s1:2" });
    await harness.behavior.experimental_emitHostSignal("host_9", "connectionChanged", {
      connected: false,
      reason: "idle timeout",
    });
    await harness.behavior.callAgentTool("cua_click", { pid: 4, element_token: "s1:3" });
    const sessions = hostCalls
      .filter((entry) => entry.method === "callTool")
      .map((entry) => (entry.input as { session: string }).session);
    expect(sessions[1]).not.toBe(sessions[0]);
  });

  it("asks Cua Driver for signed-in browser profiles only when the setting is on", async () => {
    const { harness, hostCalls } = await load();
    await harness.behavior.callAgentTool("cua_get_browser_state", {});
    await harness.behavior.setSettings({ signedInBrowserProfiles: true });
    await harness.behavior.callAgentTool("cua_get_browser_state", {});
    const grants = hostCalls
      .filter((entry) => entry.method === "callTool")
      .map((entry) => (entry.input as { grants: string[] }).grants);
    expect(grants).toEqual([[], ["existing-profile"]]);
  });

  it("refuses to attach to a signed-in browser profile while the setting is off", async () => {
    const { harness, hostCalls } = await load();
    const refused = structured(
      await harness.behavior.callAgentTool("cua_browser_prepare", { pid: 7, window_id: 3, strategy: { kind: "existing_profile" } }),
    );
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toMatch(/Signed-in browser profiles/);
    expect(hostCalls.some((entry) => entry.method === "callTool")).toBe(false);

    await harness.behavior.setSettings({ signedInBrowserProfiles: true });
    await harness.behavior.callAgentTool("cua_browser_prepare", { pid: 7, window_id: 3, strategy: { kind: "existing_profile" } });
    expect(hostCalls.find((entry) => entry.method === "callTool")?.input).toMatchObject({
      name: "browser_prepare",
      grants: ["existing-profile"],
    });
  });

  it("advertises a machine's own tool schemas once its driver version differs from the bundled one", async () => {
    const { harness, hostCalls } = await load({
      status: readyStatus({ version: "0.29.0" }),
      tools: [
        {
          name: "click",
          description: "Click",
          inputSchema: {
            type: "object",
            properties: { pid: { type: "integer" }, brand_new_arg: { type: "string" }, session: { type: "string" } },
            required: ["pid", "session"],
          },
        },
      ],
    });
    await harness.behavior.callAgentTool("cua_click", { pid: 4 });
    expect(hostCalls.some((entry) => entry.method === "listTools")).toBe(true);
    // The machine's tools/list is read in the background after the first call.
    await vi.waitFor(async () => {
      const configuration = await harness.behavior.resolveAgentConfiguration(context("claude-code", "host_9"));
      const click = configuration.tools.find((tool) => tool.name === "cua_click");
      expect(click?.inputSchema).toMatchObject({
        properties: { pid: { type: "integer" }, brand_new_arg: { type: "string" } },
        required: ["pid"],
      });
      expect(JSON.stringify(click?.inputSchema)).not.toContain("session");
    });
  });

  it("keeps the bundled schema for a live one bb would refuse, and still overrides the rest", async () => {
    const { harness } = await load({
      status: readyStatus({ version: "0.29.0" }),
      tools: [
        { name: "click", description: "Click", inputSchema: { type: "object", properties: { node: { $ref: "#" } } } },
        { name: "scroll", description: "Scroll", inputSchema: { type: "object", properties: { brand_new_arg: { type: "string" } } } },
      ],
    });
    await harness.behavior.callAgentTool("cua_click", { pid: 4 });
    await vi.waitFor(async () => {
      const configuration = await harness.behavior.resolveAgentConfiguration(context("claude-code", "host_9"));
      const schemaOf = (name: string) => configuration.tools.find((tool) => tool.name === name)?.inputSchema as { properties: object };
      expect(Object.keys(schemaOf("cua_scroll").properties)).toEqual(["brand_new_arg"]);
      expect(Object.keys(schemaOf("cua_click").properties)).toContain("element_token");
    });
  });

  it("keeps the bundled schemas when the machine runs the version they came from", async () => {
    const { harness } = await load({ status: readyStatus({ version: "0.28.2" }) });
    await harness.behavior.callAgentTool("cua_click", { pid: 4 });
    const configuration = await harness.behavior.resolveAgentConfiguration(context("claude-code", "host_9"));
    const click = configuration.tools.find((tool) => tool.name === "cua_click");
    expect(Object.keys((click?.inputSchema as { properties: object }).properties)).toContain("element_token");
  });

  it("updates Cua Driver only when a newer release exists and the user confirms", async () => {
    const current = await load({ status: readyStatus({ latestVersion: "0.28.2", updateAvailable: false }) });
    const latest = await current.harness.behavior.runCli(["update"]);
    expect(latest).toMatchObject({ exitCode: 0 });
    expect(latest.stdout).toMatch(/already the newest/);

    const behind = await load({ status: readyStatus({ version: "0.23.2", latestVersion: "0.28.2", updateAvailable: true }) });
    const unconfirmed = await behind.harness.behavior.runCli(["update"]);
    expect(unconfirmed.exitCode).toBe(1);
    expect(unconfirmed.stderr).toMatch(/0\.23\.2.*0\.28\.2.*--yes/s);
    expect(behind.hostCalls.some((entry) => entry.method === "install")).toBe(false);

    await behind.harness.behavior.runCli(["update", "--yes"]);
    expect(behind.hostCalls.some((entry) => entry.method === "install")).toBe(true);
  });

  it("requires --yes for the installer and mirrors install progress from host signals", async () => {
    const { harness, hostCalls } = await load();
    const refused = await harness.behavior.runCli(["install"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/--yes/);
    expect(hostCalls.some((call) => call.method === "install")).toBe(false);

    const started = (await harness.behavior.callRpc("installDriver", { hostId: "host_9" })) as { running: boolean };
    expect(started.running).toBe(true);
    expect(hostCalls.at(-1)).toMatchObject({ method: "install", hostId: "host_9" });

    await harness.behavior.experimental_emitHostSignal(
      "host_9",
      "installChanged",
      { running: true, ok: null, exitCode: null, step: "install", tail: ["$ /bin/bash x.sh", "Installing"], startedAt: null, finishedAt: null },
    );
    let state = (await harness.behavior.callRpc("getState", null)) as { hosts: Array<{ install: { running: boolean; tail: string[] } }> };
    expect(state.hosts[0]?.install).toMatchObject({ running: true, tail: ["$ /bin/bash x.sh", "Installing"] });

    await harness.behavior.experimental_emitHostSignal(
      "host_9",
      "installChanged",
      { running: false, ok: true, exitCode: 0, step: "done", tail: ["done"], startedAt: null, finishedAt: null },
    );
    await vi.waitFor(() => expect(hostCalls.filter((call) => call.method === "status").length).toBeGreaterThan(0));
    state = (await harness.behavior.callRpc("getState", null)) as typeof state;
    expect(state.hosts[0]?.install).toMatchObject({ running: false });

    const grant = (await harness.behavior.callRpc("grantPermissions", { hostId: "host_9" })) as { ok: boolean };
    expect(grant.ok).toBe(true);
    expect(hostCalls.some((call) => call.method === "grantPermissions")).toBe(true);
  });
});
