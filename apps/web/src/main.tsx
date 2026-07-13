import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installShellGlobals } from "./shell";
import "./styles.css";

// Must run before any generated module is dynamically imported: the import-map
// shims (react, @shell/hooks) read these globals.
installShellGlobals();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
