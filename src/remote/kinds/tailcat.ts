import { isTailcatAddr } from "../shell";
import { tailcatPing } from "../tailcat";
import type { EnvironmentKind } from "./types";

/** The first kind: SSH over tailcat to the owner's own machine. */
export const tailcatKind: EnvironmentKind = {
  kind: "tailcat",
  label: "Your machine (tailcat)",
  trust: "user-machine",
  fields: [
    {
      id: "addr",
      label: "tailcat address",
      hint: "The address that tailcat serve prints. It is never posted in the thread.",
      placeholder: "address printed by tailcat serve",
    },
  ],
  parse(input) {
    const addr = (input.addr ?? "").trim();
    if (!isTailcatAddr(addr)) return { ok: false, error: "That doesn't look like a tailcat address." };
    return { ok: true, config: { addr } };
  },
  setupGuide(publicKey) {
    return [
      "*Set up a tailcat environment on your machine* (only you can see this):",
      "1. Install tailcat: https://github.com/tailscale/tailcat",
      "2. Once, for an address that survives restarts: `tailcat genkey --key=default`",
      "3. Start the server (keep it running):",
      "```",
      `tailcat serve --key=default --ssh-authorized-keys="${publicKey.trim()}" ssh`,
      "```",
      "4. In the thread, send `/env add` (or `/remote`) and enter the address it prints and a directory in the form (only you see it).",
      "",
      ":warning: Commands run as the account that runs `tailcat serve`, with everything that account can reach. Use a separate account or a container for repos you don't trust.",
    ].join("\n");
  },
  transport: (env) => ({ kind: "tailcat", addr: env.config.addr ?? "" }),
  async status(env) {
    return tailcatPing(env.config.addr ?? "");
  },
  legacyAddr: (env) => env.config.addr ?? "",
};
