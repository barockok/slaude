import { ErrorState as SharedErrorState } from "../../shared/ErrorState";

/** The shared error state, with the console's wording for a 403. */
export function ErrorState(props: { what: string; error: Error; onRetry: () => void }) {
  return <SharedErrorState {...props} forbidden="Your console role cannot see this." />;
}
