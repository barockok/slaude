import { Link } from "../../../lib/router";
import { IconArrowLeft, PageHeader } from "../../../ui";
import { GuardrailTestBox } from "./GuardrailTestBox";

/** The standalone Test box: any agent, any channel, optionally an unsaved draft. */
export function GuardrailTestPage() {
  const back = (
    <Link to="/guardrails" className="sl-back">
      <IconArrowLeft size={14} />
      Guardrails
    </Link>
  );
  return (
    <>
      <PageHeader
        back={back}
        title="Test a guardrail"
        description="See which owner rules match a tool call, a reply or an incoming message, the action that decides (the strictest wins), and which Guidance loads. Evaluated with the runtime's own matcher; nothing is posted, held or run."
      />
      <GuardrailTestBox draftInput title="Event" description="Pick the agent and channel the event happens in. A draft replaces the stored guardrail of the same name, or is added when it is new." />
    </>
  );
}
