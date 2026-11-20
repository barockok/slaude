/**
 * What a permission or approval card becomes once someone decides it. The card used to
 * be replaced by one line, so the thread lost what had been approved. It now keeps every
 * block it showed (the heading, the redacted input, the approvers) and swaps only the
 * buttons for the decision line, which is an audit entry that stays in the thread.
 */

type Block = Record<string, unknown>;

/** The block_id of a card's auto-deny hint, which a decided or closed card drops. */
export const EXPIRY_BLOCK_ID = "slaude_expiry";

/** The card's blocks with its buttons replaced by `line`, or null when there is nothing to keep. */
export function decidedBlocks(blocks: unknown, line: string): Block[] | null {
  if (!Array.isArray(blocks)) return null;
  let swapped = false;
  const out: Block[] = [];
  for (const b of blocks as Block[]) {
    // The auto-deny hint ("Auto-denies in 300s") stops being true once the card is decided or closed.
    if (b?.block_id === EXPIRY_BLOCK_ID) continue;
    if (b?.type === "actions") {
      if (swapped) continue;
      swapped = true;
      out.push({ type: "context", elements: [{ type: "mrkdwn", text: line }] });
    } else {
      out.push(b);
    }
  }
  return swapped ? out : null;
}

/** A Slack time that renders in each reader's own zone, with a plain UTC fallback. */
export function whenText(now = Date.now()): string {
  const iso = new Date(now).toISOString();
  return `<!date^${Math.floor(now / 1000)}^{time_secs}|${iso.slice(11, 19)} UTC>`;
}

/**
 * Settle a card from a click. Keeps the card's blocks with the decision line; if Slack
 * refuses that (oversize, invalid blocks) it falls back to the one-line card, so a decided
 * card never keeps live buttons.
 */
export async function respondDecided(
  respond: (m: unknown) => Promise<unknown>,
  body: unknown,
  text: string,
  line: string,
): Promise<void> {
  const kept = decidedBlocks((body as { message?: { blocks?: unknown } } | undefined)?.message?.blocks, line);
  if (kept) {
    try {
      await respond({ replace_original: true, text, blocks: kept }); // runtime-ui: decided card keeps its record
      return;
    } catch { /* fall back to the one-line card */ }
  }
  await respond({ replace_original: true, text, blocks: [] }); // runtime-ui: decided card, one line
}

/**
 * A click landed on a card that was never decided (it expired, or its turn was stopped):
 * close the card in place, keeping its record, so it stops offering buttons. Returns false
 * when it could not (no blocks on the click, or Slack refused), and the caller answers the
 * click privately as before.
 */
export async function respondClosed(
  respond: (m: unknown) => Promise<unknown>,
  body: unknown,
  text: string,
  line: string,
): Promise<boolean> {
  const kept = decidedBlocks((body as { message?: { blocks?: unknown } } | undefined)?.message?.blocks, line);
  if (!kept) return false;
  try {
    await respond({ replace_original: true, text, blocks: kept }); // runtime-ui: closed card keeps its record
    return true;
  } catch {
    return false;
  }
}
