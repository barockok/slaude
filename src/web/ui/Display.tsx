/**
 * Small presentational pieces: Badge, Card, EmptyState, KeyValue, Skeleton,
 * Avatar, PageHeader.
 */
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

export function Badge({ tone = "neutral", children, className, title }: { tone?: BadgeTone; children: ReactNode; className?: string; title?: string }) {
  return <span className={cx("sl-badge", `sl-badge--${tone}`, className)} title={title}>{children}</span>;
}

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Remove the body padding, e.g. for a table inside. */
  flush?: boolean;
}

export function Card({ title, description, actions, flush, className, children, ...rest }: CardProps) {
  return (
    <section className={cx("sl-card", className)} {...rest}>
      {(title || actions) && (
        <header className="sl-card__head">
          <div className="sl-card__titles">
            {title && <h2 className="sl-card__title">{title}</h2>}
            {description && <p className="sl-card__desc">{description}</p>}
          </div>
          {actions && <div className="sl-card__actions">{actions}</div>}
        </header>
      )}
      <div className={cx("sl-card__body", flush && "is-flush")}>{children}</div>
    </section>
  );
}

export function EmptyState({
  title, description, action, icon,
}: { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="sl-empty">
      {icon && <div className="sl-empty__icon">{icon}</div>}
      <p className="sl-empty__title">{title}</p>
      {description && <p className="sl-empty__desc">{description}</p>}
      {action && <div className="sl-empty__action">{action}</div>}
    </div>
  );
}

export function KeyValue({ items, className }: { items: Array<{ key: string; label: ReactNode; value: ReactNode }>; className?: string }) {
  return (
    <dl className={cx("sl-kv", className)}>
      {items.map((it) => (
        <div className="sl-kv__row" key={it.key}>
          <dt>{it.label}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Skeleton({ width = "100%", height, radius, className }: { width?: string; height?: string; radius?: string; className?: string }) {
  const style: CSSProperties = { width, height, borderRadius: radius };
  return <span className={cx("sl-skeleton", className)} style={style} aria-hidden="true" />;
}

/** Up to two initials from a name or an email address. */
export function initials(name: string): string {
  const base = name.includes("@") ? name.split("@")[0]! : name;
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  return (
    <span className={cx("sl-avatar", `sl-avatar--${size}`)} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Optional back link or breadcrumb above the title. */
  back?: ReactNode;
}

export function PageHeader({ title, description, actions, back }: PageHeaderProps) {
  return (
    <header className="sl-page-header">
      <div className="sl-page-header__text">
        {back && <div className="sl-page-header__back">{back}</div>}
        <h1 className="sl-page-header__title">{title}</h1>
        {description && <p className="sl-page-header__desc">{description}</p>}
      </div>
      {actions && <div className="sl-page-header__actions">{actions}</div>}
    </header>
  );
}
