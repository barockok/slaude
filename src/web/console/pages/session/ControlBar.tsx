import { useState } from "react";
import type {
  PermissionMode, SessionControlRequest, SessionControlResponse, SessionRowView,
} from "../../../../gateway/panel/api-types";
import { ApiError } from "../../../lib/api";
import { Button, Dialog, Field, IconChevronDown, Input, Menu, Popover, Select, useToast } from "../../../ui";
import { api } from "../../client";
import { PERMISSION_MODE_LABEL } from "../../lib/format";

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
const MODEL_SUGGESTIONS = ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"];

type Pending = "stop" | "reset" | "model" | "mode" | "unlock" | null;

const DONE: Record<SessionControlRequest["action"], string> = {
  stop: "Stop requested",
  reset: "Session reset",
  model: "Model changed",
  mode: "Permission mode changed",
  "unlock-1on1": "1:1 lock released",
};

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return "Your console role cannot do this. Ask a superadmin.";
    if (e.status === 503) return "This needs the event bus (Redis), and this deployment runs without it.";
    return e.message;
  }
  return (e as Error).message;
}

/**
 * Stop, model, and the rest behind "More": permission mode, unlock 1:1 and
 * reset. Reset and permission mode are superadmin only (the server checks
 * too); for an operator they stay visible but disabled, with the reason.
 */
export function ControlBar({
  session, isSuperadmin, onChanged,
}: { session: SessionRowView; isSuperadmin: boolean; onChanged: (s: SessionRowView | null) => void }) {
  const toast = useToast();
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState(session.model);
  const [mode, setMode] = useState<PermissionMode>((session.permission_mode as PermissionMode) || "default");

  const open = (p: Exclude<Pending, null>) => {
    setError(null);
    setModel(session.model);
    setMode((session.permission_mode as PermissionMode) || "default");
    setPending(p);
  };
  const close = () => {
    if (!busy) setPending(null);
  };

  const run = async (body: SessionControlRequest) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<SessionControlResponse>(`/api/sessions/${encodeURIComponent(session.id)}/control`, body);
      onChanged(r.session);
      toast({ title: DONE[body.action], tone: "success" });
      setPending(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const superOnly = isSuperadmin ? "" : " (superadmin)";
  const errorLine = error && (
    <p className="sl-form__error" role="alert">
      {error}
    </p>
  );

  return (
    <>
      <div className="sl-controls">
        <Button onClick={() => open("stop")}>Stop</Button>
        <Button onClick={() => open("model")}>Change model</Button>
        <Popover
          kind="menu"
          align="end"
          trigger={(p) => (
            <Button {...p} iconEnd={<IconChevronDown size={16} />}>
              More
            </Button>
          )}
        >
          {(done) => (
            <Menu
              label="More session actions"
              onDone={done}
              items={[
                { key: "mode", label: `Permission mode${superOnly}`, disabled: !isSuperadmin, onSelect: () => open("mode") },
                {
                  key: "unlock",
                  label: "Unlock 1:1",
                  disabled: !session.slack_thread_ts,
                  onSelect: () => open("unlock"),
                },
                { key: "reset", label: `Reset session${superOnly}`, danger: true, disabled: !isSuperadmin, separatorBefore: true, onSelect: () => open("reset") },
              ]}
            />
          )}
        </Popover>
      </div>

      <Dialog
        open={pending === "stop"}
        onClose={close}
        size="sm"
        title="Stop the current turn?"
        description="The agent halts at the next safe point. Work already written to disk stays. This is recorded in the audit trail."
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void run({ action: "stop" })}>
              Stop turn
            </Button>
          </>
        }
      >
        {errorLine}
      </Dialog>

      <Dialog
        open={pending === "reset"}
        onClose={close}
        size="sm"
        title="Reset this session?"
        description="The next message starts a fresh Claude process for this thread, without the conversation so far. The transcript is kept. This is recorded in the audit trail."
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void run({ action: "reset" })}>
              Reset session
            </Button>
          </>
        }
      >
        {errorLine}
      </Dialog>

      <Dialog
        open={pending === "unlock"}
        onClose={close}
        size="sm"
        title="Unlock 1:1?"
        description="Anyone in the channel can talk to the agent in this thread again. A personal environment chosen for the thread is released too."
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void run({ action: "unlock-1on1" })}>
              Unlock
            </Button>
          </>
        }
      >
        {errorLine}
      </Dialog>

      <Dialog
        open={pending === "model"}
        onClose={close}
        title="Change model"
        description="Applies from the next turn in this session. Other sessions keep their model."
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!model.trim() || model.trim() === session.model}
              onClick={() => void run({ action: "model", model: model.trim() })}
            >
              Change model
            </Button>
          </>
        }
      >
        <form
          className="sl-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (model.trim() && model.trim() !== session.model) void run({ action: "model", model: model.trim() });
          }}
        >
          <Field label="Model" hint={`Currently ${session.model}. Any model id your provider serves.`}>
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} className="sl-mono-input" list="sl-model-suggestions" value={model} onChange={(e) => setModel(e.target.value)} autoComplete="off" spellCheck={false} />
            )}
          </Field>
          <datalist id="sl-model-suggestions">
            {MODEL_SUGGESTIONS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {errorLine}
        </form>
      </Dialog>

      <Dialog
        open={pending === "mode"}
        onClose={close}
        title="Permission mode"
        description="How the agent asks before using tools in this session."
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={mode === "bypassPermissions" ? "danger" : "primary"}
              loading={busy}
              disabled={mode === session.permission_mode}
              onClick={() => void run({ action: "mode", mode })}
            >
              Set mode
            </Button>
          </>
        }
      >
        <div className="sl-form">
          <Field label="Mode" hint={`Currently ${PERMISSION_MODE_LABEL[session.permission_mode] ?? session.permission_mode}.`}>
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {PERMISSION_MODE_LABEL[m]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {mode === "bypassPermissions" && (
            <p className="sl-notice is-danger">The agent will use every tool without asking anyone, including commands that change shared systems.</p>
          )}
          {errorLine}
        </div>
      </Dialog>
    </>
  );
}
