import { describe, expect, it } from "vitest";
import { CATALOG, CATALOG_BY_NAME, overridableSchema, sanitizeProviderSchema, toolNamesForGroups } from "./catalog.js";
import { UPSTREAM_SCHEMAS } from "./upstream-schemas.generated.js";

function propertyNames(schema: Record<string, unknown>): string[] {
  const properties = schema.properties;
  return typeof properties === "object" && properties !== null ? Object.keys(properties).sort() : [];
}

describe("catalog", () => {
  it("advertises Cua Driver's own schema for every upstream tool, without the plugin-owned session", () => {
    for (const entry of CATALOG) {
      if (entry.upstream === null) continue;
      const upstream = UPSTREAM_SCHEMAS[entry.upstream];
      expect(upstream, entry.name).toBeDefined();
      expect(propertyNames(entry.inputSchema), entry.name).toEqual(
        propertyNames(upstream!).filter((name) => name !== "session"),
      );
      expect((entry.inputSchema.required as string[] | undefined) ?? [], entry.name).not.toContain("session");
      expect(entry.inputSchema.type, entry.name).toBe("object");
      expect(entry.parameters, entry.name).toBeNull();
    }
  });

  it("keeps the rest of a required list when the upstream tool also requires session", () => {
    expect(UPSTREAM_SCHEMAS.browser_download?.required).toContain("session");
    const download = CATALOG_BY_NAME.get("cua_browser_download");
    expect(download?.inputSchema.required).toEqual(
      expect.arrayContaining(["target_id", "tab_id", "ref", "destination_root"]),
    );
    expect(download?.inputSchema.required).not.toContain("session");
  });

  it("validates only the plugin's own meta tools", () => {
    for (const name of ["cua_call", "cua_describe", "cua_status"]) {
      const entry = CATALOG_BY_NAME.get(name);
      expect(entry?.parameters, name).not.toBeNull();
      expect(entry?.inputSchema.type, name).toBe("object");
    }
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
    expect(toolNamesForGroups(new Set(["desktop"]))).toContain("cua_get_accessibility_tree");
    expect(toolNamesForGroups(new Set(["desktop"]))).not.toContain("cua_browser_click");
    expect(toolNamesForGroups(new Set(["browser"]))).toEqual(expect.arrayContaining(["cua_browser_download", "cua_browser_set_input_files"]));
    expect(toolNamesForGroups(new Set(["desktop", "meta"]))).toContain("cua_call");
  });

  it("falls back to the bundled schema for a live one bb would refuse as an override", () => {
    const plain = { type: "object", properties: { pid: { type: "integer" }, session: { type: "string" } }, required: ["pid", "session"] };
    expect(overridableSchema(plain)).toEqual({ type: "object", properties: { pid: { type: "integer" } }, required: ["pid"] });

    const recursive = { type: "object", properties: { node: { $ref: "#" } } };
    expect(overridableSchema(recursive)).toBeNull();

    const huge = { type: "object", properties: { pid: { type: "integer", description: "x".repeat(130 * 1024) } } };
    expect(overridableSchema(huge)).toBeNull();
  });

  it("normalizes schemas recursively for Gemini provider compatibility", () => {
    // 1. Non-string enum member (e.g. boolean [true]) is dropped; empty enum is omitted
    const booleanEnumSchema = {
      type: "object",
      properties: {
        element: {
          type: "object",
          properties: {
            exists: {
              type: "boolean",
              description: "Assert element exists",
              enum: [true],
            },
          },
        },
      },
    };
    const sanitizedBoolean = sanitizeProviderSchema(booleanEnumSchema) as Record<string, unknown>;
    const existsProp = ((sanitizedBoolean.properties as Record<string, unknown>).element as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    expect(existsProp.exists.type).toBe("boolean");
    expect(existsProp.exists.enum).toBeUndefined();

    // 2. Empty string / whitespace-only enum members are dropped while valid strings are kept
    const mixedEnumSchema = {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["", "fast", "  ", "slow"],
        },
      },
    };
    const sanitizedMixed = sanitizeProviderSchema(mixedEnumSchema) as Record<string, unknown>;
    const modeProp = (sanitizedMixed.properties as Record<string, Record<string, unknown>>).mode;
    expect(modeProp.enum).toEqual(["fast", "slow"]);

    // 3. Enum containing only empty/invalid strings is omitted
    const emptyStringEnumSchema = {
      type: "object",
      properties: {
        flag: {
          type: "string",
          enum: ["", "  "],
        },
      },
    };
    const sanitizedEmpty = sanitizeProviderSchema(emptyStringEnumSchema) as Record<string, unknown>;
    const flagProp = (sanitizedEmpty.properties as Record<string, Record<string, unknown>>).flag;
    expect(flagProp.enum).toBeUndefined();

    // 4. Standard valid string enum is preserved
    const validStringEnumSchema = {
      type: "object",
      properties: {
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
        },
      },
    };
    const sanitizedValid = sanitizeProviderSchema(validStringEnumSchema) as Record<string, unknown>;
    const buttonProp = (sanitizedValid.properties as Record<string, Record<string, unknown>>).button;
    expect(buttonProp.enum).toEqual(["left", "right", "middle"]);
  });

  it("ensures cua_verify_state advertised schema has no invalid enum on exists while bundled snapshot is preserved", () => {
    // Bundled snapshot retains original upstream schema unchanged
    const rawVerifyState = UPSTREAM_SCHEMAS.verify_state as Record<string, any>;
    const rawExists = rawVerifyState?.properties?.expect?.items?.properties?.element?.properties?.exists;
    expect(rawExists?.enum).toEqual([true]);

    // Advertised catalog schema has invalid boolean enum stripped for provider safety
    const catalogVerifyState = CATALOG_BY_NAME.get("cua_verify_state");
    expect(catalogVerifyState).toBeDefined();
    const advertisedExists = (catalogVerifyState?.inputSchema as any)?.properties?.expect?.items?.properties?.element?.properties?.exists;
    expect(advertisedExists?.type).toBe("boolean");
    expect(advertisedExists?.enum).toBeUndefined();
  });

  it("sanitizes live schema overrides with invalid enums through overridableSchema", () => {
    const liveBadSchema = {
      type: "object",
      properties: {
        session: { type: "string" },
        expect: {
          type: "array",
          items: {
            type: "object",
            properties: {
              element: {
                type: "object",
                properties: {
                  exists: {
                    type: "boolean",
                    enum: [true],
                  },
                },
              },
            },
          },
        },
      },
      required: ["session", "expect"],
    };

    const sanitized = overridableSchema(liveBadSchema) as any;
    expect(sanitized).not.toBeNull();
    expect(sanitized.properties.session).toBeUndefined();
    expect(sanitized.required).toEqual(["expect"]);
    expect(sanitized.properties.expect.items.properties.element.properties.exists.enum).toBeUndefined();
    expect(sanitized.properties.expect.items.properties.element.properties.exists.type).toBe("boolean");
  });
});
