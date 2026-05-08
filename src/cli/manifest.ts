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
      ],
    },
  },
  settings: {
    event_subscriptions: {
      bot_events: [
        "app_mention",
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
