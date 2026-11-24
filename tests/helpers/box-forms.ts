/**
 * Flip the one constant that says which provider credential forms a box can
 * serve (src/box/provider-forms.ts). Today it holds all three, the assumption
 * written before the provider spike; a test of the "not boxable" paths takes a
 * form out and puts it back.
 */
import type { ProviderForm } from "../../src/box/env";
import { BOX_SUPPORTED_PROVIDER_FORMS } from "../../src/box/provider-forms";

/** Run `fn` with `forms` taken out of the supported set, then put them back. */
export async function withoutForms<T>(forms: readonly ProviderForm[], fn: () => T | Promise<T>): Promise<T> {
  const set = BOX_SUPPORTED_PROVIDER_FORMS as Set<ProviderForm>;
  const had = forms.filter((f) => set.delete(f));
  try {
    return await fn();
  } finally {
    for (const f of had) set.add(f);
  }
}

export const withoutForm = <T>(form: ProviderForm, fn: () => T | Promise<T>): Promise<T> => withoutForms([form], fn);
