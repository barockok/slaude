/**
 * The shape of `personas/<name>/agent.yaml`, defined once.
 *
 * `parseAgentYaml` (agent-def.ts) parses a file with `AgentSchema`, and
 * `scripts/gen-agent-schema.ts` turns the same schema into
 * `docs/site/schemas/agent.schema.json` for editors. Every field's `.describe()` text is
 * written for the operator who edits the file; it shows up as the hover help.
 *
 * What lives here is the shape: keys, types, patterns, lengths, which values
 * may be null. Rules that need more than one value stay in agent-def.ts: the
 * name matching its directory, repeated entries, a valid regular expression,
 * and the soul's own `## Channel` sections.
 *
 * Error messages never carry the offending value. A message here may name the
 * kind of thing expected and a pattern, nothing from the input. Keys are echoed
 * only through `safeKey` (see agent-def.ts).
 */
import { z } from "zod";
import { GUARDRAIL_SLUG_RE } from "../guardrails/format";
import { SKILL_SLUG_RE } from "../skills/loader";

/** Where the docs site serves the generated JSON Schema (docs/site/build.mjs copies docs/site/schemas/). */
export const AGENT_SCHEMA_URL = "https://barockok.github.io/slaude/schemas/agent.schema.json";
/** First line of an exported agent.yaml: editors running yaml-language-server read the schema from it. */
export const AGENT_YAML_MODELINE = `# yaml-language-server: $schema=${AGENT_SCHEMA_URL}`;

export const USER_ID_RE = /^[UW][A-Z0-9]+$/;
export const CHANNEL_ID_RE = /^[CGD][A-Z0-9]+$/;
export const BOUNDARY_RE = /^(?:channel:[CGD][A-Z0-9]+|trust:(?:public|trusted)|dm)$/;
export const DESCRIPTION_MAX = 2000;
/** The one `session` value there is. */
export const SESSION_VALUES = ["channel"] as const;

const NO_VALUE = "has no value: list entries, write [] for none, or remove the key for all";

/**
 * A type error message that depends on what was written: a bare `key:` (null)
 * can mean something other than a wrong type, and a missing required key reads
 * differently again. Only the kind of mistake is looked at, never the value.
 */
const typeMessage = (m: { other: string; null?: string; missing?: string }): z.RawCreateParams => ({
  errorMap: (issue, ctx) => {
    if (issue.code !== z.ZodIssueCode.invalid_type) return { message: ctx.defaultError };
    if (ctx.data === undefined && m.missing) return { message: m.missing };
    if (ctx.data === null && m.null) return { message: m.null };
    return { message: m.other };
  },
});

const text = (what: string) => z.string(typeMessage({ other: `must be ${what}` }));
const idString = (re: RegExp, what: string) => {
  const msg = `must be a ${what} (${re.source})`;
  return z.string(typeMessage({ other: msg })).regex(re, msg);
};
const slugs = (re: RegExp, nullMessage?: string) => {
  const msg = `must be a slug (${re.source})`;
  return z.array(z.string(typeMessage({ other: msg })).regex(re, msg), typeMessage({ other: "must be a list of slugs", null: nullMessage }));
};
const idList = (re: RegExp, what: string) =>
  z.array(idString(re, `${what} id`), typeMessage({ other: `must be a list of ${what} ids` }));
// z.record builds its result with plain assignment, so a `__proto__` key in
// provider or mcp is dropped from the parsed value (it does not become the
// prototype). The old code passed the YAML map through untouched; the key is
// never meaningful in either, and the JSON Schema still allows it.
const mapping = (msg = "must be a mapping") => z.record(z.unknown(), typeMessage({ other: msg }));
/** A key may be left out or written as a bare `key:`; both mean "not set". */
const optional = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();

const scopedEntry = z
  .object(
    {
      boundary: z
        .string(typeMessage({ other: "must be channel:<id>, trust:public, trust:trusted or dm" }))
        .regex(BOUNDARY_RE, "must be channel:<id>, trust:public, trust:trusted or dm")
        .describe(
          "Where this sub-mandate applies: channel:<channel id> for one channel, trust:public or trust:trusted for every channel of that class, or dm for direct messages. Each boundary may appear once. Example: channel:C0EXAMPLE",
        ),
      mode: z
        .unknown()
        .describe(
          "How the text combines with the global mandate: override (replace it, the default), extend (add to it) or reduce (restrict it). Matching ignores case and surrounding spaces. A value that is none of these is accepted with a warning and read as extend, so a typo keeps the global mandate instead of replacing it. Example: extend",
        )
        .optional(),
      text: z
        .string(typeMessage({ other: "must be non-empty text" }))
        .regex(/\S/, "must be non-empty text")
        .describe("The sub-mandate itself, in the agent's own voice of duty. An extend or reduce is carried whole, so keep it under 600 characters. Example: Also watch the deploy queue."),
    },
    typeMessage({ other: "must be a mapping with boundary, mode and text" }),
  )
  .strict();

const approverEntry = z
  .object(
    {
      user: z
        .string(typeMessage({ other: `must be a Slack user id (${USER_ID_RE.source})`, missing: "is required", null: "is required" }))
        .regex(USER_ID_RE, `must be a Slack user id (${USER_ID_RE.source})`)
        .describe("Slack user id of the approver. Required. Example: U0EXAMPLE"),
      scope: optional(
        z
          .string(typeMessage({ other: "must be a string" }))
          .regex(/\S/, "must be non-empty text")
          .describe("What this person may approve, in plain words. Leave it out for an approver of anything (a catch-all). Example: budget changes"),
      ),
      catchall: optional(
        z
          .boolean(typeMessage({ other: "must be true or false" }))
          .describe("true if this person is asked when no other approver's scope fits. Defaults to true when scope is left out, false otherwise."),
      ),
      channel: optional(
        idString(CHANNEL_ID_RE, "Slack channel id").describe(
          "Make this person an approver for one channel only. Leave it out for an approver everywhere. Example: C0EXAMPLE",
        ),
      ),
    },
    typeMessage({ other: "must be a mapping with user, scope and catchall" }),
  )
  .strict();

const accessSchema = z
  .object(
    {
      manager: optional(idString(USER_ID_RE, "Slack user id").describe("The person who manages this agent and can approve for it. Example: U0EXAMPLE")),
      backupManager: optional(idString(USER_ID_RE, "Slack user id").describe("Who covers when the manager is away. Example: U0EXAMPLE")),
      approvers: optional(
        z
          .array(approverEntry, typeMessage({ other: "must be a list of { user, scope, catchall }" }))
          .describe("People who may approve what the agent asks to do, each for a scope of work and optionally one channel."),
      ),
      channels: optional(
        z
          .object(
            {
              public: optional(idList(CHANNEL_ID_RE, "Slack channel").describe("Channels where the agent may speak with anyone present. Example: [C0EXAMPLE]")),
              trusted: optional(idList(CHANNEL_ID_RE, "Slack channel").describe("Channels whose members the agent trusts with more, such as the team's own channel. Example: [C0EXAMPLE]")),
            },
            typeMessage({ other: "must be a mapping" }),
          )
          .strict()
          .describe("Which channels the agent works in, by trust class."),
      ),
      dm: optional(idList(USER_ID_RE, "Slack user").describe("Users the agent answers in direct messages. Example: [U0EXAMPLE]")),
      blocked: optional(idList(USER_ID_RE, "Slack user").describe("Users the agent ignores everywhere. Example: [U0EXAMPLE]")),
      redact: optional(
        z
          .array(
            z.string(typeMessage({ other: "must be a non-empty regular expression" })).min(1, "must be a non-empty regular expression"),
            typeMessage({ other: "must be a list of regular expressions" }),
          )
          .describe("Patterns (JavaScript regular expressions, matched case-insensitively) whose matches are masked before the agent's text reaches Slack. Example: [\"project-[a-z]+\"]"),
      ),
      approvalTimeoutSeconds: optional(
        z
          .number(typeMessage({ other: "must be a non-negative whole number" }))
          .int("must be a non-negative whole number")
          .min(0, "must be a non-negative whole number")
          .describe("Seconds to wait for an approval before denying. 0 or unset uses the default. Example: 120"),
      ),
    },
    typeMessage({ other: "must be a mapping" }),
  )
  .strict();

const channelEntry = z
  .object(
    {
      session: z
        .literal("channel", {
          errorMap: (issue, ctx) =>
            ctx.data === null
              ? { message: "has no value: set it, or remove the key" }
              : { message: 'must be "channel"' },
        })
        .describe('Set to "channel" to keep one long-lived session for this channel instead of one per thread. The only value there is; leave the key out for the default. Example: channel')
        .optional(),
      proactive: z
        .boolean(typeMessage({ other: "must be true or false", null: "has no value: set it, or remove the key" }))
        .describe("true lets the agent wake in this channel on its own and speak up; false keeps it silent here. Setting it implies a channel session. Leave the key out to change nothing.")
        .optional(),
    },
    typeMessage({ other: "must be a mapping" }),
  )
  .strict();

export const AgentSchema = z
  .object(
    {
      name: z
        .string(typeMessage({ other: "must be a string", missing: "is required" }))
        .describe("The agent's name. Must equal the name of the directory the file sits in (personas/<name>/agent.yaml). Required. Example: ana"),
      description: optional(
        z
          .string(typeMessage({ other: "must be a string" }))
          .max(DESCRIPTION_MAX, `is longer than ${DESCRIPTION_MAX} characters`)
          .describe(`One or two lines on what the agent is for; it becomes the agent's role. At most ${DESCRIPTION_MAX} characters. Example: Handles support questions for the platform team.`),
      ),
      model: optional(text("a string").describe("Model the agent runs on, provider-qualified. Leave out for the deployment default. Example: provider/model-name")),
      // An unquoted id can read as a YAML number, which is accepted and written as text.
      slackUserId: optional(
        z
          .union([z.string(), z.number()], typeMessage({ other: "must be a string" }))
          .describe("The agent's Slack user id, as text. Example: U0EXAMPLE"),
      ),
      userToken: optional(
        text("a string").describe("Slack user token to post as the agent's own user, as a placeholder that CI fills in, never the token itself. Example: ${PERSONA_ANA_XOXP}"),
      ),
      provider: optional(
        mapping().describe("Provider credentials and endpoint for this agent (apiKey, baseUrl, and so on). Give credentials as references such as env://PERSONA_ANA_KEY, never as values."),
      ),
      runsOn: optional(text("a string").describe("Label of the machines this agent runs on. Leave out to run anywhere. Example: finance")),
      soul: z
        .string(typeMessage({ other: "must be a non-empty text block (identity and voice)", missing: "must be a non-empty text block (identity and voice)" }))
        .regex(/\S/, "must be a non-empty text block (identity and voice)")
        .describe("Who the agent is and how it sounds: identity, voice, values. Plain prose in a block (soul: |). Required. Mandates and access go in their own keys, not here."),
      mandate: optional(
        z
          .object(
            {
              global: optional(text("a string").describe("What the agent is responsible for everywhere. Example: Answer support questions and keep the runbook current.")),
              scoped: optional(
                z
                  .array(scopedEntry, typeMessage({ other: "must be a list of sub-mandates" }))
                  .describe("Different duties for one channel, a trust class or direct messages. The most specific match applies."),
              ),
            },
            typeMessage({ other: "must be a mapping" }),
          )
          .strict()
          .describe("What the agent is asked to do, globally and per place."),
      ),
      access: optional(accessSchema.describe("Who manages the agent, who approves for it, and where and with whom it works.")),
      mcp: optional(
        mapping().describe("External tool servers, in the same shape as a .mcp.json file: mcpServers: { <name>: { type, url, headers } }. Give secrets as ${PERSONA_*} placeholders."),
      ),
      skills: slugs(SKILL_SLUG_RE, NO_VALUE)
        .describe("Skills this agent may use, by name. Leave the key out for every installed skill; write [] for none. A bare `skills:` is refused. Example: [release-notes, triage]")
        .optional(),
      guardrails: optional(
        slugs(GUARDRAIL_SLUG_RE).describe("Owner guardrails that apply to this agent, by name, in addition to the shared ones. Example: [no-outbound-email]"),
      ),
      memory: optional(
        z
          .object(
            {
              kbSources: z
                .array(z.string(typeMessage({ other: "must be a knowledge-base id" })), typeMessage({ other: "must be a list of knowledge-base ids", null: NO_VALUE }))
                .describe("Knowledge bases the agent reads. Leave the key out for the default; write [] for none. A bare `kbSources:` is refused. Example: [kb-handbook]")
                .optional(),
              background: optional(mapping().describe("Settings for background learning passes, such as budgetUsd and timezone. Example: { budgetUsd: 2, timezone: UTC }")),
            },
            typeMessage({ other: "must be a mapping" }),
          )
          .strict()
          .describe("Knowledge bases and background learning."),
      ),
      channels: optional(
        z
          .record(
            z.string().regex(CHANNEL_ID_RE, "must be a channel id"),
            optional(channelEntry),
            typeMessage({ other: "must be a mapping" }),
          )
          .describe("Per-channel behaviour, keyed by channel id. Example: { C0EXAMPLE: { session: channel, proactive: true } }"),
      ),
    },
    typeMessage({ other: "must be a mapping of the agent's fields" }),
  )
  .strict()
  .describe("A slaude agent: one file per persona, at personas/<name>/agent.yaml. Unknown keys are refused at every level.");

export type AgentFile = z.infer<typeof AgentSchema>;
