import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../lib/queryClient";
import { App } from "./App";
import "../styles/app.css";
import "./code-sessions.css";

// A file dropped outside a terminal must not open in the window; a terminal cell takes the ones meant for it.
for (const type of ["dragover", "drop"] as const) document.addEventListener(type, (e) => e.preventDefault());

// History's pages, read over the bridge as the panel reads them over IPC; read again each time History opens.
const queryClient = createQueryClient({ queries: { refetchOnWindowFocus: false } });

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
