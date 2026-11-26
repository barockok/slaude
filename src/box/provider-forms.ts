/**
 * Which provider credential forms a boxed persona may use.
 *
 * No secret enters a box, so a boxed CLI runs with a placeholder and the node
 * worker's provider proxy supplies the real credential. That must work for a
 * form before a persona using the form can be boxed (box spec, "The provider
 * proxy is a hard requirement").
 *
 * TODO(box spike 3, scripts/spike/box/03-provider.ts, kill criterion K3): this
 * set is the ASSUMPTION that all three forms pass, written before the spike
 * was run. When the spike's field note is in, remove from this set every form
 * it failed (the OAuth token form is the uncertain one). A form outside the
 * set makes a persona not boxable: the sync warns, and the token is never put
 * into a box to make it work.
 */
import type { ProviderForm } from "./env";

export const BOX_SUPPORTED_PROVIDER_FORMS: ReadonlySet<ProviderForm> = new Set<ProviderForm>(["api-key", "auth-token", "oauth-token"]);

/** The provider fields of a persona (agent.yaml `provider`) and the form each one is. */
export const PROVIDER_FIELD_FORM: Readonly<Record<"apiKey" | "authToken" | "oauthToken", ProviderForm>> = {
  apiKey: "api-key",
  authToken: "auth-token",
  oauthToken: "oauth-token",
};

/** The forms a persona's provider object declares (a reference per field; the value is never read here). */
export function declaredProviderForms(provider: { apiKey?: unknown; authToken?: unknown; oauthToken?: unknown } | null | undefined): ProviderForm[] {
  if (!provider) return [];
  return (Object.keys(PROVIDER_FIELD_FORM) as Array<keyof typeof PROVIDER_FIELD_FORM>)
    .filter((f) => provider[f] !== undefined && provider[f] !== null)
    .map((f) => PROVIDER_FIELD_FORM[f]);
}

/** The declared forms a box cannot serve, given the supported set. */
export function unboxableProviderForms(
  provider: Parameters<typeof declaredProviderForms>[0],
  supported: ReadonlySet<ProviderForm> = BOX_SUPPORTED_PROVIDER_FORMS,
): ProviderForm[] {
  return declaredProviderForms(provider).filter((f) => !supported.has(f));
}
