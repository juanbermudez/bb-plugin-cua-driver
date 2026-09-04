import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { McpStdioClient, type McpChild } from "./mcp-client.js";

function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const written: Array<Record<string, unknown>> = [];
  stdin.on("data", (chunk: Buffer) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim().length > 0) written.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const child: McpChild = {
    stdin,
    stdout,
    stderr: null,
    kill: () => {
      listeners.get("exit")?.(0);
      return true;
    },
    once(event, listener) {
      listeners.set(event, listener);
      return this;
    },
  };
  return {
    child,
    written,
    reply(message: unknown) {
      stdout.write(`${JSON.stringify(message)}\n`);
    },
    exit(code: number) {
      listeners.get("exit")?.(code);
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("McpStdioClient", () => {
  it("performs the initialize handshake and pages tools/list", async () => {
    const fake = fakeChild();
    const client = new McpStdioClient(fake.child);
    const init = client.initialize("test", "0.0.0");
    await flush();
    expect(fake.written[0]).toMatchObject({ id: 1, method: "initialize" });
    fake.reply({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } });
    await init;
    await flush();
    expect(fake.written[1]).toMatchObject({ method: "notifications/initialized" });

    const list = client.listTools();
    await flush();
    fake.reply({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "click", inputSchema: { type: "object" } }], nextCursor: "c1" } });
    await flush();
    fake.reply({ jsonrpc: "2.0", id: 3, result: { tools: [{ name: "type_text", description: "t" }] } });
    const tools = await list;
    expect(tools.map((tool) => tool.name)).toEqual(["click", "type_text"]);
    expect(tools[1]?.inputSchema).toEqual({ type: "object" });
  });

  it("maps tool errors and transport close to rejections", async () => {
    const fake = fakeChild();
    const client = new McpStdioClient(fake.child);
    const call = client.callTool("click", { pid: 1 });
    await flush();
    fake.reply({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid params" } });
    await expect(call).rejects.toThrow(/invalid params/);

    const pending = client.callTool("click", {});
    fake.exit(1);
    await expect(pending).rejects.toThrow(/process exited/);
    expect(client.isClosed).toBe(true);
    await expect(client.callTool("click", {})).rejects.toThrow(/closed/);
  });

  it("returns content, isError, and structuredContent", async () => {
    const fake = fakeChild();
    const client = new McpStdioClient(fake.child);
    const call = client.callTool("get_window_state", { pid: 1, window_id: 2 });
    await flush();
    fake.reply({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "tree" }, { type: "image", data: "AAAA", mimeType: "image/png" }, "junk"],
        isError: false,
        structuredContent: { elements: [] },
      },
    });
    const result = await call;
    expect(result.content).toHaveLength(2);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ elements: [] });
  });
});
