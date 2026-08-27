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
    post_message: {
      name: "post_message",
      description:
        "Post a message to ANY channel or DM the bot token can reach — not bound to this session's thread. Use to proactively notify a different channel, or drop into a thread this session doesn't own. Unlike `reply`, this is fire-and-forget: a human reply there won't route back to this session unless the bot is @-mentioned in it.",
      schema: {
        channel: z.string().describe("Target channel or DM id (C…/G…/D…)."),
        text: z.string().describe("Message body. Markdown supported."),
        thread_ts: z.string().optional().describe("Reply inside this thread; omit to post a new top-level message."),
        broadcast: z.boolean().optional().describe("With thread_ts set, also show the reply in the channel (reply_broadcast)."),
      },
    },
    delete: {
      name: "delete",
      description:
        "Delete a message. Slack only allows deleting messages posted by this same bot/user token (no admin-delete of others' messages without elevated scope).",
      schema: {
        ts: z.string().describe("Timestamp of the message to delete."),
        channel: z.string().optional().describe("Channel id. Defaults to the current session's channel."),
      },
    },
    post_ephemeral: {
      name: "post_ephemeral",
      description: "Post a message visible only to one user in a channel — for hints or scoped feedback nobody else sees.",
      schema: {
        user: z.string().describe("User id who will see the message."),
        text: z.string().describe("Message body. Markdown supported."),
        channel: z.string().optional().describe("Channel id. Defaults to the current session's channel."),
        thread_ts: z.string().optional().describe("Post inside a thread."),
      },
    },
    pin: {
      name: "pin",
      description: "Pin a message in a channel.",
      schema: {
        ts: z.string().describe("Timestamp of the message to pin."),
        channel: z.string().optional().describe("Channel id. Defaults to the current session's channel."),
      },
    },
    unpin: {
      name: "unpin",
      description: "Unpin a previously pinned message.",
      schema: {
        ts: z.string().describe("Timestamp of the message to unpin."),
        channel: z.string().optional().describe("Channel id. Defaults to the current session's channel."),
      },
    },
    set_topic: {
      name: "set_topic",
      description: "Set a channel's topic.",
      schema: {
        topic: z.string().describe("New topic text."),
        channel: z.string().optional().describe("Channel id. Defaults to the current session's channel."),
      },
    },
    set_purpose: {
      name: "set_purpose",
      description: "Set a channel's purpose/description.",
      schema: {
        purpose: z.string().describe("New purpose text."),
        channel: z.string().optional().describe("Channel id. Defaults to the current session's channel."),
      },
    },
    create_canvas: {
      name: "create_canvas",
      description: "Create (or attach) a channel's Canvas with markdown content.",
      schema: {
        markdown: z.string().describe("Initial Canvas content, as markdown."),
        title: z.string().optional().describe("Canvas title."),
        channel: z.string().optional().describe("Channel id. Defaults to the current session's channel."),
      },
    },
    append_canvas: {
      name: "append_canvas",
      description: "Append markdown content to the end of a channel's Canvas.",
      schema: {
        markdown: z.string().describe("Markdown content to append."),
        channel: z.string().optional().describe("Channel id. Defaults to the current session's channel."),
      },
    },
    prepend_canvas: {
      name: "prepend_canvas",
      description: "Prepend markdown content to the start of a channel's Canvas.",
      schema: {
        markdown: z.string().describe("Markdown content to prepend."),
        channel: z.string().optional().describe("Channel id. Defaults to the current session's channel."),
      },
    },
    read_canvas: {
      name: "read_canvas",
      description: "Read a channel's Canvas content as raw markdown.",
      schema: {
        channel: z.string().optional().describe("Channel id. Defaults to the current session's channel."),
      },
    },
  },
} as const satisfies ServerContract;
