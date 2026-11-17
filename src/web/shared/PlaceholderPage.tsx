import { Link } from "../lib/router";
import { Card, EmptyState, PageHeader } from "../ui";
import type { NavEntry } from "./AppFrame";

/** Stand-in for a page that a later change builds: its header and a quiet note. */
export function PlaceholderPage({ entry }: { entry: NavEntry }) {
  return (
    <>
      <PageHeader title={entry.label} description={entry.description} />
      <Card>
        <EmptyState title="Not built yet" description={`The ${entry.label.toLowerCase()} page arrives in an upcoming release.`} />
      </Card>
    </>
  );
}

export function NotFoundPage({ home }: { home: string }) {
  return (
    <>
      <PageHeader title="Page not found" description="That address does not match any page here." />
      <Card>
        <EmptyState
          title="Nothing at this address"
          action={
            <Link to={home} className="sl-btn sl-btn--secondary sl-btn--md">
              Go to the start page
            </Link>
          }
        />
      </Card>
    </>
  );
}
