// Generate Slack app manifest for slaude.
//
// Usage:
//   bun run manifest                                  # Socket Mode (default)
//   bun run manifest --mode http --url https://host   # Events API over HTTPS
//
// http mode emits event_subscriptions.request_url and
// interactivity.request_url pointing at the gateway's /slack/* endpoints and
// omits socket_mode_enabled. No slash_commands section in either mode:
// slaude parses slash-style commands from plain message text, so there are
// no Slack-registered slash commands to route.

export type ManifestMode = "socket" | "http";

export function buildManifest(opts: { mode?: ManifestMode; url?: string } = {}) {
  const mode = opts.mode ?? "socket";
  const base = (opts.url ?? "").replace(/\/+$/, "");
  if (mode === "http" && !base) {
    throw new Error("manifest --mode http requires --url https://<public-gateway-host>");
  }

  const manifest: any = {
    display_information: {
      name: "slaude",
      description: "Slack-native Claude Code teammate",
      background_color: "#1a1a1a",
    },
    features: {
      bot_user: {
        display_name: "slaude",
        always_online: true,
      },
      // Enable Slack Agent/Assistant — unlocks assistant.threads.setStatus
      // for animated "thinking…" / "running <tool>…" indicators next to the
      // bot name in threads.
      assistant_view: {
        assistant_description: "AI teammate powered by Claude Code",
        suggested_prompts: [],
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "channels:history",
          "channels:read",
          "chat:write",
          "chat:write.public",
          "files:read",
          "files:write",
          "groups:history",
          "groups:read",
          "im:history",
          "im:read",
          "im:write",
          "mpim:history",
          "mpim:read",
          "mpim:write",
          "reactions:read",
          "reactions:write",
          "users:read",
          "users.profile:write",
          "assistant:write",
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: [
          "app_mention",
          "assistant_thread_started",
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim",
        ],
      },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };

  if (mode === "http") {
    manifest.settings.event_subscriptions.request_url = `${base}/slack/events`;
    manifest.settings.interactivity.request_url = `${base}/slack/interactions`;
    delete manifest.settings.socket_mode_enabled;
  }

  return manifest;
}

export function parseManifestArgs(argv: string[]): { mode: ManifestMode; url?: string } {
  let mode: ManifestMode = "socket";
  let url: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") {
      const v = argv[++i];
      if (v !== "socket" && v !== "http") {
        throw new Error(`--mode must be 'socket' or 'http' (got '${v ?? ""}')`);
      }
      mode = v;
    } else if (a === "--url") {
      url = argv[++i];
      if (!url) throw new Error("--url requires a value");
    } else {
      throw new Error(`unknown argument '${a}'`);
    }
  }
  return { mode, url };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(buildManifest(parseManifestArgs(process.argv.slice(2))), null, 2));
  } catch (e: any) {
    console.error(`[manifest] ${e?.message ?? e}`);
    process.exit(1);
  }
}
