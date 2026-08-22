import type { DecisionNote, DecisionTagSummary } from "../db/decision-notes";
import { validatePermalink } from "./slack-source";

function safeText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function author(value: string): string {
  return /^[UW][A-Z0-9]+$/.test(value) ? `\`${value}\`` : safeText(value);
}

function link(note: DecisionNote): string {
  return `<${validatePermalink(note.sourcePermalink)}|View discussion>`;
}

function preview(value: string, limit = 800): string {
  const safe = safeText(value);
  return safe.length <= limit ? safe : safe.slice(0, limit - 1) + "…";
}

export function renderCreatedNote(note: DecisionNote, created: boolean): string {
  const lines = [
    created
      ? `:white_check_mark: Decision note added to \`#${note.tag}\``
      : `:information_source: This decision note was already saved under \`#${note.tag}\``,
    "",
    `*${safeText(note.title)}*`,
    safeText(note.summary),
    "",
    link(note),
  ];
  if (note.sourceTruncated) {
    lines.push("", ":warning: The source thread exceeded the capture limit; this note uses the latest bounded portion.");
  }
  return lines.join("\n");
}

export function renderHistory(tag: string, notes: DecisionNote[], totalVisible: number): string {
  if (notes.length === 0) return `No decision notes found for \`#${tag}\`.`;
  const lines = [`*Decision history — \`#${tag}\`* (${totalVisible} visible)`];
  for (const note of notes) {
    lines.push(
      "",
      `• *${safeText(note.title)}* — <t:${Math.floor(note.createdAt / 1000)}:d>`,
      `  ${preview(note.summary)}`,
      `  Added by ${author(note.createdBy)} · ${link(note)}`,
    );
  }
  if (totalVisible > notes.length) lines.push("", `_Showing the newest ${notes.length} of ${totalVisible} visible notes._`);
  return lines.join("\n");
}

export function renderTagList(tags: DecisionTagSummary[], totalVisible: number): string {
  if (tags.length === 0) return "No decision note tags found.";
  const lines = [`*Decision note tags* (${totalVisible} visible)`];
  for (const entry of tags) {
    lines.push(
      "",
      `• \`#${entry.tag}\` — ${entry.count} ${entry.count === 1 ? "note" : "notes"} · latest <t:${Math.floor(entry.latest.createdAt / 1000)}:R>`,
      `  ${safeText(entry.latest.title)}`,
    );
  }
  if (totalVisible > tags.length) lines.push("", `_Showing the ${tags.length} most recently active tags._`);
  return lines.join("\n");
}
