import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../ui/tokens.css";
import "../ui/base.css";
import "../ui/components.css";
import { setBase } from "../lib/router";
import { App } from "./App";

setBase("/panel");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
