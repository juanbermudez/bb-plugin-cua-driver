// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

// Radix tooltips position through floating-ui, which observes element size;
// jsdom has no ResizeObserver, so give it an inert one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

const baseState = {
  mode: "prefer-native",
  groups: { browser: true, clipboard: true, passthrough: true },
  providers: [
    { id: "codex", displayName: "Codex", available: true, native: true, override: "inherit", decision: "native", decisionLabel: "Harness-native computer use" },
    { id: "pi", displayName: "Pi", available: true, native: false, override: "inherit", decision: "cua", decisionLabel: "Cua Driver tools" },
  ],
  hosts: [
    {
      id: "host_1",
      name: "laptop",
      status: "connected",
      driver: {
        platform: "darwin",
        installed: true,
        binaryPath: "/x",
        version: "0.23.2",
        daemonRunning: true,
        permissions: { accessibility: true, screenRecording: false, directCapture: "not_checked" },
        connected: false,
        toolCount: 56,
        error: null,
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
      install: { running: false, ok: null, exitCode: null, step: null, tail: [], startedAt: null, finishedAt: null },
    },
    {
      id: "host_2",
      name: "build-box",
      status: "connected",
      driver: {
        platform: "linux",
        installed: false,
        binaryPath: null,
        version: null,
        daemonRunning: null,
        permissions: null,
        connected: false,
        toolCount: null,
        error: null,
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
      install: { running: false, ok: null, exitCode: null, step: null, tail: [], startedAt: null, finishedAt: null },
    },
  ],
  toolNames: ["cua_click", "cua_get_window_state"],
};

describe("settings sections", () => {
  it("registers each settings group as a separate card", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.settingsSections.map((section) => ({ id: section.id, title: section.title }))).toEqual([
      { id: "routing", title: "Routing mode" },
      { id: "provider-overrides", title: "Provider overrides" },
      { id: "driver-machines", title: "Cua Driver on your machines" },
      { id: "about", title: "About Computer Use" },
    ]);
  });

  it("keeps routing modes to one line and moves each detail into a hover hint", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const section = app.settingsSections.find((candidate) => candidate.id === "routing")!;
    const slot = renderSlot(section, {}, { rpc: { getState: () => baseState } });

    const radio = await slot.findByRole("radio", { name: /Prefer provider tools/ });
    expect(radio.closest("label")?.classList.contains("group/row")).toBe(true);
    expect(radio.closest("label")?.classList.contains("items-center")).toBe(true);
    expect(slot.queryByText("Use Cua Driver for every provider.")).toBeNull();
    const hint = await slot.findByRole("button", { name: "About Always use Cua Driver" });
    fireEvent.focus(hint);
    expect((await slot.findByRole("tooltip")).textContent).toContain("Use Cua Driver for every provider.");
    slot.lifecycle.unmount();
  });

  it("keeps provider overrides collapsed until requested and sends changes through rpc", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const section = app.settingsSections.find((candidate) => candidate.id === "provider-overrides")!;
    const calls: Array<{ providerId: string; override: string }> = [];
    const slot = renderSlot(section, {}, {
      rpc: {
        getState: () => baseState,
        setOverride: (raw: unknown) => {
          const input = raw as { providerId: string; override: string };
          calls.push(input);
          return {
            ...baseState,
            providers: baseState.providers.map((provider) =>
              provider.id === input.providerId
                ? { ...provider, override: input.override, decision: input.override, decisionLabel: "Cua Driver tools" }
                : provider,
            ),
          };
        },
      },
    });

    const disclosure = await slot.findByRole("button", {
      name: /Override routing for individual providers/,
    });
    expect(slot.queryByText("Show provider controls")).toBeNull();
    expect(disclosure.textContent).toContain("2 providers");
    const disclosureRegion = document.getElementById(disclosure.getAttribute("aria-controls")!);
    expect(disclosureRegion?.getAttribute("data-state")).toBe("closed");
    expect(disclosure.classList.contains("rounded-md")).toBe(true);
    expect(disclosure.classList.contains("hover:bg-state-hover")).toBe(false);
    expect(disclosureRegion?.querySelector("[data-provider-list]")?.classList.contains("border-t")).toBe(false);
    expect(disclosureRegion?.getAttribute("aria-hidden")).toBe("true");
    expect(disclosureRegion?.hasAttribute("inert")).toBe(true);
    expect(slot.queryByRole("combobox", { name: "Codex override" })).toBeNull();
    fireEvent.click(disclosure);
    expect(disclosureRegion?.getAttribute("data-state")).toBe("open");
    expect(disclosure.classList.contains("rounded-md")).toBe(true);
    expect(disclosureRegion?.classList.contains("grid-rows-[1fr]")).toBe(true);
    const select = await slot.findByLabelText("Codex override");
    expect(disclosureRegion?.textContent).not.toContain("has own computer use");
    fireEvent.change(select, { target: { value: "cua" } });
    await slot.findAllByText("Cua Driver tools");
    expect(calls).toEqual([{ providerId: "codex", override: "cua" }]);
    slot.lifecycle.unmount();
  });

  it("keeps installer consent, progress, and output inside a reopenable dialog", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const section = app.settingsSections.find((candidate) => candidate.id === "driver-machines")!;
    const installCalls: unknown[] = [];
    let installStarted = false;
    const runningInstall = {
      running: true,
      ok: null,
      exitCode: null,
      step: "download",
      tail: ["Downloading install.sh"],
      startedAt: "2026-01-01T00:00:01.000Z",
      finishedAt: null,
    };
    const slot = renderSlot(section, {}, {
      rpc: {
        getState: () =>
          installStarted
            ? {
                ...baseState,
                hosts: baseState.hosts.map((host) =>
                  host.id === "host_2" ? { ...host, install: runningInstall } : host,
                ),
              }
            : baseState,
        installDriver: (input: unknown) => {
          installCalls.push(input);
          installStarted = true;
          return runningInstall;
        },
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: "Install Cua Driver…" }));
    await slot.findByRole("dialog", { name: "Install Cua Driver on build-box" });
    expect(installCalls).toEqual([]);
    fireEvent.click(await slot.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(installCalls).toEqual([]);

    fireEvent.click(await slot.findByRole("button", { name: "Install Cua Driver…" }));
    fireEvent.click(await slot.findByRole("button", { name: "Run installer" }));
    await waitFor(() => expect(installCalls).toEqual([{ hostId: "host_2" }]));
    const progress = await slot.findByRole("progressbar", { name: "Estimated installation progress" });
    expect(progress.getAttribute("aria-valuenow")).toBe("20");
    fireEvent.click(await slot.findByRole("button", { name: /Installation details/ }));
    await slot.findByText("Downloading install.sh");
    fireEvent.click(await slot.findByRole("button", { name: "Continue in background" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(await slot.findByRole("button", { name: "View progress" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("groups machines into one connected list card", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const section = app.settingsSections.find((candidate) => candidate.id === "driver-machines")!;
    const slot = renderSlot(section, {}, {
      rpc: {
        getState: () => baseState,
      },
    });

    const machineList = await slot.findByRole("list", { name: "Machines" });
    const machineRows = machineList.querySelectorAll(":scope > [data-machine-row]");
    expect(machineList.classList.contains("rounded-lg")).toBe(true);
    expect(machineList.classList.contains("border")).toBe(true);
    expect(machineList.classList.contains("divide-y")).toBe(true);
    expect(machineRows).toHaveLength(2);
    expect(Array.from(machineRows).every((row) => !row.classList.contains("rounded-lg"))).toBe(true);
    expect(Array.from(machineRows).every((row) => !row.classList.contains("border"))).toBe(true);
    slot.lifecycle.unmount();
  });

  it("shows an expandable setup checklist and runs the guided permission flow", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const section = app.settingsSections.find((candidate) => candidate.id === "driver-machines")!;
    const grantCalls: unknown[] = [];
    const slot = renderSlot(section, {}, {
      rpc: {
        getState: () => ({ ...baseState, hosts: [baseState.hosts[0]] }),
        grantPermissions: (input: unknown) => {
          grantCalls.push(input);
          return { ok: true, output: "Permission flow complete." };
        },
      },
    });

    const machine = await slot.findByRole("button", { name: /^laptop setup, online/ });
    const machineRegion = document.getElementById(machine.getAttribute("aria-controls")!);
    expect(machine.getAttribute("aria-expanded")).toBe("true");
    expect(machine.classList.contains("rounded-md")).toBe(true);
    expect(machine.classList.contains("rounded-t-md")).toBe(false);
    expect(machineRegion?.getAttribute("data-state")).toBe("open");
    expect(machineRegion?.classList.contains("transition-[grid-template-rows]")).toBe(true);
    expect(machineRegion?.classList.contains("grid-rows-[1fr]")).toBe(true);
    expect(machineRegion?.classList.contains("motion-reduce:transition-none")).toBe(true);
    expect(machineRegion?.firstElementChild?.classList.contains("transition-[opacity,transform]")).toBe(true);
    expect(await slot.findByRole("list", { name: "Setup checklist for laptop" })).toBeTruthy();
    expect(slot.queryByText("macOS may ask once when the first screenshot is taken")).toBeNull();
    const hint = await slot.findByRole("button", { name: "About Direct screen capture" });
    expect(hint.classList.contains("opacity-0")).toBe(true);
    expect(hint.classList.contains("group-hover/row:opacity-100")).toBe(true);
    expect(hint.closest("li")?.classList.contains("group/row")).toBe(true);
    fireEvent.focus(hint);
    expect((await slot.findByRole("tooltip")).textContent).toContain("macOS may ask once when the first screenshot is taken");
    fireEvent.blur(hint);
    expect(slot.queryByText("Available to bb")).toBeNull();
    expect(slot.queryByText("Allowed for CuaDriver.app")).toBeNull();
    expect(await slot.findByText("v0.23.2")).toBeTruthy();

    const permissionButton = await slot.findByRole("button", { name: "Grant macOS permissions" });
    expect(permissionButton.classList.contains("w-full")).toBe(true);
    expect(permissionButton.classList.contains("rounded-full")).toBe(true);
    const refreshButton = await slot.findByRole("button", { name: "Check setup" });
    expect(refreshButton.classList.contains("w-full")).toBe(true);
    expect(refreshButton.classList.contains("rounded-full")).toBe(true);

    fireEvent.click(machine);
    await waitFor(() => expect(slot.queryByRole("list", { name: "Setup checklist for laptop" })).toBeNull());
    expect(machine.classList.contains("rounded-md")).toBe(true);
    expect(machineRegion?.getAttribute("data-state")).toBe("closed");
    expect(machineRegion?.getAttribute("aria-hidden")).toBe("true");
    expect(machineRegion?.hasAttribute("inert")).toBe(true);
    expect(machineRegion?.classList.contains("grid-rows-[0fr]")).toBe(true);
    fireEvent.click(machine);
    fireEvent.click(await slot.findByRole("button", { name: "Grant macOS permissions" }));
    await waitFor(() => expect(grantCalls).toEqual([{ hostId: "host_1" }]));
    slot.lifecycle.unmount();
  });

  it("offers an update when a ready machine runs an older Cua Driver", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const section = app.settingsSections.find((candidate) => candidate.id === "driver-machines")!;
    const [laptop] = baseState.hosts;
    const outdated = {
      ...laptop!,
      driver: {
        ...laptop!.driver,
        permissions: { accessibility: true, screenRecording: true, directCapture: "not_checked" },
        latestVersion: "0.28.2",
        updateAvailable: true,
      },
    };
    const slot = renderSlot(section, {}, { rpc: { getState: () => ({ ...baseState, hosts: [outdated] }) } });

    const machine = await slot.findByRole("button", { name: /^laptop setup/ });
    if (machine.getAttribute("aria-expanded") !== "true") fireEvent.click(machine);
    expect(await slot.findByText("v0.23.2 · v0.28.2 available")).toBeTruthy();
    expect(await slot.findByRole("button", { name: "Update to v0.28.2…" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("keeps offline machines inert and hides stale setup failures", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const section = app.settingsSections.find((candidate) => candidate.id === "driver-machines")!;
    const offlineHost = {
      ...baseState.hosts[0],
      id: "host_offline",
      name: "offline-mac",
      status: "disconnected",
      driver: {
        ...baseState.hosts[0]!.driver,
        permissions: { accessibility: false, screenRecording: false, directCapture: "denied" },
        error: "Accessibility permission denied.",
      },
      install: {
        ...baseState.hosts[0]!.install,
        ok: false,
        step: "failed",
        tail: ["Installer failed"],
      },
    };
    const slot = renderSlot(section, {}, {
      rpc: {
        getState: () => ({ ...baseState, hosts: [offlineHost] }),
      },
    });

    expect(await slot.findByText("offline-mac")).toBeTruthy();
    expect(slot.queryByText("macOS")).toBeNull();
    expect(slot.queryByText("Platform not checked")).toBeNull();
    const offlineLabels = await slot.findAllByText("Offline");
    expect(offlineLabels).toHaveLength(1);
    expect(offlineLabels[0]?.classList.contains("rounded-full")).toBe(true);
    const offlineDot = slot.container.querySelector('[data-machine-connection="offline"]');
    expect(offlineDot?.querySelector(".border-muted-foreground\\/70")).toBeTruthy();
    expect(slot.queryByText(/macOS.*Offline/)).toBeNull();
    expect(slot.queryByRole("button", { name: "offline-mac setup" })).toBeNull();
    expect(slot.queryByRole("list", { name: "Setup checklist for offline-mac" })).toBeNull();
    expect(slot.queryByText("Accessibility permission denied.")).toBeNull();
    expect(slot.queryByText("Installer failed")).toBeNull();
    expect(slot.queryByText("Installation failed")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("uses semantic row colors without turning diagnostic copy red", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const section = app.settingsSections.find((candidate) => candidate.id === "driver-machines")!;
    const erroredHost = {
      ...baseState.hosts[0],
      driver: {
        ...baseState.hosts[0]!.driver,
        error: "Cua Driver could not connect.",
      },
    };
    const slot = renderSlot(section, {}, {
      rpc: {
        getState: () => ({ ...baseState, hosts: [erroredHost] }),
      },
    });

    const summary = await slot.findByText(/Setup needs attention/);
    expect(summary.classList.contains("text-warning-text")).toBe(true);
    const requiredBadges = slot.container.querySelectorAll('[data-setup-state="required"]');
    expect(requiredBadges.length).toBeGreaterThan(0);
    expect(Array.from(requiredBadges).every((badge) => badge.firstElementChild?.classList.contains("bg-background"))).toBe(true);
    const readyBadges = slot.container.querySelectorAll('[data-setup-state="complete"]');
    expect(readyBadges.length).toBeGreaterThan(0);
    expect(Array.from(readyBadges).every((badge) => badge.textContent === "")).toBe(true);
    expect(Array.from(readyBadges).every((badge) => badge.getAttribute("aria-label") === "Ready")).toBe(true);
    expect(
      Array.from(readyBadges).every((badge) => badge.firstElementChild?.querySelector("svg")?.classList.contains("text-success/60")),
    ).toBe(true);
    const alert = await slot.findByRole("alert");
    expect(alert.querySelector(".text-destructive")).toBeTruthy();
    expect((await slot.findByText("Cua Driver could not connect.")).classList.contains("text-muted-foreground")).toBe(true);
    slot.lifecycle.unmount();
  });

  it("shows online presence but removes the redundant status check when setup is ready", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const section = app.settingsSections.find((candidate) => candidate.id === "driver-machines")!;
    const readyHost = {
      ...baseState.hosts[0],
      driver: {
        ...baseState.hosts[0]!.driver,
        connected: true,
        permissions: { accessibility: true, screenRecording: true, directCapture: "granted" },
      },
    };
    const slot = renderSlot(section, {}, {
      rpc: {
        getState: () => ({ ...baseState, hosts: [readyHost] }),
      },
    });

    const machine = await slot.findByRole("button", { name: /^laptop setup, online, Ready/ });
    expect(machine.textContent).not.toContain("macOS");
    expect(machine.textContent).not.toContain("Platform not checked");
    expect(machine.textContent).not.toContain("Online");
    const onlineDot = machine.querySelector('[data-machine-connection="online"]');
    expect(onlineDot?.querySelector(".bg-success")).toBeTruthy();
    expect(onlineDot?.querySelector(".motion-safe\\:animate-pulse")).toBeTruthy();
    const summaryLabel = machine.querySelector('[data-machine-summary]');
    expect(summaryLabel?.textContent).toBe("Ready");
    expect(summaryLabel?.querySelector("svg")).toBeNull();
    expect(machine.querySelector('[data-setup-state="complete"]')).toBeNull();
    fireEvent.click(machine);
    expect(await slot.findByRole("list", { name: "Setup checklist for laptop" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Check setup" })).toBeNull();
    const readyBadges = slot.container.querySelectorAll('[data-setup-state="complete"]');
    expect(readyBadges.length).toBeGreaterThan(1);
    expect(Array.from(readyBadges).every((badge) => badge.textContent === "")).toBe(true);
    expect(Array.from(readyBadges).every((badge) => badge.getAttribute("aria-label") === "Ready")).toBe(true);
    slot.lifecycle.unmount();
  });

  it("credits and links to Cua from the Computer Use information card", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const section = app.settingsSections.find((candidate) => candidate.id === "about")!;
    const slot = renderSlot(section, {}, { rpc: {} });
    expect((await slot.findByRole("link", { name: "Learn about Cua Driver" })).getAttribute("href")).toBe("https://cua.ai/docs");
    expect((await slot.findByRole("link", { name: "View Cua on GitHub" })).getAttribute("href")).toBe("https://github.com/trycua/cua");
    slot.lifecycle.unmount();
  });
});
