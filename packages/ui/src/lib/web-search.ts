import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {} from "@tomradex/web-search";
import { invoke, subscribe } from "./api";
import { keys } from "./queries/keys";

/** The registered web search providers, first-asked first; null when web search is not loaded. */
export function useWebSearchProviders() {
  const qc = useQueryClient();
  useEffect(() => subscribe("webSearch.changed", () => void qc.invalidateQueries({ queryKey: keys.webSearch })), [qc]);
  return useQuery({ queryKey: keys.webSearch, queryFn: () => invoke("webSearch.providers").catch(() => null) });
}
