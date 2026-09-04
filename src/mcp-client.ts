import { createInterface } from "node:readline";

export interface McpChild {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit" | "error", listener: (...args: unknown[]) => void): this;
}

export interface McpContentPart {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolCallResult {
  content: McpContentPart[];
  isError: boolean;
  structuredContent: unknown;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const PROTOCOL_VERSION = "2025-06-18";

export class McpStdioClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private closeReason: string | null = null;
  private readonly closeListeners = new Set<(reason: string) => void>();
  private stderrTail = "";

  constructor(private readonly child: McpChild) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-2048);
    });
    child.once("exit", (code) => this.handleClose(`process exited (${String(code)})`));
    child.once("error", (error) =>
      this.handleClose(`process error: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get recentStderr(): string {
    return this.stderrTail.trim();
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async initialize(clientName: string, clientVersion: string): Promise<void> {
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: clientVersion },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
      )) as { tools?: unknown; nextCursor?: unknown };
      if (Array.isArray(result.tools)) {
        for (const raw of result.tools) {
          const entry = raw as Partial<McpToolDescriptor>;
          if (typeof entry.name !== "string") continue;
          tools.push({
            name: entry.name,
            description: typeof entry.description === "string" ? entry.description : "",
            inputSchema:
              typeof entry.inputSchema === "object" && entry.inputSchema !== null
                ? (entry.inputSchema as Record<string, unknown>)
                : { type: "object" },
          });
        }
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor !== undefined);
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    const result = (await this.request("tools/call", { name, arguments: args }, signal)) as {
      content?: unknown;
      isError?: unknown;
      structuredContent?: unknown;
    };
    const content: McpContentPart[] = Array.isArray(result.content)
      ? result.content.filter(
          (part): part is McpContentPart =>
            typeof part === "object" && part !== null && typeof (part as McpContentPart).type === "string",
        )
      : [];
    return {
      content,
      isError: result.isError === true,
      structuredContent: result.structuredContent ?? null,
    };
  }

  close(reason = "closed by client"): void {
    if (this.closed) return;
    this.child.kill("SIGTERM");
    this.handleClose(reason);
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`MCP transport closed: ${this.closeReason ?? "unknown"}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(id);
        reject(new Error("tool call aborted"));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message: { id?: unknown; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(trimmed) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    if (message.error !== undefined && message.error !== null) {
      const error = message.error as { code?: unknown; message?: unknown };
      pending.reject(
        new Error(
          `MCP error ${String(error.code ?? "")}: ${String(error.message ?? "unknown error")}`.trim(),
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const pending of this.pending.values()) {
      pending.reject(new Error(`MCP transport closed: ${reason}`));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener(reason);
    this.closeListeners.clear();
  }
}
