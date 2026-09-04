import { execFile, spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { createInterface } from "node:readline";
import {
  experimental_defineHostEntry,
  type ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk/host";
import {
  IDLE_INSTALL_STATE,
  hostContract,
  hostSignals,
  type CatalogTool,
  type DriverStatus,
  type InstallState,
  type ToolCallResult,
  type ToolContentPart,
} from "./src/contract.js";
import { McpStdioClient, type McpChild, type McpContentPart } from "./src/mcp-client.js";

export const PLUGIN_VERSION = "0.1.0";
const BINARY_CACHE_MS = 60_000;
const PROBE_TIMEOUT_MS = 8_000;
const GRANT_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_DISCONNECT_MS = 10 * 60_000;
const STRUCTURED_TEXT_LIMIT = 200_000;
const INSTALL_TAIL_LINES = 80;

export const INSTALL_SCRIPT_URLS = {
  posix: "https://cua.ai/driver/install.sh",
  windows: "https://cua.ai/driver/install.ps1",
} as const;

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ProcessChild {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: "exit" | "error", listener: (...args: unknown[]) => void): this;
}

export interface HostDependencies {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly idleDisconnectMs?: number;
  now(): number;
  fileExists(path: string): Promise<boolean>;
  exec(command: string, args: readonly string[], timeoutMs: number): Promise<ExecResult>;
  spawnMcp(command: string, args: readonly string[]): McpChild;
  fetchText(url: string, signal: AbortSignal): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  spawnProcess(command: string, args: readonly string[]): ProcessChild;
}

interface InstallContext {
  experimental_retainWorker(): ExperimentalHostWorkerLease;
  experimental_paths: { tempDir: string };
  lifecycle: { signal: AbortSignal };
}

export function candidateBinaryPaths(deps: Pick<HostDependencies, "platform" | "env" | "homeDir">): string[] {
  const isWindows = deps.platform === "win32";
  const path = isWindows ? win32 : posix;
  const executable = isWindows ? "cua-driver.exe" : "cua-driver";
  const candidates: string[] = [];
  const explicit = deps.env.CUA_DRIVER_PATH;
  if (explicit !== undefined && explicit.length > 0) candidates.push(explicit);
  const pathEntries = (deps.env.PATH ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
  for (const entry of pathEntries) candidates.push(path.join(entry, executable));
  if (isWindows) {
    const localAppData = deps.env.LOCALAPPDATA;
    if (localAppData !== undefined && localAppData.length > 0) {
      candidates.push(path.join(localAppData, "Programs", "Cua", "cua-driver", "bin", executable));
    }
  } else {
    candidates.push(path.join(deps.homeDir, ".local", "bin", executable));
  }
  return [...new Set(candidates)];
}

function normalizePlatform(platform: NodeJS.Platform): DriverStatus["platform"] {
  return platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "other";
}

function findBoolean(value: unknown, keyPattern: RegExp, depth = 0): boolean | null {
  if (depth > 4 || typeof value !== "object" || value === null) return null;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (keyPattern.test(key)) {
      if (typeof entry === "boolean") return entry;
      if (typeof entry === "string") {
        if (/^(granted|authorized|true|yes|ok)$/i.test(entry)) return true;
        if (/^(denied|not_granted|false|no|missing)$/i.test(entry)) return false;
      }
      if (typeof entry === "object" && entry !== null) {
        const nested = findBoolean(entry, /^(granted|authorized|status)$/i, depth + 1);
        if (nested !== null) return nested;
      }
    }
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const nested = findBoolean(entry, keyPattern, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

function findString(value: unknown, keyPattern: RegExp, depth = 0): string | null {
  if (depth > 4 || typeof value !== "object" || value === null) return null;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (keyPattern.test(key) && typeof entry === "string") return entry;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const nested = findString(entry, keyPattern, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

export function parsePermissions(stdout: string): DriverStatus["permissions"] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return {
      accessibility: findBoolean(parsed, /accessibility/i),
      screenRecording: findBoolean(parsed, /screen[_-]?recording/i),
      directCapture: findString(parsed, /direct[_-]?capture[_-]?status/i),
    };
  } catch {
    return { accessibility: null, screenRecording: null, directCapture: null };
  }
}

export function mapContent(parts: McpContentPart[], structured: unknown): ToolContentPart[] {
  const mapped: ToolContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      mapped.push({ type: "text", text: part.text });
    } else if (part.type === "image" && typeof part.data === "string") {
      mapped.push({ type: "image", data: part.data, mimeType: part.mimeType ?? "image/png" });
    } else {
      mapped.push({ type: "text", text: JSON.stringify(part) });
    }
  }
  if (structured !== null && structured !== undefined) {
    const json = JSON.stringify(structured);
    mapped.push({
      type: "text",
      text:
        json.length > STRUCTURED_TEXT_LIMIT
          ? `structuredContent (truncated):\n${json.slice(0, STRUCTURED_TEXT_LIMIT)}`
          : `structuredContent:\n${json}`,
    });
  }
  if (mapped.length === 0) mapped.push({ type: "text", text: "(empty result)" });
  return mapped;
}

export function createCuaHostEntry(deps: HostDependencies) {
  const idleDisconnectMs = deps.idleDisconnectMs ?? DEFAULT_IDLE_DISCONNECT_MS;
  let binaryCache: { path: string | null; at: number } | null = null;
  let client: McpStdioClient | null = null;
  let connecting: Promise<McpStdioClient> | null = null;
  let tools: CatalogTool[] = [];
  let lease: ExperimentalHostWorkerLease | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let lifecycleBound = false;
  let emitConnection: ((connected: boolean, reason: string) => void) | null = null;
  let emitInstall: ((state: InstallState) => void) | null = null;
  let installState: InstallState = { ...IDLE_INSTALL_STATE, tail: [] };

  async function resolveBinary(): Promise<string | null> {
    if (binaryCache !== null && deps.now() - binaryCache.at < BINARY_CACHE_MS) {
      return binaryCache.path;
    }
    let found: string | null = null;
    for (const candidate of candidateBinaryPaths(deps)) {
      if (await deps.fileExists(candidate)) {
        found = candidate;
        break;
      }
    }
    binaryCache = { path: found, at: deps.now() };
    return found;
  }

  function clearIdleTimer(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdleTimer(): void {
    clearIdleTimer();
    idleTimer = setTimeout(() => disconnect("idle timeout"), idleDisconnectMs);
  }

  function disconnect(reason: string): boolean {
    clearIdleTimer();
    const active = client;
    client = null;
    tools = [];
    const activeLease = lease;
    lease = null;
    void activeLease?.dispose();
    if (active === null) return false;
    active.close(reason);
    return true;
  }

  async function connect(
    context: { experimental_retainWorker(): ExperimentalHostWorkerLease },
  ): Promise<McpStdioClient> {
    if (client !== null && !client.isClosed) {
      armIdleTimer();
      return client;
    }
    if (connecting !== null) return connecting;
    connecting = (async () => {
      const binary = await resolveBinary();
      if (binary === null) {
        throw new Error(
          "cua-driver is not installed on this machine. Install it from https://cua.ai/docs/how-to-guides/driver/install and run `cua-driver doctor`.",
        );
      }
      const child = deps.spawnMcp(binary, ["mcp"]);
      const next = new McpStdioClient(child);
      next.onClose((reason) => {
        if (client === next) {
          client = null;
          tools = [];
          clearIdleTimer();
          const activeLease = lease;
          lease = null;
          void activeLease?.dispose();
          emitConnection?.(false, reason);
        }
      });
      try {
        await next.initialize("bb-plugin-cua-driver", PLUGIN_VERSION);
        tools = await next.listTools();
      } catch (error) {
        const stderr = next.recentStderr;
        next.close("initialize failed");
        throw new Error(
          `cua-driver mcp did not start: ${error instanceof Error ? error.message : String(error)}${
            stderr.length > 0 ? `\n${stderr}` : ""
          }`,
        );
      }
      client = next;
      lease ??= context.experimental_retainWorker();
      armIdleTimer();
      emitConnection?.(true, "connected");
      return next;
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  function bindLifecycle(signal: AbortSignal): void {
    if (lifecycleBound) return;
    lifecycleBound = true;
    signal.addEventListener("abort", () => disconnect("worker disposed"), { once: true });
  }

  async function probeStatus(probeDaemon: boolean): Promise<DriverStatus> {
    const platform = normalizePlatform(deps.platform);
    const checkedAt = new Date(deps.now()).toISOString();
    const binary = await resolveBinary();
    const base: DriverStatus = {
      platform,
      installed: binary !== null,
      binaryPath: binary,
      version: null,
      daemonRunning: null,
      permissions: null,
      connected: client !== null && !client.isClosed,
      toolCount: tools.length > 0 ? tools.length : null,
      error: null,
      checkedAt,
    };
    if (binary === null) return base;
    const errors: string[] = [];
    const version = await deps.exec(binary, ["--version"], PROBE_TIMEOUT_MS).catch(
      (error: unknown): ExecResult => ({
        code: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      }),
    );
    if (version.code === 0) {
      base.version = version.stdout.trim().replace(/^cua-driver\s+/i, "") || null;
    } else {
      errors.push(`--version failed: ${version.stderr.trim() || String(version.code)}`);
    }
    if (probeDaemon) {
      const status = await deps.exec(binary, ["status"], PROBE_TIMEOUT_MS).catch(
        (): ExecResult => ({ code: null, stdout: "", stderr: "" }),
      );
      base.daemonRunning = status.code === 0;
    }
    if (platform === "darwin") {
      const permissions = await deps
        .exec(binary, ["permissions", "status", "--json"], PROBE_TIMEOUT_MS)
        .catch((): ExecResult => ({ code: null, stdout: "", stderr: "" }));
      base.permissions =
        permissions.code === 0
          ? parsePermissions(permissions.stdout)
          : { accessibility: null, screenRecording: null };
    }
    base.error = errors.length > 0 ? errors.join("; ") : null;
    return base;
  }

  function pushInstallLine(line: string, step?: string): void {
    const tail = [...installState.tail, line].slice(-INSTALL_TAIL_LINES);
    installState = { ...installState, tail, ...(step === undefined ? {} : { step }) };
    emitInstall?.(installState);
  }

  function runStep(command: string, args: readonly string[], step: string): Promise<number | null> {
    return new Promise((resolve, reject) => {
      pushInstallLine(`$ ${[command, ...args].join(" ")}`, step);
      let child: ProcessChild;
      try {
        child = deps.spawnProcess(command, args);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      for (const stream of [child.stdout, child.stderr]) {
        if (stream === null) continue;
        createInterface({ input: stream }).on("line", (line) => {
          if (line.trim().length > 0) pushInstallLine(line);
        });
      }
      child.once("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
      child.once("exit", (code) => resolve(typeof code === "number" ? code : null));
    });
  }

  async function runInstall(context: InstallContext): Promise<void> {
    const installLease = context.experimental_retainWorker();
    const isWindows = deps.platform === "win32";
    try {
      const url = isWindows ? INSTALL_SCRIPT_URLS.windows : INSTALL_SCRIPT_URLS.posix;
      pushInstallLine(`Downloading ${url}`, "download");
      const script = await deps.fetchText(url, context.lifecycle.signal);
      const scriptPath = (isWindows ? win32 : posix).join(
        context.experimental_paths.tempDir,
        isWindows ? "cua-driver-install.ps1" : "cua-driver-install.sh",
      );
      await deps.writeFile(scriptPath, script);
      const code = isWindows
        ? await runStep("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], "install")
        : await runStep("/bin/bash", [scriptPath], "install");
      if (code !== 0) {
        installState = { ...installState, exitCode: code };
        throw new Error(`installer exited with ${String(code)}`);
      }
      binaryCache = null;
      const binary = await resolveBinary();
      if (binary === null) {
        throw new Error("installer finished but cua-driver was not found on PATH or in the installer location");
      }
      if (isWindows) {
        await runStep(binary, ["autostart", "kick"], "autostart").catch(() => null);
      } else if (deps.platform === "darwin") {
        await runStep("open", ["-n", "-g", "-a", "CuaDriver", "--args", "serve"], "start-service").catch(() => null);
      }
      installState = {
        ...installState,
        running: false,
        ok: true,
        exitCode: 0,
        step: "done",
        finishedAt: new Date(deps.now()).toISOString(),
      };
      pushInstallLine("Install finished. On macOS, grant Accessibility and Screen Recording next.");
    } catch (error) {
      installState = {
        ...installState,
        running: false,
        ok: false,
        step: "failed",
        finishedAt: new Date(deps.now()).toISOString(),
      };
      pushInstallLine(`Install failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      void installLease.dispose();
    }
  }

  function startInstall(context: InstallContext): InstallState {
    if (installState.running) return installState;
    if (normalizePlatform(deps.platform) === "other") {
      throw new Error(`Cua Driver has no installer for platform ${deps.platform}.`);
    }
    installState = {
      running: true,
      ok: null,
      exitCode: null,
      step: "starting",
      tail: [],
      startedAt: new Date(deps.now()).toISOString(),
      finishedAt: null,
    };
    emitInstall?.(installState);
    void runInstall(context);
    return installState;
  }

  function acceptsSession(name: string): boolean {
    const descriptor = tools.find((entry) => entry.name === name);
    if (descriptor === undefined) return true;
    const properties = descriptor.inputSchema.properties;
    return typeof properties === "object" && properties !== null && "session" in properties;
  }

  return experimental_defineHostEntry({
    contract: hostContract,
    experimental_signals: hostSignals,
    handlers: {
      install(_input, context) {
        bindLifecycle(context.lifecycle.signal);
        emitInstall ??= (state) => {
          void context.experimental_emitSignal("installChanged", state);
        };
        return startInstall(context);
      },
      installState() {
        return installState;
      },
      async grantPermissions(_input, context) {
        bindLifecycle(context.lifecycle.signal);
        if (deps.platform !== "darwin") {
          return { ok: false, output: "Permission grants are only needed on macOS." };
        }
        const binary = await resolveBinary();
        if (binary === null) return { ok: false, output: "cua-driver is not installed." };
        const result = await deps.exec(binary, ["permissions", "grant"], GRANT_TIMEOUT_MS);
        const output = `${result.stdout}${result.stderr}`.trim().slice(-4000);
        if (output.length > 0) return { ok: result.code === 0, output };
        return {
          ok: result.code === 0,
          output:
            result.code === 0
              ? "Requested. Approve the macOS prompts, then fully relaunch CuaDriver.app."
              : `permissions grant exited with ${String(result.code)}`,
        };
      },
      async status(input, context) {
        bindLifecycle(context.lifecycle.signal);
        return probeStatus(input.probeDaemon);
      },
      async listTools(_input, context) {
        bindLifecycle(context.lifecycle.signal);
        emitConnection ??= (connected, reason) => {
          void context.experimental_emitSignal("connectionChanged", { connected, reason });
        };
        await connect(context);
        return { tools };
      },
      async callTool(input, context): Promise<ToolCallResult> {
        bindLifecycle(context.lifecycle.signal);
        emitConnection ??= (connected, reason) => {
          void context.experimental_emitSignal("connectionChanged", { connected, reason });
        };
        const active = await connect(context);
        const args: Record<string, unknown> = { ...input.arguments };
        if (input.session !== undefined && acceptsSession(input.name) && !("session" in args)) {
          args.session = input.session;
        }
        const result = await active.callTool(input.name, args, context.signal);
        armIdleTimer();
        return {
          content: mapContent(result.content, result.structuredContent),
          isError: result.isError,
          ...(result.structuredContent !== null ? { structured: result.structuredContent } : {}),
        };
      },
      disconnect() {
        return { disconnected: disconnect("disconnect requested") };
      },
    },
    dispose() {
      disconnect("host entry disposed");
    },
  });
}

function execCommand(command: string, args: readonly string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code)
              : null;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export default createCuaHostEntry({
  platform: process.platform,
  env: process.env,
  homeDir: homedir(),
  now: () => Date.now(),
  fileExists: (path) => access(path).then(() => true, () => false),
  exec: execCommand,
  spawnMcp(command, args) {
    return spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  },
  async fetchText(url, signal) {
    const response = await fetch(url, { signal, redirect: "follow" });
    if (!response.ok) throw new Error(`download failed: HTTP ${String(response.status)}`);
    return response.text();
  },
  writeFile: (path, content) => writeFile(path, content, { mode: 0o700 }),
  spawnProcess(command, args) {
    return spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, CI: "1" },
    });
  },
});
