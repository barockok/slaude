/**
 * Create or edit a guardrail (phase B, superadmin). The text is GUARDRAIL.md,
 * checked live by the server's own parser (POST /guardrails/validate): rule
 * errors inline, which refuse a save, the always-loaded prose cap and which
 * guardrail tips it, and names in `agents:` no agent has. The server checks
 * again on save. A save carries the revision the editor loaded; if someone
 * else saved first it is refused (409) and the editor offers a reload.
 *
 * A console guardrail's own text is edited. A deploy repo or host-file
 * guardrail gets a console override; its source text stays as synced.
 */
import { useEffect, useRef, useState } from "react";
import type {
  CreateGuardrailRequest, EditGuardrailRequest, GuardrailValidation, GuardrailWriteError, GuardrailWriteResponse, OwnerGuardrailDetail,
} from "../../../../gateway/panel/api-types";
import { ApiError } from "../../../lib/api";
import { Link, navigate, useSearch } from "../../../lib/router";
import { Badge, Button, Card, CopyButton, EmptyState, Field, IconArrowLeft, Input, PageHeader, Select, Skeleton, useToast } from "../../../ui";
import { api } from "../../client";
import { ErrorState } from "../../components/ErrorState";
import { useApi } from "../../hooks/useApi";
import { useRole } from "../../hooks/useRole";
import { guardrailPath } from "./guardrailParts";
import { GUARDRAIL_TEMPLATES, templateById } from "./guardrailTemplates";
import { ACTION_LABEL, GuardrailTestBox } from "./GuardrailTestBox";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VALIDATE_DELAY_MS = 300;

/** The server's verdict on the text, refreshed a moment after each change. */
function useValidation(slug: string, md: string): { v: GuardrailValidation | null; pending: boolean; error: string | null } {
  const [v, setV] = useState<GuardrailValidation | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    setPending(true);
    const t = setTimeout(() => {
      api.post<GuardrailValidation>("/api/guardrails/validate", { slug: slug || "untitled", md }).then(
        (r) => {
          if (n !== seq.current) return;
          setV(r);
          setError(null);
          setPending(false);
        },
        (e: Error) => {
          if (n !== seq.current) return;
          setError(e.message);
          setPending(false);
        },
      );
    }, VALIDATE_DELAY_MS);
    return () => clearTimeout(t);
  }, [slug, md]);
  return { v, pending, error };
}

function ValidationPanel({ v, pending, error }: { v: GuardrailValidation | null; pending: boolean; error: string | null }) {
  if (error) return <p className="sl-notice is-danger" role="alert">{`Could not check the text: ${error}`}</p>;
  if (!v) return <Skeleton height="6rem" radius="var(--sl-radius-panel)" />;
  const others = v.errors.filter((e) => !v.blocking.includes(e));
  return (
    <div className="sl-stack" aria-busy={pending} data-testid="guardrail-validation">
      <div className="sl-title-row">
        {v.ok ? <Badge tone="success">Valid</Badge> : <Badge tone="danger">Cannot be saved</Badge>}
        {others.length > 0 && <Badge tone="warning">{`${others.length} ${others.length === 1 ? "problem" : "problems"}`}</Badge>}
        <span className="sl-caption">{pending ? "Checking..." : "Checked by the server's parser"}</span>
      </div>
      {v.blocking.length > 0 && (
        <div className="sl-notice is-danger" role="alert">
          <p>These refuse a save (an enforced rule must parse, like on /deploy and import):</p>
          <ul className="sl-gr-errors" aria-label="Errors that refuse a save">
            {v.blocking.map((e) => (
              <li key={e} className="sl-break">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}
      {others.length > 0 && (
        <div className="sl-notice is-warning" role="note">
          <p>Saved and shown as problems; its valid rules and Guidance still apply:</p>
          <ul className="sl-gr-errors" aria-label="Problems">
            {others.map((e) => (
              <li key={e} className="sl-break">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}
      {v.unknownAgents.length > 0 && (
        <p className="sl-notice is-warning" role="note">{`No agent of this deployment is named ${v.unknownAgents.join(", ")}; the guardrail does not apply to ${v.unknownAgents.length === 1 ? "it" : "them"}.`}</p>
      )}
      {v.prose.overCap.map((o) => (
        <p key={o.agent} className="sl-notice is-warning" role="note">
          {`Always-loaded Guidance for ${o.agent} would be ${o.chars.toLocaleString()} characters, over the ${v.prose.max.toLocaleString()} cap: ${o.skipped.map((s) => s.name).join(", ")} ${o.skipped.length === 1 ? "is" : "are"} left out of its prompt (rules still apply).`}
        </p>
      ))}
      <p className="sl-caption">
        {`${v.rules.length} enforced ${v.rules.length === 1 ? "rule" : "rules"}${v.rules.length ? `: ${v.rules.map((r) => `${r.id} (${r.on}, ${ACTION_LABEL[r.action].toLowerCase()})`).join(", ")}` : ""}. `}
        {v.load === "on-match" ? "Guidance on match." : `${v.prose.chars.toLocaleString()} characters of always-loaded Guidance (cap ${v.prose.max.toLocaleString()} per agent).`}
        {v.appliesTo.length ? ` Applies to ${v.appliesTo.join(", ")}.` : " Applies to no agent."}
      </p>
    </div>
  );
}

interface EditorProps {
  mode: "create" | "edit";
  detail: OwnerGuardrailDetail | null;
  reload: () => void;
}

function Editor({ mode, detail, reload }: EditorProps) {
  const toast = useToast();
  const canEdit = useRole() === "superadmin";
  const search = new URLSearchParams(useSearch());
  const initialTemplate = templateById(search.get("template")) ?? GUARDRAIL_TEMPLATES[0]!;
  const [templateId, setTemplateId] = useState(initialTemplate.id);
  const [slug, setSlug] = useState(detail?.slug ?? "");
  const [md, setMd] = useState(detail?.md ?? initialTemplate.md("my-guardrail"));
  const [revision, setRevision] = useState(detail?.revision ?? 0);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<GuardrailWriteError | null>(null);
  const [stashed, setStashed] = useState<string | null>(null);
  const effectiveSlug = mode === "edit" ? detail!.slug : slug;
  const { v, pending, error } = useValidation(effectiveSlug, md);

  // A reload after a 409 brings the saved text; the operator's own edits stay copyable.
  useEffect(() => {
    if (mode === "edit" && detail && detail.revision !== revision && stashed !== null) {
      setMd(detail.md);
      setRevision(detail.revision);
    }
  }, [detail, mode, revision, stashed]);

  const rename = (next: string) => {
    setMd((cur) => cur.replace(new RegExp(`^name: ${(slug || "my-guardrail").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), `name: ${next || "my-guardrail"}`));
    setSlug(next);
  };
  const pickTemplate = (id: string) => {
    const t = templateById(id);
    if (!t) return;
    setTemplateId(id);
    setMd(t.md(slug || "my-guardrail"));
  };

  const save = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      const r =
        mode === "create"
          ? await api.post<GuardrailWriteResponse>("/api/guardrails", { slug, md } satisfies CreateGuardrailRequest)
          : await api.put<GuardrailWriteResponse>(`/api/guardrails/${encodeURIComponent(detail!.slug)}`, { md, revision } satisfies EditGuardrailRequest);
      const what = r.change === "created" ? "Guardrail created" : r.change === "override.set" ? "Override saved" : r.change === "unchanged" ? "Nothing changed" : "Guardrail saved";
      toast({ tone: "success", title: what, description: r.change === "unchanged" ? "The text is the same as the saved one." : "Agents pick it up from their next turn." });
      navigate(guardrailPath(r.slug));
    } catch (e) {
      if (e instanceof ApiError && e.body && typeof e.body === "object") setRefusal(e.body as GuardrailWriteError);
      else setRefusal({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const reloadAfterConflict = () => {
    setStashed(md);
    setRefusal(null);
    reload();
  };

  const slugProblem = mode === "create" && slug && !SLUG_RE.test(slug) ? "Lowercase letters, digits and dashes, starting with a letter or digit." : undefined;
  const isOverride = mode === "edit" && detail!.source !== "console";
  return (
    <div className="sl-memory-page">
      <div className="sl-memory-page__main">
        {!canEdit && <p className="sl-notice is-warning" role="note">Only a superadmin can create or edit guardrails. You can read the text and test it.</p>}
        {isOverride && (
          <p className="sl-notice" role="note">
            {`This guardrail comes from ${detail!.source === "git" ? "the deploy repo" : "host files"}. Saving writes a console override: the source text stays as it is, and a later change to it marks the override behind source until someone updates or clears it.`}
          </p>
        )}
        {refusal && (
          <div className={`sl-notice ${refusal.code === "stale" ? "is-warning" : "is-danger"}`} role="alert">
            <p className="sl-break">{refusal.error}</p>
            {refusal.hint && <p className="sl-break">{refusal.hint}</p>}
            {refusal.blocking && (
              <ul className="sl-gr-errors">
                {refusal.blocking.map((b) => (
                  <li key={b} className="sl-break">
                    {b}
                  </li>
                ))}
              </ul>
            )}
            {refusal.code === "stale" && (
              <Button size="sm" onClick={reloadAfterConflict}>
                Reload the saved version
              </Button>
            )}
          </div>
        )}
        {stashed !== null && (
          <details className="sl-fold" open>
            <summary className="sl-fold__summary">Your edits before the reload</summary>
            <div className="sl-fold__body sl-stack">
              <CopyButton text={stashed} label="Copy your edits" />
              <pre className="sl-gr-posted sl-break">{stashed}</pre>
            </div>
          </details>
        )}
        <Card title="GUARDRAIL.md" description="Frontmatter, Guidance prose, and an optional rules block. Checked as you type.">
          <div className="sl-stack">
            {mode === "create" && (
              <div className="sl-gr-test-grid">
                <Field label="Name" hint="The guardrail's name and folder; it cannot be changed later." error={slugProblem}>
                  {({ id, describedBy, invalid }) => (
                    <Input id={id} aria-describedby={describedBy} invalid={invalid} className="sl-mono" value={slug} placeholder="no-outbound-email" disabled={!canEdit} onChange={(e) => rename(e.target.value.trim())} />
                  )}
                </Field>
                <Field label="Start from">
                  {({ id }) => (
                    <Select id={id} value={templateId} disabled={!canEdit} onChange={(e) => pickTemplate(e.target.value)}>
                      <optgroup label="Enforced rule examples">
                        {GUARDRAIL_TEMPLATES.filter((t) => t.kind === "enforced").map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Guidance">
                        {GUARDRAIL_TEMPLATES.filter((t) => t.kind === "guidance").map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label}
                          </option>
                        ))}
                      </optgroup>
                    </Select>
                  )}
                </Field>
              </div>
            )}
            <Field label="Text" hideLabel>
              {({ id }) => (
                <textarea
                  id={id}
                  aria-label="GUARDRAIL.md text"
                  className="sl-input sl-mono sl-gr-editor"
                  rows={22}
                  spellCheck={false}
                  readOnly={!canEdit}
                  value={md}
                  onChange={(e) => setMd(e.target.value)}
                />
              )}
            </Field>
            <ValidationPanel v={v} pending={pending} error={error} />
            <div className="sl-title-row">
              <Button
                variant="primary"
                loading={busy}
                disabled={!canEdit || pending || !v?.ok || (mode === "create" && (!slug || !!slugProblem))}
                onClick={save}
              >
                {mode === "create" ? "Create guardrail" : isOverride ? "Save override" : "Save"}
              </Button>
              <Link className="sl-link" to={mode === "create" ? "/guardrails" : guardrailPath(detail!.slug)}>
                Cancel
              </Link>
            </div>
          </div>
        </Card>
        <GuardrailTestBox draft={{ slug: effectiveSlug || "untitled", md }} title="Test this draft" description="Runs the draft in place of the saved text (or beside the stored set when it is new), with the runtime's own matcher. Nothing is saved." />
      </div>
    </div>
  );
}

export function GuardrailEditPage({ slug }: { slug?: string }) {
  const editing = slug !== undefined;
  const { data, error, reload } = useApi<OwnerGuardrailDetail>(editing ? `/api/guardrails/${encodeURIComponent(slug)}` : null);
  const back = (
    <Link to={editing ? guardrailPath(slug) : "/guardrails"} className="sl-back">
      <IconArrowLeft size={14} />
      {editing ? slug : "Guardrails"}
    </Link>
  );
  const missing = error instanceof ApiError && error.status === 404;
  return (
    <>
      <PageHeader back={back} title={editing ? <span className="sl-break">{`Edit ${slug}`}</span> : "New guardrail"} />
      {!editing ? (
        <Editor mode="create" detail={null} reload={reload} />
      ) : error && !data ? (
        <Card>
          {missing ? <EmptyState title="No such guardrail" action={<Link className="sl-link" to="/guardrails">Back to guardrails</Link>} /> : <ErrorState what="Guardrail" error={error} onRetry={reload} />}
        </Card>
      ) : !data ? (
        <Skeleton height="24rem" radius="var(--sl-radius-panel)" />
      ) : (
        <Editor key={data.slug} mode="edit" detail={data} reload={reload} />
      )}
    </>
  );
}
