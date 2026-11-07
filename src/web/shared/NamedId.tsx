/** A resolved name with its id as secondary text; the id alone when no name resolved. */
export function NamedId({ name, id }: { name?: string | null; id: string }) {
  if (!name) return <span className="sl-mono">{id}</span>;
  return (
    <span className="sl-stack sl-named-id">
      <span className="sl-truncate" title={name}>
        {name}
      </span>
      <span className="sl-caption sl-mono">{id}</span>
    </span>
  );
}
