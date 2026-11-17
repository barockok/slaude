/**
 * Starting points for a new guardrail in the console (phase B): examples of
 * Enforced rules (checked by code on every event) and of Guidance (prose the
 * model reads). Each is a whole GUARDRAIL.md; the console puts the name the
 * owner chose into `name:`. A test parses every template with the server's
 * parser, so none can refuse a save.
 */

export interface GuardrailTemplate {
  id: string;
  kind: "enforced" | "guidance";
  label: string;
  description: string;
  md: (name: string) => string;
}

const front = (name: string, description: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\nscope: shared\n${extra}---\n`;

export const GUARDRAIL_TEMPLATES: GuardrailTemplate[] = [
  {
    id: "tool-deny",
    kind: "enforced",
    label: "Deny a tool",
    description: "Refuse calls to a tool, optionally only when one input field matches.",
    md: (name) =>
      `${front(name, "The agent drafts email but never sends it.")}
Draft email for a person to send. Never send it yourself.

\`\`\`rules
- id: no-send
  on: tool
  match:
    tool: "mcp__*__*send*"
    input:
      to: "(?i)@external\\\\.example$"
  action: deny
  message: "Sending email outside the team is not allowed; save a draft instead."
\`\`\`
`,
  },
  {
    id: "tool-approve",
    kind: "enforced",
    label: "Ask an approver before a tool runs",
    description: "Hold matching calls on an approval card for the requester or an approver.",
    md: (name) =>
      `${front(name, "Deploys need an approver.")}
\`\`\`rules
- id: deploy-approval
  on: tool
  match:
    tool: Bash
    input:
      command: "(?i)\\\\bdeploy\\\\b"
  action: approve
  message: "Deploys need an approver."
\`\`\`
`,
  },
  {
    id: "reply-redact",
    kind: "enforced",
    label: "Redact or hold replies",
    description: "Replace matches in what the agent posts, or hold a reply for an approver.",
    md: (name) =>
      `${front(name, "No card numbers in replies; prices need an approver.")}
\`\`\`rules
- id: hide-cards
  on: reply
  match:
    text: "\\\\b\\\\d{4}-\\\\d{4}-\\\\d{4}-\\\\d{4}\\\\b"
  action: redact
- id: prices
  on: reply
  match:
    text: "(?i)\\\\bprice is \\\\$\\\\d+"
  action: approve
  message: "Replies that quote a price need an approver."
\`\`\`
`,
  },
  {
    id: "inbound-deny",
    kind: "enforced",
    label: "Refuse an incoming message",
    description: "Do not pass a message on to the agent, and tell the person why.",
    md: (name) =>
      `${front(name, "Passwords are never pasted into a thread.")}
\`\`\`rules
- id: no-passwords
  on: inbound
  match:
    text: "(?i)password\\\\s*[:=]"
  action: deny
  message: "Please do not paste passwords here."
\`\`\`
`,
  },
  {
    id: "guidance-always",
    kind: "guidance",
    label: "Guidance in every prompt",
    description: "Advisory prose added to the system prompt of every agent it applies to.",
    md: (name) =>
      `${front(name, "How the agent talks about customers.")}
Refer to customers by their company name, never by a person's name, and do not
share one customer's details with another.
`,
  },
  {
    id: "guidance-on-match",
    kind: "guidance",
    label: "Guidance when it becomes relevant",
    description: "Given to the model once per session, the first time a tool or message trigger matches.",
    md: (name) =>
      `${front(name, "How to send invoices.", "load: on-match\ntriggers:\n  tool: [\"mcp__*__*invoice*\"]\n  inbound: \"(?i)invoice\"\n")}
Check the amount and the recipient twice before you send an invoice, and say
which account it is for.
`,
  },
];

export const templateById = (id: string | null): GuardrailTemplate | undefined => GUARDRAIL_TEMPLATES.find((t) => t.id === id);
