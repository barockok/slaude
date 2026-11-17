// Flatten an inbound Slack message to the plain text the agent reads.
//
// Bots and integrations (Grafana, CI, PagerDuty, ...) put the body in legacy
// `attachments` or Block Kit `blocks`, with `text` either empty or a short
// notification fallback. Reading only `m.text` hands the agent an empty or
// one-line message, so collect text from all three, in render order.

export function messageToText(m: any): string {
  if (!m) return "";
  const out: string[] = [];
  const push = (s?: unknown) => {
    if (typeof s === "string" && s.trim()) out.push(s.trim());
  };

  const text = typeof m.text === "string" ? m.text.trim() : "";
  push(text);

  for (const b of (m.blocks ?? []) as any[]) {
    switch (b?.type) {
      case "header":
      case "section":
        push(b.text?.text);
        for (const f of (b.fields ?? []) as any[]) push(f?.text);
        break;
      case "context":
        for (const e of (b.elements ?? []) as any[]) push(e?.text);
        break;
      case "rich_text":
        // A human message's rich_text mirrors `text`; only use it as a fallback.
        if (!text) push(richText(b.elements));
        break;
    }
  }

  for (const a of (m.attachments ?? []) as any[]) {
    // Link unfurls repeat a URL already present in `text`.
    if (a?.from_url && text) continue;
    const before = out.length;
    push(a.pretext);
    push(a.author_name);
    push(a.title && a.title_link ? `${a.title} (${a.title_link})` : a.title);
    push(a.text);
    for (const f of (a.fields ?? []) as any[]) {
      push(f?.title ? `${f.title}: ${f.value ?? ""}` : f?.value);
    }
    for (const b of (a.blocks ?? []) as any[]) push(b?.text?.text);
    push(a.footer);
    if (out.length === before) push(a.fallback);
  }

  return [...new Set(out)].join("\n");
}

// Human messages carry `user`; bot and integration posts often only carry
// `bot_id` plus a display name. Whoever sets up the integration picks that
// name, so it can read like a real user ID: it is always returned with a
// `bot:` prefix and never as a bare value.
export function messageAuthor(m: any): string {
  if (typeof m?.user === "string" && m.user) return m.user;
  const bot = messageBot(m);
  const label = bot.bot_name ?? bot.bot_id;
  return label ? `bot:${label}` : "";
}

// The bot identity of a message, kept apart from the Slack user ID.
export function messageBot(m: any): { bot_id?: string; bot_name?: string } {
  const name = m?.bot_profile?.name ?? m?.username;
  return {
    ...(typeof m?.bot_id === "string" && m.bot_id ? { bot_id: m.bot_id } : {}),
    ...(typeof name === "string" && name ? { bot_name: name } : {}),
  };
}

// The children of a `rich_text` block (section, list, preformatted, quote)
// each render on their own line or lines.
function richText(els: any[] = []): string {
  return els
    .map((e) => richBlock(e).replace(/^\n+|\s+$/g, ""))
    .filter(Boolean)
    .join("\n");
}

function richBlock(e: any): string {
  const els: any[] = Array.isArray(e?.elements) ? e.elements : [];
  switch (e?.type) {
    case "rich_text_list": {
      const pad = "  ".repeat(e.indent ?? 0);
      const first = (e.offset ?? 0) + 1;
      return els
        .map((item, i) => `${pad}${e.style === "ordered" ? `${first + i}.` : "•"} ${richBlock(item).trim()}`)
        .join("\n");
    }
    case "rich_text_preformatted":
      return "```\n" + richInline(els).replace(/\n+$/, "") + "\n```";
    case "rich_text_quote":
      return richInline(els)
        .trim()
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    default:
      return Array.isArray(e?.elements) ? richInline(els) : richInline([e]);
  }
}

function richInline(els: any[] = []): string {
  return els
    .map((e) => {
      switch (e?.type) {
        case "text":
          return e.text ?? "";
        case "link":
          return e.text ? `${e.text} (${e.url})` : e.url ?? "";
        case "user":
          return `<@${e.user_id}>`;
        case "usergroup":
          return `<!subteam^${e.usergroup_id}>`;
        case "channel":
          return `<#${e.channel_id}>`;
        case "emoji":
          return `:${e.name}:`;
        case "broadcast":
          return `@${e.range}`;
        default:
          return e?.text ?? "";
      }
    })
    .join("");
}
