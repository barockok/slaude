import { useEffect, useState } from "react";
import type { PersonaSummary } from "./types";
import { api } from "./api";
import { PersonaLoadError, PersonaTable } from "./PersonaViews";

/** Read-only persona list (WS-C §4.4.3), route `#/p`. Opens a persona's definition. */
export function PersonaList({ onOpen }: { onOpen: (name: string) => void }) {
  const [personas, setPersonas] = useState<PersonaSummary[] | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [err, setErr] = useState<Error | null>(null);

  useEffect(() => {
    let alive = true;
    api().listPersonas()
      .then((b) => { if (alive) { setPersonas(b.personas); setRevision(b.revision); } })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, []);

  return (
    <div className="wrap" data-view="personas">
      <div className="page-head">
        <div>
          <h1 className="page-title">Personas</h1>
          <div className="page-sub">What each agent is and where it runs. Read only: definitions change through git.</div>
        </div>
        {revision && <span className="live mono" data-testid="persona-revision">revision {revision}</span>}
      </div>
      {err ? <PersonaLoadError error={err} /> : <PersonaTable personas={personas} onOpen={onOpen} />}
    </div>
  );
}
