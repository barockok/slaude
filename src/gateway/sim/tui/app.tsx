/** @jsxImportSource @opentui/react */
import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { ReplController } from "../repl";
import { replCommandNames } from "../repl";
import { LAYERS, ROLE_NAMES } from "../roles";
import { BEHAVIORS } from "../stub-agent";
import { completeLine, completeArg } from "../complete";
import { routeSubmit } from "./route";
import { useRepl } from "./use-repl";
import { Help } from "./help";
import { Picker } from "./picker";

export interface AppProps {
  repl: ReplController;
  hint: string;
  helpLines: string[];
}

type Overlay =
  | { kind: "none" }
  | { kind: "help" }
  | { kind: "picker"; which: "layer" | "as" };

/** Per-command first-arg candidates for Tab completion (mirrors the readline completer the old
 *  cli.ts had). Command heads themselves complete from replCommandNames(). */
const ARG_MAP: Record<string, string[]> = {
  "/layer": LAYERS.map((l) => l.name),
  "/as": [...ROLE_NAMES],
  "/behavior": Object.keys(BEHAVIORS),
};

/** Root view. Lays out a scrollback of REPL output, an optional live status line, and an input
 *  row — or, when an overlay is active, the help sheet / picker in place of the input. */
export function App({ repl, hint, helpLines }: AppProps) {
  const { messages, status, echo } = useRepl(repl);
  const [value, setValue] = useState("");
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });

  useKeyboard((e) => {
    if (e.name === "escape") {
      if (overlay.kind !== "none") setOverlay({ kind: "none" });
      else repl.abort();
      return;
    }
    if (e.name === "tab" && overlay.kind === "none") {
      const hits = completeArg(value, ARG_MAP);
      const cmd = hits.length ? hits : completeLine(value, replCommandNames());
      if (cmd.length === 1) setValue(cmd[0]!);
      return;
    }
  });

  // Cast to the JSX prop's intersection type: <input onSubmit> is typed as both the core
  // (SubmitEvent) and React (value:string) shapes, which no single signature satisfies. The
  // renderable fires it with the entered string at runtime.
  const onSubmit = submit as unknown as ((event: unknown) => void) & ((value: string) => void);

  function submit(raw: string) {
    setValue("");
    const action = routeSubmit(raw);
    switch (action.kind) {
      case "noop":
        return;
      case "help":
        setOverlay({ kind: "help" });
        return;
      case "picker":
        setOverlay({ kind: "picker", which: action.which });
        return;
      case "send":
        echo(`› ${action.text}`);   // echo the user's line into the timeline
        void repl.handle(action.text);
        return;
    }
  }

  return (
    <box flexDirection="column" height="100%">
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        {messages.map((m, i) => (
          <text key={i}>{m}</text>
        ))}
        {/* The live status (spinner/"Thinking…") sits as the last timeline entry, below the
            last message; when the agent replies, onStatus(null) clears it and the reply is
            already appended in its place. */}
        {status ? <text key="status" fg="#888888">{status}</text> : null}
      </scrollbox>
      {overlay.kind === "help" ? (
        <Help lines={helpLines} />
      ) : overlay.kind === "picker" ? (
        <Picker
          which={overlay.which}
          onCancel={() => setOverlay({ kind: "none" })}
          onPick={(v) => {
            const which = overlay.which; // capture before clearing the overlay
            setOverlay({ kind: "none" });
            echo(`› /${which} ${v}`);
            void repl.handle(`/${which} ${v}`);
          }}
        />
      ) : (
        <box flexDirection="column">
          {/* Top+bottom rules frame the input area so it's clearly distinct from the timeline. */}
          <box border={["top", "bottom"]} flexDirection="column">
            <input
              focused
              value={value}
              onInput={setValue}
              // InputProps.onSubmit is typed as the intersection of the core (SubmitEvent) and the
              // React (value:string) signatures — not satisfiable by one signature, so cast. The
              // runtime fires it with the entered string (API-NOTES); we route that string.
              onSubmit={onSubmit}
              placeholder=""
            />
          </box>
          <text fg="#888888">{hint}</text>
        </box>
      )}
    </box>
  );
}
