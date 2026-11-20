/**
 * Paste-back MCP OAuth without a paste into the chat. The authorize link goes to the
 * person privately with an "Enter code" button; the button opens a modal with one field.
 * What is typed there is never a message anyone else can read. The offer in the button
 * and the modal is the /remote one: bound to the clicking user and a max age.
 */
import { encodeRemoteOffer, type RemoteOffer } from "../core/remote-command";

export const OAUTH_PASTE_ACTION = "slaude_mcp:paste";
export const OAUTH_PASTE_VIEW = "slaude_mcp:paste";
const PASTE_BLOCK = "oauth_paste";

/** The private message: the authorize link, and the button that opens the form. */
export function oauthLinkBlocks(serverName: string, authorizeUrl: string, offer: RemoteOffer): unknown[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:link: Authorize \`${serverName}\`:\n${authorizeUrl}\n\n` +
          "After you approve, the page shows a code or a redirect URL. Click *Enter code* and paste it there. It never goes in the thread.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          action_id: OAUTH_PASTE_ACTION,
          text: { type: "plain_text", text: "Enter code" },
          value: encodeRemoteOffer(offer),
        },
      ],
    },
  ];
}

export function oauthPasteModal(serverName: string, offer: RemoteOffer): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: OAUTH_PASTE_VIEW,
    private_metadata: encodeRemoteOffer(offer),
    title: { type: "plain_text", text: "Finish connecting" },
    submit: { type: "plain_text", text: "Connect" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: PASTE_BLOCK,
        label: { type: "plain_text", text: `Code or redirect URL for ${serverName}` },
        hint: { type: "plain_text", text: "Paste the full redirect URL, or just the code. Only you see this." },
        element: { type: "plain_text_input", action_id: "value" },
      },
    ],
  };
}

/** The submitted value, trimmed ("" when absent). */
export function readOAuthPasteValue(view: { state?: { values?: any } }): string {
  return String(view.state?.values?.[PASTE_BLOCK]?.value?.value ?? "").trim();
}
