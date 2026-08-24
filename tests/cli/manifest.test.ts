import { describe, it, expect } from "bun:test";
import { buildManifest, parseManifestArgs } from "../../src/cli/manifest";

describe("manifest CLI", () => {
  it("default (socket) output is unchanged: socket_mode_enabled, no request_urls", () => {
    const m = buildManifest();
    expect(m.settings.socket_mode_enabled).toBe(true);
    expect(m.settings.event_subscriptions.request_url).toBeUndefined();
    expect(m.settings.interactivity.request_url).toBeUndefined();
    expect(m.settings.interactivity.is_enabled).toBe(true);
    expect(m.display_information.name).toBe("slaude");
    expect(m.oauth_config.scopes.bot).toContain("app_mentions:read");
    // No slash_commands in either mode — commands are plain message text.
    expect(m.features.slash_commands).toBeUndefined();
  });

  it("--mode http emits request_urls and omits socket_mode_enabled", () => {
    const m = buildManifest({ mode: "http", url: "https://gw.example.com/" });
    expect(m.settings.event_subscriptions.request_url).toBe(
      "https://gw.example.com/slack/events",
    );
    expect(m.settings.interactivity.request_url).toBe(
      "https://gw.example.com/slack/interactions",
    );
    expect("socket_mode_enabled" in m.settings).toBe(false);
    // Everything else matches the socket manifest.
    const socket = buildManifest();
    expect(m.oauth_config).toEqual(socket.oauth_config);
    expect(m.settings.event_subscriptions.bot_events).toEqual(
      socket.settings.event_subscriptions.bot_events,
    );
  });

  it("--mode http without --url throws", () => {
    expect(() => buildManifest({ mode: "http" })).toThrow(/--url/);
  });

  it("parseManifestArgs handles flags and rejects junk", () => {
    expect(parseManifestArgs([])).toEqual({ mode: "socket", url: undefined });
    expect(parseManifestArgs(["--mode", "http", "--url", "https://x"])).toEqual({
      mode: "http",
      url: "https://x",
    });
    expect(() => parseManifestArgs(["--mode", "tcp"])).toThrow(/--mode/);
    expect(() => parseManifestArgs(["--url"])).toThrow(/--url/);
    expect(() => parseManifestArgs(["--wat"])).toThrow(/unknown argument/);
  });

  it("script entry emits the same default JSON on stdout", async () => {
    const proc = Bun.spawn(["bun", "src/cli/manifest.ts"], {
      cwd: `${import.meta.dir}/../..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(out)).toEqual(buildManifest());
  });

  it("script entry exits 1 with a message on bad args", async () => {
    const proc = Bun.spawn(["bun", "src/cli/manifest.ts", "--mode", "http"], {
      cwd: `${import.meta.dir}/../..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(err).toContain("--url");
  });
});
