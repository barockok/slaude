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
// `bot_id` plus a display name.
export function messageAuthor(m: any): string {
  return m?.user ?? m?.bot_profile?.name ?? m?.username ?? m?.bot_id ?? "";
}

function richText(els: any[] = []): string {
  return els
    .map((e) => {
      if (Array.isArray(e?.elements)) return richText(e.elements) + (e.type === "rich_text_section" ? "" : "\n");
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
    .join("")
    .trim();
}
