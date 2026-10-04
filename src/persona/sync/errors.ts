/**
 * The sync payload's validation error. Its own module so src/secrets (whose
 * reference errors are PayloadErrors) and payload.ts (which validates
 * references with src/secrets) do not import each other.
 */
export class PayloadError extends Error {
  readonly status = 422 as const;
}
