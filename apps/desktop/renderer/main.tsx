import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initializeAppearance } from "./appearance";
import "./theme.css";
import "./styles.css";
import "./workspaces.css";
import "./agent-planner.css";
import "./provider.css";
import "./chat.css";
import "./workspace-layout.css";
import "./timeline.css";

initializeAppearance();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
