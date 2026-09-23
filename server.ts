import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CATALOG,
  CATALOG_BY_NAME,
  PLUGIN_MANAGED_ARGUMENTS,
  overridableSchema,
  toolNamesForGroups,
  type CatalogEntry,
  type ToolGroup,
} from "./src/catalog.js";
import {
  IDLE_INSTALL_STATE,
  catalogToolSchema,
  driverStatusSchema,
  hostContract,
  hostSignals,
  installStateSchema,
  type DriverGrant,
  type DriverStatus,
  type InstallState,
  type ToolCallResult,
} from "./src/contract.js";
import {
  DEFAULT_POLICY,
  PROVIDER_OVERRIDES,
  ROUTING_MODES,
  describeDecision,
  hasNativeComputerUse,
  normalizePolicy,
  resolveProviderDecision,
  type ProviderOverride,
  type RoutingMode,
  type RoutingPolicy,
} from "./src/policy.js";
import { UPSTREAM_DRIVER_VERSION } from "./src/upstream-schemas.generated.js";

const OVERRIDES_KEY = "policy-overrides";
const STATUS_KEY_PREFIX = "driver-status:";
const SKILL_NAME = "cua-computer-use";
const REALTIME_CHANNEL = "state-changed";
const SESSION_LABEL_MAX = 125;
const STATUS_FRESH_MS = 30_000;
const SETTINGS_PATH = "/settings/plugins/cua-driver";

export const INSTALL_INSTRUCTIONS = [
  "Install Cua Driver on the machine that runs this thread:",
  "  macOS/Linux: /bin/bash -c \"$(curl -fsSL https://cua.ai/driver/install.sh)\"",
  "  Windows:     irm https://cua.ai/driver/install.ps1 | iex",
  "Then run `cua-driver doctor`. On macOS also run `cua-driver permissions grant` and approve Accessibility and Screen Recording.",
  "Docs: https://cua.ai/docs/how-to-guides/driver/install",
].join("\n");

const providerViewSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    available: z.boolean(),
    native: z.boolean(),
    override: z.enum(PROVIDER_OVERRIDES),
    decision: z.enum(["cua", "native", "off"]),
    decisionLabel: z.string(),
  })
  .strict();

const hostViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.enum(["connected", "disconnected"]),
    driver: driverStatusSchema.nullable(),
    install: installStateSchema,
  })
  .strict();

const stateSchema = z
  .object({
    mode: z.enum(ROUTING_MODES),
    groups: z.object({ browser: z.boolean(), clipboard: z.boolean(), passthrough: z.boolean() }).strict(),
    providers: z.array(providerViewSchema),
    hosts: z.array(hostViewSchema),
    toolNames: z.array(z.string()),
  })
  .strict();

export const rpcContract = defineRpcContract({
  getState: { input: z.null(), output: stateSchema },
  setMode: { input: z.object({ mode: z.enum(ROUTING_MODES) }).strict(), output: stateSchema },
  setOverride: {
    input: z.object({ providerId: z.string().min(1), override: z.enum(PROVIDER_OVERRIDES) }).strict(),
    output: stateSchema,
  },
  refreshStatus: {
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: driverStatusSchema,
  },
  listTools: {
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: z.object({ tools: z.array(catalogToolSchema) }).strict(),
  },
  installDriver: {
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: installStateSchema,
  },
  installState: {
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: installStateSchema,
  },
  grantPermissions: {
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), output: z.string() }).strict(),
  },
});

type State = z.infer<typeof stateSchema>;

interface SettingsSnapshot {
  mode: RoutingMode;
  browserTools: boolean;
  clipboardTools: boolean;
  passthroughTools: boolean;
  signedInBrowserProfiles: boolean;
  sessionPrefix: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionLabel(prefix: string, threadId: string): string {
  const raw = `${prefix}-${threadId}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  return raw.slice(0, SESSION_LABEL_MAX);
}

function missingMacPermissions(status: DriverStatus): string[] {
  if (status.platform !== "darwin" || !status.installed) return [];
  const missing: string[] = [];
  if (status.permissions?.accessibility !== true) missing.push("Accessibility");
  if (status.permissions?.screenRecording !== true) missing.push("Screen Recording");
  return missing;
}

function readinessLine(status: DriverStatus | null): string {
  if (status === null) {
    return `Cua Driver readiness on this machine is unknown; call cua_status before the first desktop action. Setup: ${SETTINGS_PATH}`;
  }
  if (!status.installed) return `Cua Driver is NOT installed on this machine. ${INSTALL_INSTRUCTIONS}`;
  const parts = [`Cua Driver ${status.version ?? "(unknown version)"} is installed.`];
  const missing = missingMacPermissions(status);
  if (missing.length > 0) {
    parts.push(
      `macOS permissions are missing or unconfirmed: ${missing.join(", ")}. Open ${SETTINGS_PATH}, expand this machine, and select Grant macOS permissions.`,
    );
  }
  if (status.daemonRunning === false) parts.push("The driver service was not running at last check; the first call starts it on demand.");
  if (status.updateAvailable === true && status.latestVersion !== null) {
    parts.push(`Cua Driver ${status.latestVersion} is available; tell the user they can update from ${SETTINGS_PATH} or with \`bb cua update --yes\`.`);
  }
  return parts.join(" ");
}

function setupGuidance(status: DriverStatus, hostId: string): string | null {
  if (!status.installed) {
    return [
      "Computer Use setup is required because Cua Driver is not installed on this machine.",
      `[Open Computer Use settings](${SETTINGS_PATH}), expand this machine, and select **Install Cua Driver**.`,
      `CLI alternative: \`bb cua install --yes --host ${hostId}\`. Retry the tool after the checklist shows Ready.`,
    ].join("\n\n");
  }
  const missing = missingMacPermissions(status);
  if (missing.length === 0) return null;
  return [
    `Computer Use setup is required. macOS permissions are missing or unconfirmed: **${missing.join(", ")}**.`,
    `[Open Computer Use settings](${SETTINGS_PATH}), expand this machine, and select **Grant macOS permissions**. Approve the system prompts; a one-time direct-capture prompt may also appear on the first screenshot.`,
    `CLI alternative: \`bb cua grant --host ${hostId}\`. Retry the tool after the checklist shows Ready.`,
  ].join("\n\n");
}

function toolResultText(result: ToolCallResult): string {
  const content = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  if (result.structured === undefined) return content;
  try {
    return `${content}\n${JSON.stringify(result.structured)}`;
  } catch {
    return content;
  }
}

/**
 * What reaches Cua Driver. Meta tools validate their own small schemas; every
 * upstream tool forwards the agent's object untouched (minus arguments the
 * plugin owns), so Cua Driver is the single validator of its own API.
 */
export function forwardableArguments(
  entry: CatalogEntry,
  raw: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (entry.parameters !== null) {
    const parsed = entry.parameters.safeParse(raw ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        error: `Invalid arguments for ${entry.name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`,
      };
    }
    return { ok: true, value: parsed.data as Record<string, unknown> };
  }
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `Arguments for ${entry.name} must be a JSON object.` };
  }
  const value: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of PLUGIN_MANAGED_ARGUMENTS) delete value[key];
  return { ok: true, value };
}

/** True when a browser_prepare call asks to attach to a person's own signed-in profile. */
export function requestsExistingProfile(tool: string, args: Readonly<Record<string, unknown>>): boolean {
  if (tool !== "browser_prepare") return false;
  const strategy = args.strategy;
  return typeof strategy === "object" && strategy !== null && (strategy as { kind?: unknown }).kind === "existing_profile";
}

/** Cua Driver ends a session with its transport; reusing the label is then refused. */
export function isEndedSessionFailure(result: ToolCallResult): boolean {
  return result.isError && /session '[^']*' has ended/i.test(toolResultText(result));
}

function isPermissionFailure(result: ToolCallResult): boolean {
  if (!result.isError) return false;
  return /permissions?_pending|permissions? (?:required|denied)|accessibility|screen[_ -]?recording|direct[_ -]?capture/i.test(
    toolResultText(result),
  );
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    mode: {
      type: "select",
      label: "Routing mode",
      description:
        "prefer-native: providers with their own computer use (Codex) keep it, everyone else gets Cua. cua-everywhere: Cua Driver for all providers. off: no Cua tools.",
      options: [...ROUTING_MODES],
      default: DEFAULT_POLICY.mode,
    },
    browserTools: {
      type: "boolean",
      label: "Browser tools",
      description: "Expose typed Chrome, Edge, and Electron page tools (get_browser_state, browser_click, browser_type, ...).",
      default: true,
    },
    clipboardTools: {
      type: "boolean",
      label: "Clipboard tools",
      description: "Expose clipboard_read and clipboard_write.",
      default: true,
    },
    passthroughTools: {
      type: "boolean",
      label: "Passthrough tools",
      description: "Expose cua_call and cua_describe so agents can reach every upstream tool, including recording and cursor themes.",
      default: true,
    },
    signedInBrowserProfiles: {
      type: "boolean",
      label: "Signed-in browser profiles",
      description:
        "Let browser tools attach to an existing, signed-in Chrome or Edge window. On macOS this restarts Cua Driver with --grant existing-profile. Turning it off blocks those attaches at once; the running service keeps the grant until it restarts (cua-driver stop).",
      default: false,
    },
    sessionPrefix: {
      type: "string",
      label: "Session label prefix",
      description: "Each active bb thread run gets its own Cua session label beginning with <prefix>-<threadId>, shown in the agent cursor badge.",
      default: "bb",
    },
  });

  function toSnapshot(values: {
    mode: string;
    browserTools: boolean;
    clipboardTools: boolean;
    passthroughTools: boolean;
    signedInBrowserProfiles: boolean;
    sessionPrefix: string;
  }): SettingsSnapshot {
    return {
      mode: ROUTING_MODES.includes(values.mode as RoutingMode) ? (values.mode as RoutingMode) : DEFAULT_POLICY.mode,
      browserTools: values.browserTools,
      clipboardTools: values.clipboardTools,
      passthroughTools: values.passthroughTools,
      signedInBrowserProfiles: values.signedInBrowserProfiles,
      sessionPrefix: values.sessionPrefix.trim().length > 0 ? values.sessionPrefix.trim() : "bb",
    };
  }

  let snapshot: SettingsSnapshot = toSnapshot(await settings.get());
  settings.onChange((next) => {
    snapshot = toSnapshot(next);
    bb.realtime.publish(REALTIME_CHANNEL, { reason: "settings" });
  });

  let overrides = normalizePolicy({
    mode: snapshot.mode,
    overrides: await bb.storage.kv.get<unknown>(OVERRIDES_KEY),
  }).overrides;
  const statusCache = new Map<string, DriverStatus>();
  const statusRefreshedAt = new Map<string, number>();
  const installByHost = new Map<string, InstallState>();
  const hostByThread = new Map<string, string>();
  const activeSessions = new Map<string, { hostId: string; label: string }>();
  const sessionEpoch = Date.now().toString(36);
  let sessionCounter = 0;
  /** tools/list as each machine reported it, keyed by host, for per-session schemas. */
  const liveSchemas = new Map<string, { version: string | null; schemas: Map<string, Record<string, unknown>> }>();

  function grants(): DriverGrant[] {
    return snapshot.signedInBrowserProfiles ? ["existing-profile"] : [];
  }

  /** A dropped connection ended every session it carried; mint new labels next time. */
  function forgetHostSessions(hostId: string): void {
    for (const [threadId, session] of activeSessions) {
      if (session.hostId === hostId) activeSessions.delete(threadId);
    }
  }

  function rememberSchemas(hostId: string, tools: ReadonlyArray<{ name: string; inputSchema: Record<string, unknown> }>): void {
    liveSchemas.set(hostId, {
      version: statusCache.get(hostId)?.version ?? null,
      schemas: new Map(
        tools.flatMap((tool) => {
          const schema = overridableSchema(tool.inputSchema);
          return schema === null ? [] : [[tool.name, schema] as const];
        }),
      ),
    });
  }

  async function listHostTools(hostId: string, signal?: AbortSignal) {
    const result = await host.call("listTools", { grants: grants() }, { hostId, ...(signal ? { signal } : {}) });
    rememberSchemas(hostId, result.tools);
    return result;
  }

  for (const key of await bb.storage.kv.list(STATUS_KEY_PREFIX)) {
    const parsed = driverStatusSchema.safeParse(await bb.storage.kv.get<unknown>(key));
    if (parsed.success) statusCache.set(key.slice(STATUS_KEY_PREFIX.length), parsed.data);
  }

  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });

  host.experimental_onSignal("connectionChanged", ({ hostId, payload }) => {
    if (!payload.connected) forgetHostSessions(hostId);
    const cached = statusCache.get(hostId);
    if (cached !== undefined) {
      const next = { ...cached, connected: payload.connected };
      statusCache.set(hostId, next);
      void bb.storage.kv.set(`${STATUS_KEY_PREFIX}${hostId}`, next);
    }
    bb.realtime.publish(REALTIME_CHANNEL, { reason: "connection", hostId });
  });
  host.experimental_onSignal("installChanged", ({ hostId, payload }) => {
    const previous = installByHost.get(hostId);
    installByHost.set(hostId, payload);
    bb.realtime.publish(REALTIME_CHANNEL, { reason: "install", hostId });
    if (previous?.running === true && !payload.running) {
      bb.log.info(`Cua Driver install on host ${hostId} finished: ${payload.ok ? "ok" : "failed"}`);
      void refreshStatus(hostId, true).catch((error: unknown) =>
        bb.log.warn(`status refresh after install failed on ${hostId}: ${errorMessage(error)}`),
      );
    }
  });
  host.experimental_onWorkerExit(({ hostId }) => {
    forgetHostSessions(hostId);
    const cached = statusCache.get(hostId);
    if (cached !== undefined) statusCache.set(hostId, { ...cached, connected: false });
    const install = installByHost.get(hostId);
    if (install?.running === true) {
      installByHost.set(hostId, {
        ...install,
        running: false,
        ok: false,
        step: "failed",
        tail: [...install.tail, "The host worker exited while the installer was running."],
      });
    }
    bb.realtime.publish(REALTIME_CHANNEL, { reason: "worker-exit", hostId });
  });

  function policy(): RoutingPolicy {
    return { mode: snapshot.mode, overrides };
  }

  function enabledGroups(): Set<ToolGroup> {
    const groups = new Set<ToolGroup>(["desktop"]);
    if (snapshot.browserTools) groups.add("browser");
    if (snapshot.clipboardTools) groups.add("clipboard");
    if (snapshot.passthroughTools) groups.add("meta");
    return groups;
  }

  function enabledToolNames(): string[] {
    const names = toolNamesForGroups(enabledGroups());
    return snapshot.passthroughTools ? names : [...names, "cua_status"];
  }

  async function refreshStatus(hostId: string, probeDaemon: boolean, signal?: AbortSignal): Promise<DriverStatus> {
    const status = await host.call("status", { probeDaemon }, { hostId, ...(signal ? { signal } : {}) });
    statusCache.set(hostId, status);
    statusRefreshedAt.set(hostId, Date.now());
    await bb.storage.kv.set(`${STATUS_KEY_PREFIX}${hostId}`, status);
    bb.realtime.publish(REALTIME_CHANNEL, { reason: "status", hostId });
    return status;
  }

  async function resolveHostId(threadId: string): Promise<string> {
    const cached = hostByThread.get(threadId);
    if (cached !== undefined) return cached;
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.environmentId === null) {
      throw new Error("This thread has no environment, so there is no machine to drive.");
    }
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    hostByThread.set(threadId, environment.hostId);
    if (hostByThread.size > 512) {
      const oldest = hostByThread.keys().next().value;
      if (oldest !== undefined) hostByThread.delete(oldest);
    }
    return environment.hostId;
  }

  async function primaryHostId(): Promise<string> {
    const hosts = await bb.sdk.hosts.list();
    const connected = hosts.find((entry) => entry.status === "connected") ?? hosts[0];
    if (connected === undefined) throw new Error("No bb host is available.");
    return connected.id;
  }

  function sessionFor(threadId: string, hostId: string): string {
    const active = activeSessions.get(threadId);
    if (active?.hostId === hostId) return active.label;
    sessionCounter += 1;
    const label = sessionLabel(snapshot.sessionPrefix, `${threadId}-${sessionEpoch}-${sessionCounter.toString(36)}`);
    activeSessions.set(threadId, { hostId, label });
    return label;
  }

  async function callDriver(
    hostId: string,
    name: string,
    args: Record<string, unknown>,
    options: { threadId?: string; signal?: AbortSignal },
  ): Promise<ToolCallResult> {
    const send = (label: string | undefined) =>
      host.call(
        "callTool",
        { name, arguments: args, grants: grants(), ...(label === undefined ? {} : { session: label }) },
        { hostId, ...(options.signal ? { signal: options.signal } : {}) },
      );
    if (options.threadId === undefined) return send(undefined);
    const result = await send(sessionFor(options.threadId, hostId));
    if (!isEndedSessionFailure(result)) return result;
    // The driver ended this thread's session (for example after an idle
    // disconnect); a fresh label starts a new one. Retry exactly once.
    activeSessions.delete(options.threadId);
    return send(sessionFor(options.threadId, hostId));
  }

  function failure(text: string): ToolCallResult {
    return { content: [{ type: "text", text }], isError: true };
  }

  async function statusForTool(hostId: string, signal?: AbortSignal): Promise<DriverStatus> {
    const cached = statusCache.get(hostId);
    const refreshedAt = statusRefreshedAt.get(hostId);
    if (cached !== undefined && refreshedAt !== undefined && Date.now() - refreshedAt < STATUS_FRESH_MS) return cached;
    return refreshStatus(hostId, true, signal);
  }

  async function callConfiguredDriver(
    hostId: string,
    name: string,
    args: Record<string, unknown>,
    options: { threadId?: string; signal?: AbortSignal },
  ): Promise<ToolCallResult> {
    if (!snapshot.signedInBrowserProfiles && requestsExistingProfile(name, args)) {
      return failure(
        `Attaching to a signed-in browser profile is turned off. Ask the user to turn on **Signed-in browser profiles** in [Computer Use settings](${SETTINGS_PATH}) if they want this, or work in a separate browser.`,
      );
    }
    const status = await statusForTool(hostId, options.signal);
    const guidance = setupGuidance(status, hostId);
    if (guidance !== null) return failure(guidance);

    const result = await callDriver(hostId, name, args, options);
    if (!isPermissionFailure(result)) return result;

    const refreshed = await refreshStatus(hostId, true, options.signal).catch(() => status);
    const recovery =
      setupGuidance(refreshed, hostId) ??
      [
        "Computer Use was blocked by a system permission while using Cua Driver.",
        `[Open Computer Use settings](${SETTINGS_PATH}), expand this machine, run **Grant macOS permissions**, and retry after the checklist shows Ready.`,
        `CLI alternative: \`bb cua grant --host ${hostId}\`.`,
      ].join("\n\n");
    return failure(`${recovery}\n\nDriver detail: ${toolResultText(result).trim().slice(0, 500)}`);
  }

  async function executeCatalogTool(
    toolName: string,
    args: Record<string, unknown>,
    context: { threadId: string; signal: AbortSignal },
  ): Promise<ToolCallResult> {
    const entry = CATALOG_BY_NAME.get(toolName);
    if (entry === undefined) return failure(`Unknown tool ${toolName}.`);
    let hostId: string;
    try {
      hostId = await resolveHostId(context.threadId);
    } catch (error) {
      return failure(errorMessage(error));
    }
    try {
      if (entry.name === "cua_status") {
        const status = await refreshStatus(hostId, true, context.signal);
        return { content: [{ type: "text", text: `${readinessLine(status)}\n\n${JSON.stringify(status, null, 2)}` }], isError: false };
      }
      if (entry.name === "cua_describe") {
        const { tools } = await listHostTools(hostId, context.signal);
        const wanted = typeof args.tool === "string" ? args.tool : null;
        if (wanted === null) {
          return {
            content: [{ type: "text", text: tools.map((tool) => `${tool.name}: ${tool.description.split("\n")[0] ?? ""}`).join("\n") }],
            isError: false,
          };
        }
        const found = tools.find((tool) => tool.name === wanted);
        if (found === undefined) return failure(`Cua Driver has no tool named ${wanted}.`);
        return { content: [{ type: "text", text: JSON.stringify(found, null, 2) }], isError: false };
      }
      if (entry.name === "cua_call") {
        const upstream = typeof args.tool === "string" ? args.tool : "";
        const forwarded =
          typeof args.arguments === "object" && args.arguments !== null ? (args.arguments as Record<string, unknown>) : {};
        return await callConfiguredDriver(hostId, upstream, forwarded, context);
      }
      if (entry.upstream === null) return failure(`Tool ${toolName} has no upstream mapping.`);
      const result = await callConfiguredDriver(hostId, entry.upstream, args, context);
      const version = statusCache.get(hostId)?.version ?? null;
      if (version !== null && version !== UPSTREAM_DRIVER_VERSION && liveSchemas.get(hostId)?.version !== version) {
        void listHostTools(hostId).catch((error: unknown) =>
          bb.log.debug(`reading tools/list from ${hostId} failed: ${errorMessage(error)}`),
        );
      }
      return result;
    } catch (error) {
      const message = errorMessage(error);
      bb.log.warn(`${toolName} failed on host ${hostId}: ${message}`);
      return failure(
        `${message}\n\n[Open Computer Use settings](${SETTINGS_PATH}), expand this machine, check its setup, and retry.`,
      );
    }
  }

  for (const entry of CATALOG) {
    bb.agents.registerTool({
      name: entry.name,
      description: entry.description,
      parameters: entry.inputSchema,
      presentation: { label: entry.labels },
      async execute(rawArgs, context) {
        const args = forwardableArguments(entry, rawArgs);
        if (!args.ok) return failure(args.error);
        return executeCatalogTool(entry.name, args.value, context);
      },
    });
  }

  /**
   * The schema a provider sees for one tool on one machine: the bundled
   * snapshot while the machine runs the version it was taken from, otherwise
   * that machine's own tools/list once it has been read.
   */
  function toolSelection(name: string, hostId: string): string | { name: string; parameters: Record<string, unknown> } {
    const entry = CATALOG_BY_NAME.get(name);
    if (entry === undefined || entry.upstream === null) return name;
    const version = statusCache.get(hostId)?.version ?? null;
    if (version === null || version === UPSTREAM_DRIVER_VERSION) return name;
    const live = liveSchemas.get(hostId);
    const schema = live?.version === version ? live.schemas.get(entry.upstream) : undefined;
    return schema === undefined ? name : { name, parameters: schema };
  }

  bb.agents.configure((context) => {
    const decision = resolveProviderDecision(policy(), context.provider.id);
    if (decision !== "cua") return { tools: [], skills: [] };
    const status = statusCache.get(context.host.id) ?? null;
    return {
      tools: enabledToolNames().map((name) => toolSelection(name, context.host.id)),
      skills: [SKILL_NAME],
      instructions: [
        `Cua Driver computer use is available on ${context.host.name} through the cua_* tools.`,
        readinessLine(status),
        `If a tool reports that setup is required, stop and give the user its ${SETTINGS_PATH} link instead of retrying.`,
        "Follow the cua-computer-use skill: snapshot with cua_get_window_state before every element action and verify afterwards.",
      ].join("\n"),
    };
  });

  async function buildState(): Promise<State> {
    const current = policy();
    const [providers, hosts] = await Promise.all([bb.sdk.providers.list(), bb.sdk.hosts.list()]);
    return {
      mode: current.mode,
      groups: { browser: snapshot.browserTools, clipboard: snapshot.clipboardTools, passthrough: snapshot.passthroughTools },
      providers: providers.map((provider) => {
        const decision = resolveProviderDecision(current, provider.id);
        return {
          id: provider.id,
          displayName: provider.displayName,
          available: provider.available,
          native: hasNativeComputerUse(provider.id),
          override: current.overrides[provider.id] ?? "inherit",
          decision,
          decisionLabel: describeDecision(decision),
        };
      }),
      hosts: hosts.map((entry) => ({
        id: entry.id,
        name: entry.name,
        status: entry.status === "connected" ? "connected" : "disconnected",
        driver: statusCache.get(entry.id) ?? null,
        install: installByHost.get(entry.id) ?? IDLE_INSTALL_STATE,
      })),
      toolNames: enabledToolNames(),
    };
  }

  async function saveOverride(providerId: string, override: ProviderOverride): Promise<void> {
    const next = { ...overrides };
    if (override === "inherit") delete next[providerId];
    else next[providerId] = override;
    overrides = next;
    await bb.storage.kv.set(OVERRIDES_KEY, next);
    bb.realtime.publish(REALTIME_CHANNEL, { reason: "policy" });
  }

  async function saveMode(mode: RoutingMode): Promise<void> {
    await bb.sdk.plugins.updateSettings({ pluginId: bb.pluginId, values: { mode } });
    snapshot = { ...snapshot, mode };
    bb.realtime.publish(REALTIME_CHANNEL, { reason: "policy" });
  }

  bb.rpc.register(rpcContract, {
    getState: buildState,
    async setMode({ mode }) {
      await saveMode(mode);
      return buildState();
    },
    async setOverride({ providerId, override }) {
      await saveOverride(providerId, override);
      return buildState();
    },
    refreshStatus: ({ hostId }) => refreshStatus(hostId, true),
    async listTools({ hostId }) {
      return listHostTools(hostId);
    },
    installDriver: ({ hostId }) => startInstall(hostId),
    installState: ({ hostId }) => readInstallState(hostId),
    grantPermissions: ({ hostId }) => grantPermissions(hostId),
  });

  async function startInstall(hostId: string): Promise<InstallState> {
    const state = await host.call("install", null, { hostId });
    installByHost.set(hostId, state);
    bb.log.info(`Cua Driver install started on host ${hostId} (user-initiated)`);
    bb.realtime.publish(REALTIME_CHANNEL, { reason: "install", hostId });
    return state;
  }

  async function readInstallState(hostId: string): Promise<InstallState> {
    const state = await host.call("installState", null, { hostId });
    installByHost.set(hostId, state);
    return state;
  }

  async function grantPermissions(hostId: string): Promise<{ ok: boolean; output: string }> {
    const result = await host.call("grantPermissions", null, { hostId });
    await refreshStatus(hostId, true).catch(() => null);
    return result;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  const USAGE = [
    "Usage:",
    "  bb cua status [--host <id>] [--json]        Driver readiness on a machine",
    "  bb cua policy [<providerId> <cua|native|off|inherit>] [--json]",
    "  bb cua mode <prefer-native|cua-everywhere|off>",
    "  bb cua tools [--host <id>]                   Upstream tool catalog",
    "  bb cua call <tool> [<json-args>] [--host <id>]",
    "  bb cua install --yes [--host <id>]           Run Cua's official installer on a machine",
    "  bb cua update --yes [--host <id>]            Update Cua Driver to the newest release on its channel",
    "  bb cua grant [--host <id>]                   Request macOS Accessibility + Screen Recording",
  ].join("\n");

  bb.cli.register({
    name: "cua",
    summary: "Cua Driver computer use: readiness, routing policy, and raw tool calls",
    commands: [
      { name: "status", summary: "Show Cua Driver readiness for a machine", usage: "bb cua status [--host <id>] [--json]" },
      { name: "policy", summary: "Show or set per-provider routing overrides", usage: "bb cua policy [<providerId> <cua|native|off|inherit>] [--json]" },
      { name: "mode", summary: "Set the routing mode", usage: "bb cua mode <prefer-native|cua-everywhere|off>" },
      { name: "tools", summary: "List the upstream Cua Driver tool catalog", usage: "bb cua tools [--host <id>]" },
      { name: "call", summary: "Call any Cua Driver tool with JSON arguments", usage: "bb cua call <tool> [<json-args>] [--host <id>]" },
      { name: "install", summary: "Run Cua's official installer on a machine (requires --yes)", usage: "bb cua install --yes [--host <id>]" },
      { name: "update", summary: "Update Cua Driver to the newest release on its channel (requires --yes)", usage: "bb cua update --yes [--host <id>]" },
      { name: "grant", summary: "Request macOS Accessibility and Screen Recording for CuaDriver.app", usage: "bb cua grant [--host <id>]" },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const yes = argv.includes("--yes");
      const hostFlag = argv.indexOf("--host");
      const explicitHost = hostFlag >= 0 ? argv[hostFlag + 1] : undefined;
      const args = argv.filter(
        (arg, index) =>
          arg !== "--json" && arg !== "--yes" && arg !== "--host" && (hostFlag < 0 || index !== hostFlag + 1),
      );
      const [command, ...rest] = args;
      async function targetHost(): Promise<string> {
        if (explicitHost !== undefined) return explicitHost;
        if (ctx.threadId !== undefined) return resolveHostId(ctx.threadId);
        return primaryHostId();
      }
      try {
        if (command === "status") {
          const status = await refreshStatus(await targetHost(), true);
          return { exitCode: 0, stdout: json ? JSON.stringify(status) : `${readinessLine(status)}\n${JSON.stringify(status, null, 2)}` };
        }
        if (command === "policy") {
          if (rest.length === 2) {
            const [providerId, override] = rest;
            if (!PROVIDER_OVERRIDES.includes(override as ProviderOverride)) {
              return { exitCode: 1, stderr: `Override must be one of ${PROVIDER_OVERRIDES.join(", ")}.` };
            }
            await saveOverride(providerId!, override as ProviderOverride);
          } else if (rest.length !== 0) {
            return { exitCode: 1, stderr: USAGE };
          }
          const state = await buildState();
          const lines = state.providers.map(
            (provider) => `${provider.id.padEnd(16)} ${provider.decision.padEnd(7)} override=${provider.override}${provider.native ? " (native computer use)" : ""}`,
          );
          return { exitCode: 0, stdout: json ? JSON.stringify(state) : [`mode: ${state.mode}`, ...lines].join("\n") };
        }
        if (command === "mode") {
          const mode = rest[0];
          if (!ROUTING_MODES.includes(mode as RoutingMode)) {
            return { exitCode: 1, stderr: `Mode must be one of ${ROUTING_MODES.join(", ")}.` };
          }
          await saveMode(mode as RoutingMode);
          return { exitCode: 0, stdout: `mode: ${mode}` };
        }
        if (command === "tools") {
          const { tools } = await listHostTools(await targetHost());
          return {
            exitCode: 0,
            stdout: json ? JSON.stringify(tools) : tools.map((tool) => `${tool.name}: ${tool.description.split("\n")[0] ?? ""}`).join("\n"),
          };
        }
        if (command === "call") {
          const [tool, rawArgs] = rest;
          if (tool === undefined) return { exitCode: 1, stderr: USAGE };
          let parsed: Record<string, unknown> = {};
          if (rawArgs !== undefined) {
            const value: unknown = JSON.parse(rawArgs);
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
              return { exitCode: 1, stderr: "Arguments must be a JSON object." };
            }
            parsed = value as Record<string, unknown>;
          }
          const result = await callConfiguredDriver(
            await targetHost(),
            tool,
            parsed,
            ctx.threadId === undefined ? {} : { threadId: ctx.threadId },
          );
          const text = result.content
            .map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType}, ${part.data.length} base64 chars]`))
            .join("\n");
          return { exitCode: result.isError ? 1 : 0, stdout: json ? JSON.stringify(result) : text };
        }
        if (command === "update") {
          const hostId = await targetHost();
          const status = await refreshStatus(hostId, true);
          if (!status.installed) return { exitCode: 1, stderr: "Cua Driver is not installed on that machine; run `bb cua install --yes` first." };
          if (status.updateAvailable !== true) {
            return {
              exitCode: 0,
              stdout: status.updateAvailable === false
                ? `Cua Driver ${status.version ?? ""} is already the newest release.`
                : "Could not check for a newer Cua Driver release; try again later.",
            };
          }
          if (!yes) {
            return {
              exitCode: 1,
              stderr: `This stops Cua Driver ${status.version ?? ""} and runs Cua's official installer to install ${status.latestVersion ?? "the newest release"}. Re-run with --yes to confirm.`,
            };
          }
        }
        if (command === "install" || command === "update") {
          if (!yes) {
            return {
              exitCode: 1,
              stderr:
                "This downloads and runs Cua's official installer (https://cua.ai/driver/install.sh or install.ps1) on the target machine. Re-run with --yes to confirm.",
            };
          }
          const hostId = await targetHost();
          let state = await startInstall(hostId);
          const deadline = Date.now() + 15 * 60_000;
          while (state.running && Date.now() < deadline) {
            await sleep(2_000);
            state = await readInstallState(hostId);
          }
          if (!state.running) await refreshStatus(hostId, true).catch(() => null);
          const summary = state.running
            ? "Installer still running after 15 minutes; check `bb cua status` later."
            : state.ok
              ? "Install finished."
              : "Install failed.";
          return {
            exitCode: state.ok === true ? 0 : 1,
            stdout: json ? JSON.stringify(state) : [summary, ...state.tail].join("\n"),
          };
        }
        if (command === "grant") {
          const result = await grantPermissions(await targetHost());
          return { exitCode: result.ok ? 0 : 1, stdout: json ? JSON.stringify(result) : result.output };
        }
        return { exitCode: command === undefined || command === "help" ? 0 : 1, stdout: USAGE };
      } catch (error) {
        return { exitCode: 1, stderr: errorMessage(error) };
      }
    },
  });

  function endSession(threadId: string): void {
    const active = activeSessions.get(threadId);
    if (active === undefined) return;
    activeSessions.delete(threadId);
    void host
      .call(
        "callTool",
        { name: "end_session", arguments: { session: active.label }, grants: grants() },
        { hostId: active.hostId },
      )
      .catch((error: unknown) => bb.log.debug(`end_session for ${threadId} failed: ${errorMessage(error)}`));
  }
  bb.events.on("thread.idle", ({ thread }) => endSession(thread.id));
  bb.events.on("thread.failed", ({ thread }) => endSession(thread.id));
  bb.events.on("thread.archived", ({ thread }) => endSession(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => {
    endSession(thread.id);
    hostByThread.delete(thread.id);
  });

  bb.onDispose(() => {
    activeSessions.clear();
    hostByThread.clear();
    statusRefreshedAt.clear();
  });
}
