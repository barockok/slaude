import { describe, expect, test } from "bun:test";
import { displayTitle, titleFromSlug } from "../../src/knowledge/memory-browse";

const UUID = "0842e8f7-b41a-44b6-9c3d-2f1e0a9b7c55";
const AT = Date.UTC(2026, 10, 7, 9, 30);

describe("memory page titles", () => {
  test("a title that only repeats the slug is not the page's own", () => {
    expect(titleFromSlug("0842e8f7 B41a 44b6 9c3d 2f1e0a9b7c55", `conversations/${UUID}`)).toBe(true);
    expect(titleFromSlug("Deploy Rollback", "runbooks/deploy-rollback")).toBe(true);
    expect(titleFromSlug("Rolling back a deploy", "runbooks/deploy-rollback")).toBe(false);
  });

  test("the frontmatter title wins", () => {
    expect(displayTitle({ slug: "notes/x", title: "X", frontmatterTitle: "From frontmatter" })).toBe("From frontmatter");
  });

  test("a conversation record: Conversation, its date and a short id", () => {
    const slugTitle = "0842e8f7 B41a 44b6 9c3d 2f1e0a9b7c55";
    expect(displayTitle({ slug: `conversations/${UUID}`, title: slugTitle, createdAt: AT, updatedAt: AT + 86_400_000 })).toBe("Conversation 2026-11-07 (0842e8f7)");
    expect(displayTitle({ slug: `conversations/${UUID}`, title: slugTitle, updatedAt: AT })).toBe("Conversation 2026-11-07 (0842e8f7)");
    expect(displayTitle({ slug: `conversations/${UUID}`, title: slugTitle })).toBe("Conversation (0842e8f7)");
    // Not a session id: an ordinary page under that folder.
    expect(displayTitle({ slug: "conversations/weekly-sync", title: "Weekly sync notes" })).toBe("Weekly sync notes");
  });

  test("its own title, else the content's first heading, else the title or slug", () => {
    expect(displayTitle({ slug: "runbooks/deploy-rollback", title: "Rolling back a deploy" })).toBe("Rolling back a deploy");
    expect(displayTitle({ slug: "runbooks/deploy-rollback", title: "Deploy Rollback", content: "intro\n# How to roll back\n\nsteps" })).toBe("How to roll back");
    expect(displayTitle({ slug: "runbooks/deploy-rollback", title: "Deploy Rollback" })).toBe("Deploy Rollback");
    expect(displayTitle({ slug: "notes/a", title: "" })).toBe("notes/a");
  });
});
