import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "../styles/app.css";
import "./code-sessions.css";

// A file dropped outside a terminal must not open in the window; a terminal cell takes the ones meant for it.
for (const type of ["dragover", "drop"] as const) document.addEventListener(type, (e) => e.preventDefault());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
