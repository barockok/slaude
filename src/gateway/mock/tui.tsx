/** @jsxImportSource @opentui/react */
import { useState, useEffect, useRef } from "react";
import { createCliRenderer, CliRenderEvents } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import type { OutboundCard } from "../sim/transport";
import type { ClientMessage, ServerMessage } from "./protocol";
import { gateBox } from "../sim/render";

const SPINNER = [".·˙", "·˙·", "˙·.", "·.·"];
const THEME_PURPLE = "#a878d6";
const THEME_GREEN = "#50fa7b";
const SUBTLE = "#6a6a6a";

interface TimelineItem {
  id: string;
  kind: "user" | "bot" | "reaction" | "gate" | "system";
  text: string;
}

function SlackTuiApp({ port }: { port: number }) {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [spin, setSpin] = useState(0);
  const [messages, setMessages] = useState<TimelineItem[]>([]);
  const [value, setValue] = useState("");
  const [pendingGate, setPendingGate] = useState<OutboundCard | null>(null);
  const [channel, setChannel] = useState("D0SIM");
  const [managerId, setManagerId] = useState("U_MANAGER");
  const [botName, setBotName] = useState("Agent");

  const wsRef = useRef<WebSocket | null>(null);
  const awaitingReplyRef = useRef(false);
  const renderer = useRenderer();

  // Status spinner animation
  useEffect(() => {
    if (!status) return;
    const id = setInterval(() => setSpin((s) => (s + 1) % SPINNER.length), 100);
    return () => clearInterval(id);
  }, [status]);

  // Connect to Mock Slack Server
  useEffect(() => {
    let unmounted = false;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    function connect() {
      if (unmounted) return;
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (unmounted) return;
        setConnected(true);
        setStatus(null);
      };

      ws.onmessage = (event) => {
        if (unmounted) return;
        try {
          const msg = JSON.parse(String(event.data)) as ServerMessage;
          if (msg.type === "init") {
            setChannel(msg.channel);
            setManagerId(msg.managerUserId);
            if (msg.botName) setBotName(msg.botName);
            // Render past cards
            const initialItems: TimelineItem[] = [];
            for (const c of msg.cards) {
              if (c.kind === "message" && c.text) {
                initialItems.push({ id: Math.random().toString(), kind: "bot", text: c.text });
              } else if (c.kind === "reaction" && c.text) {
                initialItems.push({ id: Math.random().toString(), kind: "reaction", text: c.text });
              } else if ((c.kind === "approval" || c.kind === "permission") && !c.resolved) {
                setPendingGate(c);
                initialItems.push({ id: Math.random().toString(), kind: "gate", text: gateBox(c) });
              }
            }
            setMessages(initialItems);
          } else if (msg.type === "card") {
            const c = msg.card;
            if (c.kind === "message" && c.text) {
              awaitingReplyRef.current = false;
              setStatus(null);
              setMessages((m) => [...m, { id: Math.random().toString(), kind: "bot", text: c.text! }]);
            } else if (c.kind === "reaction" && c.text) {
              if (c.text === ":white_check_mark:") {
                awaitingReplyRef.current = false;
                setStatus(null);
              }
              setMessages((m) => [...m, { id: Math.random().toString(), kind: "reaction", text: `added reaction ${c.text}` }]);
            } else if ((c.kind === "approval" || c.kind === "permission") && !c.resolved) {
              awaitingReplyRef.current = false;
              setStatus(null);
              setPendingGate(c);
              setMessages((m) => [...m, { id: Math.random().toString(), kind: "gate", text: gateBox(c) }]);
            }
          } else if (msg.type === "status") {
            if (!msg.status) {
              setStatus(null);
            } else if (awaitingReplyRef.current) {
              setStatus(msg.status);
            }
          }
        } catch {}
      };

      ws.onclose = () => {
        if (unmounted) return;
        setConnected(false);
        wsRef.current = null;
        reconnectTimeout = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      unmounted = true;
      clearTimeout(reconnectTimeout);
      wsRef.current?.close();
    };
  }, [port]);

  useKeyboard((e) => {
    if (e.ctrl && (e.name === "c" || e.name === "d")) {
      renderer.destroy();
    }
  });

  const onSubmit = (text: string) => {
    const trimmed = text.trim();
    setValue("");
    if (!trimmed) return;

    if (trimmed === "/clear") {
      setMessages([]);
      return;
    }

    if (trimmed === "/help") {
      setMessages((m) => [
        ...m,
        {
          id: Math.random().toString(),
          kind: "system",
          text: "Mock Slack commands:\n  <message>    Send message to Maria in DM\n  a / d / A    Answer pending approval/permission gate (allow/deny/always)\n  /clear       Clear screen\n  Ctrl-C       Exit TUI",
        },
      ]);
      return;
    }

    // Check if answering an open gate
    if (pendingGate && ["a", "d", "A", "allow", "deny", "always"].includes(trimmed)) {
      const verb = trimmed === "a" || trimmed === "allow" ? "allow" : trimmed === "d" || trimmed === "deny" ? "deny" : "always";
      const targetAction = pendingGate.actionIds.find((id) => id.includes(`:${verb}:`)) ?? pendingGate.actionIds[0];
      if (targetAction && wsRef.current) {
        const actionMsg: ClientMessage = { type: "action", actionId: targetAction, user: managerId };
        wsRef.current.send(JSON.stringify(actionMsg));
        setPendingGate(null);
        awaitingReplyRef.current = true;
        setStatus("Thinking…");
        setMessages((m) => [...m, { id: Math.random().toString(), kind: "user", text: `[Action: ${verb}]` }]);
        return;
      }
    }

    // Send user message
    setMessages((m) => [...m, { id: Math.random().toString(), kind: "user", text: trimmed }]);
    awaitingReplyRef.current = true;
    setStatus("Thinking…");

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const clientMsg: ClientMessage = {
        type: "message",
        text: trimmed,
        user: managerId,
        channel,
      };
      wsRef.current.send(JSON.stringify(clientMsg));
    } else {
      setMessages((m) => [
        ...m,
        { id: Math.random().toString(), kind: "system", text: "⚠️ Not connected to Slaude mock server." },
      ]);
    }
  };

  return (
    <box flexDirection="column" height="100%">
      {/* Header bar */}
      <box flexDirection="row" border={["bottom"]} borderColor="#3a3a3a" paddingLeft={1} paddingRight={1} justifyContent="space-between">
        <box flexDirection="row" gap={2}>
          <text fg={THEME_PURPLE}><b># {botName} (Mock Slack DM)</b></text>
          <text fg={SUBTLE}>channel: {channel} · user: {managerId}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={connected ? THEME_GREEN : "#ff5555"}>
            {connected ? "● Connected" : "○ Disconnected (reconnecting...)"}
          </text>
        </box>
      </box>

      {/* Main chat timeline */}
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
        {!connected && messages.length === 0 ? (
          <box flexDirection="column" paddingTop={2}>
            <text fg="#ffb86c">Waiting for Slaude Mock Server on port {port}...</text>
            <text fg={SUBTLE}>Please start the server in another terminal:</text>
            <text fg={THEME_PURPLE}>  bun run start:mock</text>
          </box>
        ) : null}

        {messages.map((item) => {
          if (item.kind === "user") {
            return (
              <box key={item.id} flexDirection="column" marginTop={1}>
                <text fg="#8be9fd"><b>You</b> › {item.text}</text>
              </box>
            );
          }
          if (item.kind === "bot") {
            return (
              <box key={item.id} flexDirection="column" marginTop={1}>
                <text fg={THEME_PURPLE}><b>{botName}</b> ⏺</text>
                <text>{item.text}</text>
              </box>
            );
          }
          if (item.kind === "reaction") {
            return (
              <box key={item.id} flexDirection="row" marginTop={0}>
                <text fg={SUBTLE}>  ↳ {item.text}</text>
              </box>
            );
          }
          if (item.kind === "gate") {
            return (
              <box key={item.id} flexDirection="column" marginTop={1}>
                <text fg="#ffb86c">{item.text}</text>
              </box>
            );
          }
          return (
            <box key={item.id} flexDirection="column" marginTop={1}>
              <text fg={SUBTLE}>{item.text}</text>
            </box>
          );
        })}

        {status ? (
          <box marginTop={1}>
            <text fg={THEME_PURPLE}>{`${SPINNER[spin]} ${status}`}</text>
          </box>
        ) : null}
      </scrollbox>

      {/* Input box */}
      <box flexShrink={0} flexDirection="column">
        <box border={["top", "bottom"]} borderColor="#3a3a3a" flexDirection="column">
          <input
            focused
            value={value}
            onInput={setValue}
            onSubmit={(val: any) => onSubmit(typeof val === "string" ? val : value)}
            placeholder={pendingGate ? "Gate open: type 'a' to allow or 'd' to deny..." : "Type a Slack message..."}
          />
        </box>
        <box flexDirection="row" paddingLeft={1} paddingRight={1} justifyContent="space-between">
          <text fg={SUBTLE}>Enter sends · a/d answers gates · /help · Ctrl-C quits</text>
          <text fg={SUBTLE}>ws://localhost:{port}/ws</text>
        </box>
      </box>
    </box>
  );
}

export async function runMockTui() {
  const port = Number(process.env.SLAUDE_MOCK_PORT || 3040);
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  const renderer = await createCliRenderer({ exitOnCtrlC: false, screenMode: "alternate-screen" });
  createRoot(renderer).render(<SlackTuiApp port={port} />);

  await new Promise<void>((resolve) => {
    renderer.once(CliRenderEvents.DESTROY, () => resolve());
  });
  process.exit(0);
}

if (import.meta.main) {
  void runMockTui();
}
