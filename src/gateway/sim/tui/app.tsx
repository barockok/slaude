/** @jsxImportSource @opentui/react */
import { useState, useEffect } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { ReplController } from "../repl";
import { replCommandNames } from "../repl";
import { LAYERS, ROLE_NAMES } from "../roles";
import { BEHAVIORS } from "../stub-agent";
import { completeLine, completeArg } from "../complete";
import { routeSubmit } from "./route";
import { banner } from "./banner";
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

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]; // braille loader, animated while thinking
const THEME_PURPLE = "#a878d6"; // logo purple, brightened for readability on the dark bg

/** Root view. Lays out a scrollback of REPL output, an optional live status line, and an input
 *  row — or, when an overlay is active, the help sheet / picker in place of the input. */
export function App({ repl, hint, helpLines }: AppProps) {
  const { messages, status, echo } = useRepl(repl);
  const [value, setValue] = useState("");
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  const [exitArmed, setExitArmed] = useState(false); // Ctrl-C pressed once on an empty line
  const [spin, setSpin] = useState(0);
  const renderer = useRenderer();

  // Animate the loader only while a status (e.g. "Thinking…") is active; stop when it clears.
  useEffect(() => {
    if (!status) return;
    const id = setInterval(() => setSpin((s) => (s + 1) % SPINNER.length), 100);
    return () => clearInterval(id);
  }, [status]);

  useKeyboard((e) => {
    // Ctrl-C — shell/claude-code style: close an overlay, else clear a typed line, else (empty)
    // warn once and exit on a second press. exitOnCtrlC is off so we own this.
    if (e.ctrl && e.name === "c") {
      if (overlay.kind !== "none") { setOverlay({ kind: "none" }); return; }
      if (value.length > 0) { setValue(""); setExitArmed(false); return; }
      if (!exitArmed) { setExitArmed(true); echo("(press Ctrl-C again to exit)"); return; }
      renderer.destroy();
      return;
    }
    // Ctrl-D on an empty line quits outright (matches the hint).
    if (e.ctrl && e.name === "d" && overlay.kind === "none" && value.length === 0) {
      renderer.destroy();
      return;
    }
    if (exitArmed) setExitArmed(false); // any other key disarms the exit prompt
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
      {/* Top banner: Amartha logo on the left, "A-Claw" wordmark beside it in the logo's
          purple→blue theme. Row is left-aligned; children vertically centered. */}
      <box flexShrink={0} flexDirection="row" alignItems="center" gap={3}>
        {/* flexShrink={0} so neither is squeezed in the row — the wide logo would otherwise wrap
            to ~2× its height. On a narrow terminal the wordmark clips rather than wrapping. */}
        <box flexShrink={0}>
          <text content={banner} />
        </box>
        <box flexShrink={0}>
          <ascii-font text="A-Claw" font="slick" color={["#7e3f97", "#0087ba"]} />
        </box>
      </box>
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        {messages.map((m, i) => (
          <text key={i}>{m}</text>
        ))}
        {/* The live status (spinner/"Thinking…") sits as the last timeline entry, below the
            last message; when the agent replies, onStatus(null) clears it and the reply is
            already appended in its place. */}
        {status ? (
          <text key="status" fg={THEME_PURPLE}>{`${SPINNER[spin]} ${status}`}</text>
        ) : null}
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
        // Top+bottom rules frame the input area; the hint rides on the bottom rule as its title
        // (bottomTitle) so it shares that row instead of colliding with a separate text line.
        // flexShrink={0} is essential: without it, height pressure from the banner + scrollback
        // collapses the input row and the cursor falls onto the bottom rule (overlap).
        <box
          flexShrink={0}
          border={["top", "bottom"]}
          flexDirection="column"
          bottomTitle={hint}
          bottomTitleAlignment="left"
        >
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
      )}
    </box>
  );
}
