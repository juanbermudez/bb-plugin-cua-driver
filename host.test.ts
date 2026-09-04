import { PassThrough } from "node:stream";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it, vi } from "vitest";
import { candidateBinaryPaths, createCuaHostEntry, mapContent, parsePermissions, type ExecResult } from "./host.js";
import type { McpChild } from "./src/mcp-client.js";

function fakeMcpServer(tools: Array<{ name: string; inputSchema: Record<string, unknown> }>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  stdin.on("data", (chunk: Buffer) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
      if (message.method === "initialize") {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } })}\n`);
      } else if (message.method === "tools/list") {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools } })}\n`);
      } else if (message.method === "tools/call") {
        const params = message.params as { name: string; arguments: Record<string, unknown> };
        calls.push(params);
        stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: `ran ${params.name}` }, { type: "image", data: "QUJD", mimeType: "image/png" }],
              isError: params.name === "fail",
              structuredContent: { echo: params.arguments },
            },
          })}\n`,
        );
      }
    }
  });
  const child: McpChild = {
    stdin,
    stdout,
    stderr: null,
    kill: vi.fn(() => {
      listeners.get("exit")?.(0);
      return true;
    }),
    once(event, listener) {
      listeners.set(event, listener);
      return this;
    },
  };
  return { child, calls };
}

function deps(overrides: Partial<Parameters<typeof createCuaHostEntry>[0]> & { installed?: boolean; server?: ReturnType<typeof fakeMcpServer> }) {
  const installed = overrides.installed ?? true;
  const server = overrides.server ?? fakeMcpServer([]);
  const exec = vi.fn(async (_command: string, args: readonly string[]): Promise<ExecResult> => {
    if (args[0] === "--version") return { code: 0, stdout: "cua-driver 0.23.2\n", stderr: "" };
    if (args[0] === "status") return { code: 0, stdout: "running", stderr: "" };
    if (args[0] === "permissions") {
      return { code: 0, stdout: JSON.stringify({ accessibility: { granted: true }, screen_recording: { granted: false } }), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unknown" };
  });
  const spawnMcp = vi.fn(() => server.child);
  const written: Array<{ path: string; content: string }> = [];
  const processes: Array<{ command: string; args: readonly string[]; child: ReturnType<typeof fakeProcess> }> = [];
  const installedRef = { current: installed };
  return {
    entry: createCuaHostEntry({
      platform: "darwin",
      env: { PATH: "/usr/bin", HOME: "/Users/test" },
      homeDir: "/Users/test",
      now: () => 1_000,
      fileExists: async (path) => installedRef.current && path === "/Users/test/.local/bin/cua-driver",
      exec,
      spawnMcp,
      fetchText: async (url) => `#!/bin/bash\necho installing from ${url}\n`,
      writeFile: async (path, content) => {
        written.push({ path, content });
      },
      spawnProcess: (command, args) => {
        const child = fakeProcess();
        processes.push({ command, args, child });
        return child;
      },
      ...overrides,
    }),
    exec,
    spawnMcp,
    server,
    written,
    processes,
    installedRef,
  };
}

function fakeProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    stdout,
    stderr,
    once(event: "exit" | "error", listener: (...args: unknown[]) => void) {
      listeners.set(event, listener);
      return this;
    },
    emitLine(line: string) {
      stdout.write(`${line}\n`);
    },
    exit(code: number) {
      listeners.get("exit")?.(code);
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("candidateBinaryPaths", () => {
  it("prefers CUA_DRIVER_PATH, then PATH, then the installer location per platform", () => {
    expect(
      candidateBinaryPaths({ platform: "darwin", env: { CUA_DRIVER_PATH: "/opt/cua", PATH: "/a:/b" }, homeDir: "/h" }),
    ).toEqual(["/opt/cua", "/a/cua-driver", "/b/cua-driver", "/h/.local/bin/cua-driver"]);
    expect(candidateBinaryPaths({ platform: "win32", env: { PATH: "C:\\x", LOCALAPPDATA: "C:\\L" }, homeDir: "C:\\U" })).toContain(
      "C:\\L\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe",
    );
  });
});

describe("parsePermissions / mapContent", () => {
  it("reads nested grant objects and tolerates unknown shapes", () => {
    expect(
      parsePermissions(
        JSON.stringify({
          permissions: { accessibility: "granted", screen_recording: false },
          direct_capture_status: "not_checked",
        }),
      ),
    ).toEqual({
      accessibility: true,
      screenRecording: false,
      directCapture: "not_checked",
    });
    expect(parsePermissions("not json")).toEqual({ accessibility: null, screenRecording: null, directCapture: null });
  });

  it("keeps images, appends structured content, and never returns empty content", () => {
    const mapped = mapContent([{ type: "image", data: "AA", mimeType: "image/jpeg" }], { a: 1 });
    expect(mapped).toEqual([
      { type: "image", data: "AA", mimeType: "image/jpeg" },
      { type: "text", text: 'structuredContent:\n{"a":1}' },
    ]);
    expect(mapContent([], null)).toEqual([{ type: "text", text: "(empty result)" }]);
  });
});

describe("cua host entry", () => {
  it("reports not installed without probing anything", async () => {
    const { entry, exec } = deps({ installed: false });
    const harness = experimental_createHostEntryHarness(entry);
    const status = await harness.experimental_call("status", { probeDaemon: true });
    expect(status).toMatchObject({ installed: false, binaryPath: null, version: null, platform: "darwin" });
    expect(exec).not.toHaveBeenCalled();
    await expect(harness.experimental_call("callTool", { name: "list_apps", arguments: {} })).rejects.toThrow(/not installed/);
    await harness.experimental_dispose();
  });

  it("probes version, service, and macOS permissions", async () => {
    const { entry } = deps({});
    const harness = experimental_createHostEntryHarness(entry);
    const status = await harness.experimental_call("status", { probeDaemon: true });
    expect(status).toMatchObject({
      installed: true,
      binaryPath: "/Users/test/.local/bin/cua-driver",
      version: "0.23.2",
      daemonRunning: true,
      permissions: { accessibility: true, screenRecording: false },
      connected: false,
    });
    await harness.experimental_dispose();
  });

  it("connects once, injects the session only when the tool accepts it, and retains the worker", async () => {
    const server = fakeMcpServer([
      { name: "click", inputSchema: { type: "object", properties: { session: { type: "string" }, pid: {} } } },
      { name: "list_apps", inputSchema: { type: "object", properties: {} } },
    ]);
    const { entry, spawnMcp } = deps({ server });
    const harness = experimental_createHostEntryHarness(entry);

    const first = await harness.experimental_call("callTool", { name: "click", arguments: { pid: 1 }, session: "bb-thr_1" });
    expect(first.content[0]).toEqual({ type: "text", text: "ran click" });
    expect(first.content[1]).toEqual({ type: "image", data: "QUJD", mimeType: "image/png" });
    expect(first.isError).toBe(false);
    await harness.experimental_call("callTool", { name: "list_apps", arguments: {}, session: "bb-thr_1" });
    const failed = await harness.experimental_call("callTool", { name: "fail", arguments: {} });
    expect(failed.isError).toBe(true);

    expect(spawnMcp).toHaveBeenCalledTimes(1);
    expect(spawnMcp).toHaveBeenCalledWith("/Users/test/.local/bin/cua-driver", ["mcp"]);
    expect(server.calls).toEqual([
      { name: "click", arguments: { pid: 1, session: "bb-thr_1" } },
      { name: "list_apps", arguments: {} },
      { name: "fail", arguments: {} },
    ]);
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(1);

    const listed = await harness.experimental_call("listTools", null);
    expect(listed.tools.map((tool) => tool.name)).toEqual(["click", "list_apps"]);
    const status = await harness.experimental_call("status", { probeDaemon: false });
    expect(status).toMatchObject({ connected: true, toolCount: 2, daemonRunning: null });

    expect(await harness.experimental_call("disconnect", null)).toEqual({ disconnected: true });
    expect(server.child.kill).toHaveBeenCalled();
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    await harness.experimental_dispose();
  });

  it("runs the official installer from a temp script, streams output, and re-resolves the binary", async () => {
    const { entry, written, processes, installedRef } = deps({ installed: false });
    const harness = experimental_createHostEntryHarness(entry);

    const started = await harness.experimental_call("install", null);
    expect(started).toMatchObject({ running: true, ok: null, step: "download" });
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await flush();
    expect(written[0]?.path).toMatch(/cua-driver-install\.sh$/);
    expect(written[0]?.content).toContain("https://cua.ai/driver/install.sh");
    expect(processes[0]).toMatchObject({ command: "/bin/bash", args: [written[0]!.path] });

    processes[0]!.child.emitLine("Installed cua-driver 0.23.2");
    installedRef.current = true;
    processes[0]!.child.exit(0);
    await flush();
    expect(processes[1]).toMatchObject({ command: "open", args: ["-n", "-g", "-a", "CuaDriver", "--args", "serve"] });
    processes[1]!.child.exit(0);
    await flush();

    const state = await harness.experimental_call("installState", null);
    expect(state).toMatchObject({ running: false, ok: true, exitCode: 0, step: "done" });
    expect(state.tail).toContain("Installed cua-driver 0.23.2");
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    expect(await harness.experimental_call("status", { probeDaemon: false })).toMatchObject({ installed: true });
    await harness.experimental_dispose();
  });

  it("marks a failed installer run and keeps the machine uninstalled", async () => {
    const { entry, processes } = deps({ installed: false });
    const harness = experimental_createHostEntryHarness(entry);
    await harness.experimental_call("install", null);
    await flush();
    processes[0]!.child.emitLine("curl: (6) Could not resolve host");
    processes[0]!.child.exit(6);
    await flush();
    const state = await harness.experimental_call("installState", null);
    expect(state).toMatchObject({ running: false, ok: false, exitCode: 6, step: "failed" });
    expect(state.tail.at(-1)).toMatch(/installer exited with 6/);
    await harness.experimental_dispose();
  });

  it("requests macOS permissions through the installed binary", async () => {
    const { entry, exec } = deps({});
    exec.mockImplementationOnce(async () => ({ code: 0, stdout: "", stderr: "" }));
    const harness = experimental_createHostEntryHarness(entry);
    const result = await harness.experimental_call("grantPermissions", null);
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/Approve the macOS prompts/);
    expect(exec).toHaveBeenCalledWith("/Users/test/.local/bin/cua-driver", ["permissions", "grant"], expect.any(Number));
    await harness.experimental_dispose();
  });
});
