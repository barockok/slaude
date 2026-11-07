import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../ui/tokens.css";
import "../ui/base.css";
import "../ui/components.css";
import "../shared/shared.css";
import "./portal.css";
import { setBase } from "../lib/router";
import { App } from "./App";

setBase("/portal");

function mount() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// A fixture API for working on the portal without a gateway (dev server only).
if (import.meta.env.DEV && import.meta.env.VITE_STUB === "1") {
  void import("./dev/stub").then((m) => {
    m.installStub();
    mount();
  });
} else {
  mount();
}
