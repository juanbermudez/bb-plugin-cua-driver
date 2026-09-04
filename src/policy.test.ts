import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, normalizePolicy, resolveProviderDecision } from "./policy.js";

describe("resolveProviderDecision", () => {
  it("keeps native computer use for codex in prefer-native mode", () => {
    expect(resolveProviderDecision(DEFAULT_POLICY, "codex")).toBe("native");
    expect(resolveProviderDecision(DEFAULT_POLICY, "claude-code")).toBe("cua");
    expect(resolveProviderDecision(DEFAULT_POLICY, "pi")).toBe("cua");
    expect(resolveProviderDecision(DEFAULT_POLICY, "acp-cursor")).toBe("cua");
  });

  it("routes everyone to cua in cua-everywhere mode", () => {
    const policy = { mode: "cua-everywhere" as const, overrides: {} };
    expect(resolveProviderDecision(policy, "codex")).toBe("cua");
    expect(resolveProviderDecision(policy, "pi")).toBe("cua");
  });

  it("lets a per-provider override beat the mode", () => {
    expect(
      resolveProviderDecision({ mode: "off", overrides: { pi: "cua" } }, "pi"),
    ).toBe("cua");
    expect(
      resolveProviderDecision({ mode: "cua-everywhere", overrides: { codex: "native" } }, "codex"),
    ).toBe("native");
    expect(
      resolveProviderDecision({ mode: "prefer-native", overrides: { "claude-code": "off" } }, "claude-code"),
    ).toBe("off");
  });
});

describe("normalizePolicy", () => {
  it("drops unknown modes, unknown override values, and inherit entries", () => {
    expect(
      normalizePolicy({ mode: "bogus", overrides: { pi: "cua", codex: "inherit", x: "nope", "": "cua" } }),
    ).toEqual({ mode: "prefer-native", overrides: { pi: "cua" } });
    expect(normalizePolicy(null)).toEqual(DEFAULT_POLICY);
  });
});
