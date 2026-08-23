/**
 * Contract for the `slaude_slack` MCP server (Slack-specific read tools plus
 * the deprecated `reply` alias). Interaction tools live in the platform-neutral
 * `slaude_surface` contract.
 */
import { z } from "zod";
import type { ServerContract } from "./types";

export const SLACK_SERVER = "slaude_slack";

export const slackContract = {
  server: SLACK_SERVER,
  tools: {
    reply: {
      name: "reply",
      description:
        "DEPRECATED — use mcp__slaude_surface__reply. Send a message to the user in the current conversation.",
      schema: {
        text: z.string().describe("Message body. Markdown supported."),
      },
    },
    get_user_profile: {
      name: "get_user_profile",
      description:
        "Fetch a Slack user's profile. Use this to learn who you're talking to — their name, title, timezone, status, pronouns, etc. Pass a user ID (e.g. U123ABC). This helps you personalize responses and avoid asking info the profile already contains.",
      schema: {
        user_id: z.string().describe("Slack user ID (e.g. U123ABC)."),
      },
    },
    get_channel_info: {
      name: "get_channel_info",
      description:
        "Get info about the current Slack channel or DM — name, topic, purpose, member count, creation date, and whether it's archived. Helps you understand the conversational context (e.g. is this #general, a private team channel, or a 1:1 DM?).",
      schema: {},
    },
    list_users_in_channel: {
      name: "list_users_in_channel",
      description:
        "List the members of the current Slack channel. Use this to understand who's in the room, find user IDs to look up profiles, or check if a specific person is present. Returns user IDs — call get_user_profile to resolve names/details.",
      schema: {
        limit: z.number().min(1).max(1000).optional().describe("Max members to fetch (1-1000). Default 200."),
      },
    },
    search_messages: {
      name: "search_messages",
      description:
        "Search Slack messages in the workspace. Use this to find prior discussions, decisions, or context the user is referencing. Supports Slack search syntax (e.g. 'from:@alice deploy', 'in:#engineering outage', 'after:2024-01-01'). Results are ordered by relevance.",
      schema: {
        query: z.string().describe("Search query. Slack search syntax supported: from:@user, in:#channel, after:YYYY-MM-DD, before:YYYY-MM-DD, has:link, etc."),
        count: z.number().min(1).max(20).optional().describe("Max results (1-20). Default 10."),
      },
    },
  },
} as const satisfies ServerContract;
