import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ConsoleGrantView, CreateGrantRequest, CreateGrantResponse, GrantRole, SubjectKind } from "../../../../gateway/panel/api-types";
import { ApiError } from "../../../lib/api";
import { Button, Dialog, Field, Input, Select } from "../../../ui";
import { api } from "../../client";
import { ROLE_LABEL, SUBJECT_KINDS, SUBJECT_LABEL, rolesFor, subjectIdError, subjectPlaceholder } from "../../lib/grants";

interface FormState {
  subjectKind: SubjectKind;
  subjectId: string;
  role: GrantRole;
  deny: boolean;
  dmOnly: boolean;
  expires: string;
  note: string;
}

const EMPTY: FormState = { subjectKind: "user", subjectId: "", role: "member", deny: false, dmOnly: false, expires: "", note: "" };

/** `datetime-local` value for a time, in local time. */
function localInputValue(at: number): string {
  const d = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function expiryError(v: string): string | null {
  if (!v) return null;
  const ms = new Date(v).getTime();
  if (!Number.isFinite(ms)) return "Enter a valid date and time.";
  if (ms <= Date.now()) return "Pick a time in the future, or leave it empty for no expiry.";
  return null;
}

/** Which field a server message is about, so it shows next to that field. */
function serverField(msg: string): "subjectId" | "expires" | "role" | null {
  if (/subject_?id/i.test(msg)) return "subjectId";
  if (/expires/i.test(msg)) return "expires";
  if (/\brole\b|granted member/i.test(msg)) return "role";
  return null;
}

export interface GrantDialogProps {
  agent: string;
  open: boolean;
  onClose: () => void;
  onCreated: (grant: ConsoleGrantView) => void;
}

export function GrantDialog({ agent, open, onClose, onCreated }: GrantDialogProps) {
  const [f, setF] = useState<FormState>(EMPTY);
  const [touched, setTouched] = useState<{ subjectId?: boolean; expires?: boolean }>({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const idRef = useRef<HTMLInputElement>(null);
  const roleRef = useRef<HTMLSelectElement>(null);
  const expiresRef = useRef<HTMLInputElement>(null);
  const fieldRef = { subjectId: idRef, role: roleRef, expires: expiresRef } as const;

  useEffect(() => {
    if (!open) return;
    setF(EMPTY);
    setTouched({});
    setSubmitted(false);
    setServerError(null);
  }, [open]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setServerError(null);
    setF((prev) => {
      const next = { ...prev, [k]: v };
      if (k === "subjectKind") {
        if (!rolesFor(next.subjectKind).includes(next.role)) next.role = "member";
        if (next.subjectKind !== "user") {
          next.deny = false;
          next.dmOnly = false;
        }
      }
      return next;
    });
  };

  const isUser = f.subjectKind === "user";
  const idErr = subjectIdError(f.subjectKind, f.subjectId);
  const expErr = expiryError(f.expires);
  const srvField = serverError ? serverField(serverError) : null;
  const show = (k: "subjectId" | "expires") => submitted || !!touched[k];
  /**
   * Mark a field touched when focus leaves it, except for a footer button:
   * showing the error there would grow the dialog and move the button between
   * press and release, so the click (Add grant or Cancel) would be lost. Add
   * grant reports the error itself on submit.
   */
  const touch = (k: "subjectId" | "expires", next: EventTarget | null) => {
    if (next instanceof Element && next.closest(".sl-dialog__foot")) return;
    setTouched((t) => ({ ...t, [k]: true }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    // Land on the first field that needs fixing.
    if (idErr || expErr) {
      (idErr ? idRef : expiresRef).current?.focus();
      return;
    }
    const body: CreateGrantRequest = {
      subjectKind: f.subjectKind,
      subjectId: f.subjectId.trim(),
      role: f.role,
      deny: isUser ? f.deny : undefined,
      dmOnly: isUser ? f.dmOnly : undefined,
      expiresAt: f.expires ? new Date(f.expires).getTime() : null,
      note: f.note.trim() || null,
    };
    setBusy(true);
    setServerError(null);
    try {
      const res = await api.post<CreateGrantResponse>(`/api/agents/${encodeURIComponent(agent)}/grants`, body);
      onCreated(res.grant);
    } catch (err) {
      const msg = err instanceof ApiError && err.status === 403 ? "Only a superadmin can change grants." : (err as Error).message;
      setServerError(msg);
      const field = serverField(msg);
      if (field) fieldRef[field].current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Add grant"
      description={`Give a person, channel or workspace a role on ${agent}.`}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="grant-form" loading={busy}>
            Add grant
          </Button>
        </>
      }
    >
      <form id="grant-form" className="sl-form" onSubmit={submit} noValidate>
        {serverError && !srvField && (
          <p className="sl-form__error" role="alert">
            {serverError}
          </p>
        )}
        <div className="sl-form__row">
          <Field label="Subject kind">
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} value={f.subjectKind} onChange={(e) => set("subjectKind", e.target.value as SubjectKind)}>
                {SUBJECT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {SUBJECT_LABEL[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Slack id"
            error={srvField === "subjectId" ? serverError : show("subjectId") ? idErr : null}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                ref={idRef}
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                className="sl-mono-input"
                placeholder={subjectPlaceholder(f.subjectKind)}
                value={f.subjectId}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => set("subjectId", e.target.value.toUpperCase())}
                onBlur={(e) => touch("subjectId", e.relatedTarget)}
              />
            )}
          </Field>
        </div>

        <Field
          label="Role"
          hint={isUser ? "Managers can change the agent, approvers decide its requests, members can talk to it." : "Channels and workspaces can only be members."}
          error={srvField === "role" ? serverError : null}
        >
          {({ id, describedBy, invalid }) => (
            <Select ref={roleRef} id={id} aria-describedby={describedBy} invalid={invalid} value={f.role} onChange={(e) => set("role", e.target.value as GrantRole)}>
              {rolesFor(f.subjectKind).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <fieldset className="sl-checks" disabled={!isUser}>
          <legend className="sl-field__label">Restrictions</legend>
          <label className="sl-check">
            <input type="checkbox" className="sl-checkbox" checked={f.deny} onChange={(e) => set("deny", e.target.checked)} />
            <span>
              <span className="sl-check__label">Deny</span>
              <span className="sl-check__hint">Block this person, even where a channel or workspace grant admits them.</span>
            </span>
          </label>
          <label className="sl-check">
            <input type="checkbox" className="sl-checkbox" checked={f.dmOnly} onChange={(e) => set("dmOnly", e.target.checked)} />
            <span>
              <span className="sl-check__label">Direct messages only</span>
              <span className="sl-check__hint">The grant applies in a DM with the agent, not in channels.</span>
            </span>
          </label>
          {!isUser && <p className="sl-field__hint">Only user grants can deny or be limited to direct messages.</p>}
        </fieldset>

        <Field
          label="Expires"
          hint="Optional. Leave empty for a grant that does not expire."
          error={srvField === "expires" ? serverError : show("expires") ? expErr : null}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              ref={expiresRef}
              id={id}
              type="datetime-local"
              aria-describedby={describedBy}
              invalid={invalid}
              min={localInputValue(Date.now())}
              value={f.expires}
              onChange={(e) => set("expires", e.target.value)}
              onBlur={(e) => touch("expires", e.relatedTarget)}
            />
          )}
        </Field>

        <Field label="Note" hint="Optional. Why this grant exists, for whoever reads it later.">
          {({ id, describedBy }) => (
            <textarea
              id={id}
              aria-describedby={describedBy}
              className="sl-input"
              rows={2}
              maxLength={500}
              value={f.note}
              onChange={(e) => set("note", e.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
