/**
 * `/env` Block Kit: the private picker (Use buttons + Add environment) and the
 * Add modal, whose fields follow the selected kind (environments spec §8).
 * Values typed into the modal never appear in the thread. Every payload is
 * bound to the clicking user and a max age, as for the /remote Connect form.
 */
import { getKind, listKinds, type EnvironmentKind, type StoredEnv } from "../../remote/kinds";
import { decodeRemoteOffer, encodeRemoteOffer, type DecodedOffer, type RemoteOffer } from "./remote-command";

export const ENV_USE_ACTION = "slaude_env:use";
export const ENV_ADD_ACTION = "slaude_env:add";
export const ENV_KIND_ACTION = "slaude_env:kind";
export const ENV_ADD_VIEW = "slaude_env:add";

const NAME_BLOCK = "env_name";
const DIR_BLOCK = "env_dir";
const FIELD_PREFIX = "env_f_";

/** A picker or modal payload: the /remote offer plus an environment id or kind. */
export interface EnvOffer extends RemoteOffer {
  envId?: string;
  kindName?: string;
}

export function encodeEnvOffer(o: EnvOffer): string {
  const base = JSON.parse(encodeRemoteOffer(o)) as Record<string, unknown>;
  return JSON.stringify({ ...base, ...(o.envId ? { e: o.envId } : {}), ...(o.kindName ? { k: o.kindName } : {}) });
}

export type DecodedEnvOffer =
  | { ok: true; offer: EnvOffer }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "expired"; offer: EnvOffer };

export function decodeEnvOffer(raw: string | undefined, clicker: string | undefined, now = Date.now()): DecodedEnvOffer {
  const d: DecodedOffer = decodeRemoteOffer(raw, clicker, now);
  if (!("offer" in d)) return d;
  let extra: { e?: unknown; k?: unknown } = {};
  try { extra = JSON.parse(raw!); } catch {}
  const offer: EnvOffer = {
    ...d.offer,
    ...(typeof extra.e === "string" && extra.e ? { envId: extra.e } : {}),
    ...(typeof extra.k === "string" && extra.k ? { kindName: extra.k } : {}),
  };
  return d.ok ? { ok: true, offer } : { ok: false, reason: "expired", offer };
}

/** The private /env picker: the user's environments, each with a Use button. */
export function envPickerBlocks(offer: RemoteOffer, envs: StoredEnv[], currentId?: string): unknown[] {
  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: envs.length
          ? "*Your environments* (only you can see this). Pick one to run this thread's shell and file tools there."
          : "You have no environments yet. Add one to run this thread's shell and file tools on your machine or in a sandbox.",
      },
    },
  ];
  for (const e of envs.slice(0, 20)) {
    const kind = getKind(e.kind);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${e.name}* — ${kind?.label ?? e.kind}${e.defaultDir ? `\n\`${e.defaultDir}\`` : ""}${currentId === e.id ? "\n_this thread_" : ""}` },
      ...(kind && currentId !== e.id
        ? {
            accessory: {
              type: "button",
              action_id: ENV_USE_ACTION,
              text: { type: "plain_text", text: "Use" },
              value: encodeEnvOffer({ ...offer, envId: e.id }),
            },
          }
        : {}),
    });
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: ENV_ADD_ACTION,
        style: "primary",
        text: { type: "plain_text", text: "Add environment" },
        value: encodeEnvOffer(offer),
      },
    ],
  });
  return blocks;
}

/** The Add modal for one kind (the first registered one by default). */
export function envAddModal(offer: EnvOffer): Record<string, unknown> {
  const kinds = listKinds();
  const kind: EnvironmentKind = getKind(offer.kindName ?? "") ?? kinds[0]!;
  const option = (k: EnvironmentKind) => ({ text: { type: "plain_text", text: k.label }, value: k.kind });
  return {
    type: "modal",
    callback_id: ENV_ADD_VIEW,
    private_metadata: encodeEnvOffer({ ...offer, kindName: kind.kind }),
    title: { type: "plain_text", text: "Add environment" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "actions",
        block_id: "env_kind",
        elements: [
          {
            type: "static_select",
            action_id: ENV_KIND_ACTION,
            placeholder: { type: "plain_text", text: "Kind" },
            options: kinds.map(option),
            initial_option: option(kind),
          },
        ],
      },
      {
        type: "input",
        block_id: NAME_BLOCK,
        label: { type: "plain_text", text: "Name" },
        hint: { type: "plain_text", text: "Lowercase letters, digits, . _ - (e.g. laptop). Shown in the thread." },
        element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: kind.kind === "tailcat" ? "laptop" : kind.kind } },
      },
      ...kind.fields.map((f) => ({
        type: "input",
        block_id: `${FIELD_PREFIX}${f.id}`,
        optional: !!f.optional,
        label: { type: "plain_text", text: f.label },
        ...(f.hint ? { hint: { type: "plain_text", text: f.hint } } : {}),
        element: { type: "plain_text_input", action_id: "value", ...(f.placeholder ? { placeholder: { type: "plain_text", text: f.placeholder } } : {}) },
      })),
      {
        type: "input",
        block_id: DIR_BLOCK,
        optional: true,
        label: { type: "plain_text", text: "Directory" },
        hint: { type: "plain_text", text: "Absolute path or starting with ~/. Given: this thread switches to the new environment now." },
        element: { type: "plain_text_input", action_id: "value", placeholder: { type: "plain_text", text: "~/code/my-repo" } },
      },
    ],
  };
}

/** The submitted Add modal's values, trimmed. `dir` is undefined when empty. */
export function readEnvAddValues(view: { state?: { values?: any } }, kind: EnvironmentKind): { name: string; fields: Record<string, string>; dir?: string } {
  const values = view.state?.values ?? {};
  const field = (block: string) => String(values?.[block]?.value?.value ?? "").trim();
  const fields: Record<string, string> = {};
  for (const f of kind.fields) {
    const v = field(`${FIELD_PREFIX}${f.id}`);
    if (v) fields[f.id] = v;
  }
  const dir = field(DIR_BLOCK);
  return { name: field(NAME_BLOCK), fields, ...(dir ? { dir } : {}) };
}
