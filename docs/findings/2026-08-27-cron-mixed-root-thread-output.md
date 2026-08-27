# Cron mixed root + thread output

## Finding

A channel-target cron could post only top-level messages. The cron binding intentionally
removed its default thread reference, and every call to the surface `reply` tool reused
that same binding. Although `reply` returned the new message reference, there was no way
to use it as the parent of a later reply.

This made a common digest layout impossible in one scheduled run:

1. Post a short summary at the channel root.
2. Post the supporting details in the summary's thread.

## Resolution

The platform-neutral `reply` input now accepts an optional `thread_ref`. When supplied,
the Slack surface uses it as `thread_ts`; otherwise it preserves the session's existing
default destination. The tool description tells the agent to post the root summary
first, then pass its returned `ref` as `thread_ref` for detail replies.

This keeps existing behavior unchanged for normal conversations and cron jobs that only
target a channel root or an existing thread. It also avoids storing a transient Slack
message timestamp in the cron job: each run creates its own root and threads beneath it.

## Regression coverage

- A channel-root reply returns its message reference.
- A later reply can use that reference as its parent.
- The MCP adapter forwards `thread_ref` to the surface.
