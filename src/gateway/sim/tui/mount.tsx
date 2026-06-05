/** @jsxImportSource @opentui/react */
import { createCliRenderer, CliRenderEvents } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { ReplController } from "../repl";
import { App } from "./app";

export interface MountOpts {
  hint: string;
  helpLines: string[];
}

/** Mount the OpenTUI React view over a ReplController and resolve once the renderer is destroyed
 *  (Ctrl-C / Ctrl-D — exitOnCtrlC tears the renderer down and emits CliRenderEvents.DESTROY).
 *  CliRenderer extends EventEmitter, so we listen for that event and then dispose the controller. */
export async function mountTui(repl: ReplController, opts: MountOpts): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  createRoot(renderer).render(
    <App repl={repl} hint={opts.hint} helpLines={opts.helpLines} />,
  );
  await new Promise<void>((resolve) => {
    renderer.once(CliRenderEvents.DESTROY, () => resolve());
  });
  await repl.dispose();
}
