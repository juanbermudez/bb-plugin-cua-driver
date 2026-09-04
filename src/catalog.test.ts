import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CATALOG, toolNamesForGroups } from "./catalog.js";

describe("catalog", () => {
  it("converts every tool schema to JSON schema the way bb does at registration", () => {
    const failures: string[] = [];
    for (const entry of CATALOG) {
      try {
        const schema = z.toJSONSchema(entry.parameters, { io: "input" });
        expect(schema.type).toBe("object");
      } catch (error) {
        failures.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("uses unique cua_-prefixed names and upstream names without the prefix", () => {
    const names = CATALOG.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of CATALOG) {
      expect(entry.name.startsWith("cua_")).toBe(true);
      if (entry.upstream !== null) expect(entry.name).toBe(`cua_${entry.upstream}`);
      expect(entry.labels.pending.length).toBeLessThanOrEqual(80);
      expect(entry.labels.completed.length).toBeLessThanOrEqual(80);
    }
  });

  it("keeps desktop tools in every group selection", () => {
    expect(toolNamesForGroups(new Set(["desktop"]))).toContain("cua_click");
    expect(toolNamesForGroups(new Set(["desktop"]))).not.toContain("cua_browser_click");
    expect(toolNamesForGroups(new Set(["desktop", "meta"]))).toContain("cua_call");
  });
});
