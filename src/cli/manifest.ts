// Generate Slack app manifest for slaude.
// Usage: bun src/cli/manifest.ts > manifest.json

const manifest = {
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

console.log(JSON.stringify(manifest, null, 2));
