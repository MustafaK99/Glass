import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Fonts are bundled, never fetched. See docs/design.md.
import "@fontsource-variable/hanken-grotesk";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
