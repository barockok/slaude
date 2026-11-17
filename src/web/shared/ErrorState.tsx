import { ApiError } from "../lib/api";
import { Button, EmptyState } from "../ui";

/**
 * A failed load: what failed, the server's reason, and a retry. `forbidden` is
 * the sentence shown for a 403, worded for the app that renders it.
 */
export function ErrorState({
  what, error, onRetry, forbidden = "You do not have access to this.",
}: { what: string; error: Error; onRetry: () => void; forbidden?: string }) {
  const status = error instanceof ApiError ? error.status : null;
  const description = status === 404 ? "It may have been removed or renamed." : status === 403 ? forbidden : error.message;
  return (
    <EmptyState
      title={status === 404 ? `${what} not found` : `Could not load ${what.toLowerCase()}`}
      description={description}
      action={<Button onClick={onRetry}>Try again</Button>}
    />
  );
}
