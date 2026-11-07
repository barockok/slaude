import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { cx } from "./cx";
import { Skeleton } from "./Display";

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** CSS width, e.g. "30%" or "120px". */
  width?: string;
  align?: "start" | "end";
  /** Width of the skeleton bar while loading, as a fraction of the cell. */
  skeleton?: number;
}

export interface TableSelection {
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}

export interface TableProps<T> {
  /** Accessible name of the table. */
  label: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  skeletonRows?: number;
  /** Rendered in place of rows when there are none. */
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  /** Adds a checkbox column. */
  selection?: TableSelection;
  className?: string;
}

/**
 * A data table: header row in secondary text, 45 px rows on hairlines, skeleton
 * rows while loading. On narrow screens it scrolls sideways inside its own box
 * so the page never does.
 */
export function Table<T>({
  label, columns, rows, rowKey, loading, skeletonRows = 8, empty, onRowClick, selection, className,
}: TableProps<T>) {
  const keys = rows.map(rowKey);
  const allSelected = !!selection && keys.length > 0 && keys.every((k) => selection.selected.has(k));
  const someSelected = !!selection && keys.some((k) => selection.selected.has(k));
  const colCount = columns.length + (selection ? 1 : 0);

  const toggleAll = () => {
    if (!selection) return;
    selection.onChange(allSelected ? new Set() : new Set(keys));
  };
  const toggle = (k: string) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    selection.onChange(next);
  };
  const onRowKey = (e: KeyboardEvent, row: T) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRowClick?.(row);
    }
  };
  const cellStyle = (c: Column<T>): CSSProperties | undefined => (c.width ? { width: c.width } : undefined);

  return (
    <div className={cx("sl-table-wrap", className)}>
      <table className={cx("sl-table", !loading && rows.length === 0 && "is-empty-table")} aria-label={label} aria-busy={loading || undefined}>
        <thead>
          <tr>
            {selection && (
              <th className="sl-table__check" scope="col">
                <input
                  type="checkbox"
                  className="sl-checkbox"
                  aria-label="Select all rows"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={toggleAll}
                  disabled={loading || rows.length === 0}
                />
              </th>
            )}
            {columns.map((c) => (
              <th key={c.key} scope="col" style={cellStyle(c)} className={cx(c.align === "end" && "is-end")}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: skeletonRows }, (_, i) => (
              <tr key={`sk-${i}`} className="is-skeleton">
                {selection && (
                  <td className="sl-table__check">
                    <Skeleton width="1rem" height="1rem" />
                  </td>
                )}
                {columns.map((c) => (
                  <td key={c.key} className={cx(c.align === "end" && "is-end")}>
                    <Skeleton width={`${Math.round((c.skeleton ?? 0.7) * 100)}%`} />
                  </td>
                ))}
              </tr>
            ))}
          {!loading && rows.length === 0 && (
            <tr className="is-empty">
              <td colSpan={colCount}>{empty ?? <p className="sl-table__empty">Nothing to show.</p>}</td>
            </tr>
          )}
          {!loading &&
            rows.map((row) => {
              const k = rowKey(row);
              const isSel = selection?.selected.has(k) ?? false;
              return (
                <tr
                  key={k}
                  className={cx(onRowClick && "is-clickable", isSel && "is-selected")}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (e) => onRowKey(e, row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                >
                  {selection && (
                    <td className="sl-table__check" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="sl-checkbox"
                        aria-label="Select row"
                        checked={isSel}
                        onChange={() => toggle(k)}
                      />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td key={c.key} className={cx(c.align === "end" && "is-end")}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
