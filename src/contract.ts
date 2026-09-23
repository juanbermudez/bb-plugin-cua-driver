import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const toolContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("image"),
      data: z.string(),
      mimeType: z.string(),
    })
    .strict(),
]);
export type ToolContentPart = z.infer<typeof toolContentPartSchema>;

export const toolCallResultSchema = z
  .object({
    content: z.array(toolContentPartSchema),
    isError: z.boolean(),
    structured: z.unknown().optional(),
  })
  .strict();
export type ToolCallResult = z.infer<typeof toolCallResultSchema>;

export const driverStatusSchema = z
  .object({
    platform: z.enum(["darwin", "linux", "win32", "other"]),
    installed: z.boolean(),
    binaryPath: z.string().nullable(),
    version: z.string().nullable(),
    daemonRunning: z.boolean().nullable(),
    permissions: z
      .object({
        accessibility: z.boolean().nullable(),
        screenRecording: z.boolean().nullable(),
        directCapture: z.string().nullable().optional(),
      })
      .strict()
      .nullable(),
    connected: z.boolean(),
    /** Newest release on the machine's saved channel; null when the check could not run. */
    latestVersion: z.string().nullable(),
    updateAvailable: z.boolean().nullable(),
    toolCount: z.number().int().nullable(),
    error: z.string().nullable(),
    checkedAt: z.string(),
  })
  .strict();
export type DriverStatus = z.infer<typeof driverStatusSchema>;

export const catalogToolSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();
export type CatalogTool = z.infer<typeof catalogToolSchema>;

export const installStateSchema = z
  .object({
    running: z.boolean(),
    ok: z.boolean().nullable(),
    exitCode: z.number().int().nullable(),
    step: z.string().nullable(),
    tail: z.array(z.string()),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
  })
  .strict();
export type InstallState = z.infer<typeof installStateSchema>;

export const IDLE_INSTALL_STATE: InstallState = {
  running: false,
  ok: null,
  exitCode: null,
  step: null,
  tail: [],
  startedAt: null,
  finishedAt: null,
};

/**
 * Opt-in Cua Driver grants the MCP server is started with. `existing-profile`
 * lets browser tools attach to a person's signed-in Chrome or Edge profile.
 */
export const DRIVER_GRANTS = ["existing-profile"] as const;
export const driverGrantsSchema = z.array(z.enum(DRIVER_GRANTS)).max(DRIVER_GRANTS.length);
export type DriverGrant = (typeof DRIVER_GRANTS)[number];

export const hostContract = defineRpcContract({
  install: {
    input: z.null(),
    output: installStateSchema,
  },
  installState: {
    input: z.null(),
    output: installStateSchema,
  },
  grantPermissions: {
    input: z.null(),
    output: z.object({ ok: z.boolean(), output: z.string() }).strict(),
  },
  status: {
    input: z.object({ probeDaemon: z.boolean() }).strict(),
    output: driverStatusSchema,
  },
  listTools: {
    input: z.object({ grants: driverGrantsSchema }).strict(),
    output: z.object({ tools: z.array(catalogToolSchema) }).strict(),
  },
  callTool: {
    input: z
      .object({
        name: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()),
        session: z.string().min(1).max(125).optional(),
        grants: driverGrantsSchema,
      })
      .strict(),
    output: toolCallResultSchema,
  },
  disconnect: {
    input: z.null(),
    output: z.object({ disconnected: z.boolean() }).strict(),
  },
});

export const hostSignals = {
  connectionChanged: {
    payload: z
      .object({ connected: z.boolean(), reason: z.string() })
      .strict(),
  },
  installChanged: {
    payload: installStateSchema,
  },
} satisfies ExperimentalHostSignals;
