import { useEffect, useState } from "react";
import type { PersonaDetail } from "./types";
import { api } from "./api";
import { PersonaLoadError, PersonaView } from "./PersonaViews";

/** One persona's definition (WS-C §4.4.3), route `#/p/<name>`, read only. */
export function PersonaPage({ name, onBack }: { name: string; onBack: () => void }) {
  const [persona, setPersona] = useState<PersonaDetail | null>(null);
  const [err, setErr] = useState<Error | null>(null);

  useEffect(() => {
    let alive = true;
    setPersona(null);
    setErr(null);
    api().getPersona(name)
      .then((p) => { if (alive) setPersona(p); })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [name]);

  return (
    <div className="wrap" data-view="persona" data-persona={name}>
      <div className="crumb"><a onClick={onBack}>Personas</a><span>/</span><span className="mono">{name}</span></div>
      {err ? <PersonaLoadError error={err} name={name} />
        : persona ? <PersonaView persona={persona} />
        : <div className="ident" data-testid="persona-loading"><div className="sk" style={{ height: 22, width: 220, marginBottom: 12 }} /><div className="sk" style={{ height: 12, width: 320 }} /></div>}
    </div>
  );
}
