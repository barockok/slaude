import { ApiError } from "../../lib/api";
import { Button, EmptyState } from "../../ui";

/** A failed load: what failed, the server's reason, and a retry. */
export function ErrorState({ what, error, onRetry }: { what: string; error: Error; onRetry: () => void }) {
  const status = error instanceof ApiError ? error.status : null;
  const description =
    status === 404 ? "It may have been removed or renamed." : status === 403 ? "Your console role cannot see this." : error.message;
  return (
    <EmptyState
      title={status === 404 ? `${what} not found` : `Could not load ${what.toLowerCase()}`}
      description={description}
      action={<Button onClick={onRetry}>Try again</Button>}
    />
  );
}
