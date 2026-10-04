import { useEffect, useState } from "react";
import type { PersonaDetail } from "./types";
import { api, ApiError } from "./api";
import { PersonaLoadError, PersonaView, isPersonaDetail, isPersonaName } from "./PersonaViews";

/** One persona's definition (WS-C §4.4.3), route `#/p/<name>`, read only. */
export function PersonaPage({ name, onBack }: { name: string; onBack: () => void }) {
  const [persona, setPersona] = useState<PersonaDetail | null>(null);
  const [err, setErr] = useState<Error | null>(null);

  useEffect(() => {
    let alive = true;
    setPersona(null);
    setErr(null);
    // Checked before the name reaches a URL: `.` or `%2e` would be normalised
    // to the list route and come back as a list body.
    if (!isPersonaName(name)) {
      setErr(new ApiError(422, { error: "invalid persona name" }));
      return;
    }
    api().getPersona(name)
      .then((p) => {
        if (!alive) return;
        if (isPersonaDetail(p, name)) setPersona(p);
        else setErr(new Error("unexpected response from the panel API"));
      })
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
