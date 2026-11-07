/**
 * Dev-only component gallery, mounted at <base>/_gallery when the app runs under
 * the Vite dev server. Every component in one page, for visual checks in both
 * themes (switch with the toggle in the header).
 */
import { useState, type ReactNode } from "react";
import "./Gallery.css";
import {
  Badge, Button, Card, CodeBlock, Dialog, EmptyState, Field, FilterChip, IconButton, Input, KeyValue,
  PageHeader, SearchField, Select, Skeleton, Table, Tabs, ThemeToggle, useToast, Avatar, type Column,
} from "./index";
import {
  IconArrowLeft, IconCheck, IconChevronDown, IconChevronRight, IconClose, IconCopy, IconExternal, IconMenu,
  IconMonitor, IconMoon, IconPlus, IconSearch, IconSun, IconTrash, IconUser,
} from "./icons";

interface Row {
  id: string;
  name: string;
  kind: string;
  created: string;
}

const ROWS: Row[] = [
  { id: "mem_01h9x2k7", name: "Support playbook", kind: "shared", created: "Nov 6, 2026" },
  { id: "mem_01h9x2m3", name: "Release notes drafts", kind: "agent", created: "Nov 5, 2026" },
  { id: "mem_01h9x2q8", name: "Onboarding checklist", kind: "personal", created: "Nov 2, 2026" },
  { id: "mem_01h9x2t1", name: "Incident history", kind: "library", created: "Oct 28, 2026" },
];

const COLUMNS: Column<Row>[] = [
  { key: "id", header: "ID", width: "22%", render: (r) => <span className="sl-mono">{r.id}</span>, skeleton: 0.7 },
  { key: "name", header: "Name", render: (r) => r.name, skeleton: 0.75 },
  { key: "kind", header: "Kind", width: "14%", render: (r) => <Badge>{r.kind}</Badge>, skeleton: 0.5 },
  { key: "created", header: "Created", width: "16%", render: (r) => <span className="sl-muted">{r.created}</span>, skeleton: 0.6 },
];

const ICONS = {
  menu: IconMenu, search: IconSearch, "chevron-down": IconChevronDown, "chevron-right": IconChevronRight,
  close: IconClose, check: IconCheck, copy: IconCopy, external: IconExternal, user: IconUser, sun: IconSun,
  moon: IconMoon, monitor: IconMonitor, plus: IconPlus, trash: IconTrash, "arrow-left": IconArrowLeft,
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sl-gallery__section">
      <h2 className="sl-gallery__title">{title}</h2>
      {children}
    </section>
  );
}

export default function Gallery() {
  const toast = useToast();
  const [created, setCreated] = useState<"all" | "7d" | "30d">("all");
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [tab, setTab] = useState<"overview" | "mandates" | "access" | "activity">("overview");
  const [dialog, setDialog] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  return (
    <div className="sl-gallery">
      <PageHeader
        title="Component gallery"
        description="Every building block of the console, for visual checks in light and dark."
        actions={
          <>
            <ThemeToggle />
            <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setDialog(true)}>
              Create memory store
            </Button>
          </>
        }
      />

      <Section title="Table">
        <div className="sl-filter-row">
          <SearchField label="Search by name or exact ID" placeholder="Search by name or exact ID" />
          <FilterChip
            label="Created"
            value={created}
            onChange={setCreated}
            options={[
              { value: "all", label: "All time" },
              { value: "7d", label: "Last 7 days" },
              { value: "30d", label: "Last 30 days" },
            ]}
          />
          <FilterChip
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: "active", label: "Active" },
              { value: "archived", label: "Archived" },
            ]}
          />
          <Button variant="ghost" size="md" onClick={() => setLoading((l) => !l)}>
            {loading ? "Show rows" : "Show loading"}
          </Button>
        </div>
        <Table
          label="Memory stores"
          columns={COLUMNS}
          rows={ROWS}
          rowKey={(r) => r.id}
          loading={loading}
          skeletonRows={4}
          selection={{ selected, onChange: setSelected }}
          onRowClick={(r) => toast({ title: `Opened ${r.name}` })}
        />
        <div className="sl-gallery__gap" />
        <Table
          label="Empty table"
          columns={COLUMNS}
          rows={[]}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No memory stores yet" description="Stores appear here once an agent writes its first page." />}
        />
      </Section>

      <Section title="Buttons">
        <div className="sl-gallery__row">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger" icon={<IconTrash size={16} />}>
            Revoke
          </Button>
          <Button variant="primary" loading>
            Saving
          </Button>
          <Button variant="secondary" disabled>
            Disabled
          </Button>
        </div>
        <div className="sl-gallery__row">
          <Button variant="secondary" size="sm">
            Small
          </Button>
          <Button variant="secondary" size="md">
            Medium
          </Button>
          <Button variant="secondary" size="lg">
            Large
          </Button>
          <IconButton label="Copy">
            <IconCopy size={16} />
          </IconButton>
          <IconButton label="Delete" variant="secondary">
            <IconTrash size={16} />
          </IconButton>
          <IconButton label="More" size="sm">
            <IconChevronDown size={16} />
          </IconButton>
        </div>
      </Section>

      <Section title="Inputs">
        <div className="sl-gallery__grid">
          <Field label="Agent name" hint="Lowercase letters, digits and dashes.">
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} placeholder="support-bot" />}
          </Field>
          <Field label="Role">
            {({ id }) => (
              <Select id={id} defaultValue="member">
                <option value="manager">Manager</option>
                <option value="approver">Approver</option>
                <option value="member">Member</option>
              </Select>
            )}
          </Field>
          <Field label="Slack user ID" error="Enter an ID that starts with U or W.">
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} invalid={invalid} defaultValue="X123" />
            )}
          </Field>
          <Field label="Disabled">
            {({ id }) => <Input id={id} disabled value="read only" readOnly />}
          </Field>
        </div>
      </Section>

      <Section title="Badges and avatars">
        <div className="sl-gallery__row">
          <Badge>neutral</Badge>
          <Badge tone="accent">soul</Badge>
          <Badge tone="success">live</Badge>
          <Badge tone="warning">pending</Badge>
          <Badge tone="danger">denied</Badge>
          <Avatar name="jane.doe@example.com" />
          <Avatar name="Ops Lead" size="sm" />
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs
          label="Agent detail"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "overview", label: "Overview" },
            { value: "mandates", label: "Mandates" },
            { value: "access", label: "Access" },
            { value: "activity", label: "Activity" },
          ]}
        >
          <p className="sl-muted">The {tab} panel.</p>
        </Tabs>
      </Section>

      <Section title="Card, key value and code">
        <div className="sl-gallery__grid">
          <Card title="Identity" description="Where this agent lives and what it runs on.">
            <KeyValue
              items={[
                { key: "name", label: "Name", value: "support-bot" },
                { key: "model", label: "Model", value: <span className="sl-mono">claude-sonnet-4-6</span> },
                { key: "runs", label: "Runs on", value: "gateway" },
                { key: "live", label: "Live sessions", value: "3" },
              ]}
            />
          </Card>
          <CodeBlock language="json" code={JSON.stringify({ action: "grant.create", subject: "user:U0EXAMPLE", role: "member" }, null, 2)} />
        </div>
      </Section>

      <Section title="Empty state and skeleton">
        <div className="sl-gallery__grid">
          <Card>
            <EmptyState
              icon={<IconUser size={20} />}
              title="No grants yet"
              description="Grant a person or a channel access to this agent."
              action={<Button icon={<IconPlus size={16} />}>Add grant</Button>}
            />
          </Card>
          <Card>
            <div className="sl-gallery__stack">
              <Skeleton width="40%" height="1rem" />
              <Skeleton width="90%" />
              <Skeleton width="75%" />
              <Skeleton width="60%" />
            </div>
          </Card>
        </div>
      </Section>

      <Section title="Dialog and toast">
        <div className="sl-gallery__row">
          <Button onClick={() => setDialog(true)}>Open dialog</Button>
          <Button onClick={() => toast({ title: "Grant added", description: "jane.doe is now a member.", tone: "success" })}>
            Success toast
          </Button>
          <Button onClick={() => toast({ title: "Could not revoke", description: "The grant comes from SOUL.md.", tone: "danger" })}>
            Error toast
          </Button>
        </div>
      </Section>

      <Section title="Icons">
        <div className="sl-gallery__row">
          {Object.entries(ICONS).map(([n, Icon]) => (
            <span key={n} className="sl-gallery__icon" title={n}>
              <Icon size={20} />
            </span>
          ))}
        </div>
      </Section>

      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="Create memory store"
        description="A store holds pages an agent can read and write."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!name.trim()}
              onClick={() => {
                setDialog(false);
                toast({ title: `Created ${name.trim()}`, tone: "success" });
                setName("");
              }}
            >
              Create
            </Button>
          </>
        }
      >
        <Field label="Name">
          {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Support playbook" />}
        </Field>
      </Dialog>
    </div>
  );
}
