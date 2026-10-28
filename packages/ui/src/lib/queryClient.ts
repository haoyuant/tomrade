import { MutationCache, QueryClient, type DefaultOptions } from "@tanstack/react-query";
import { reportError } from "./toast";

declare module "@tanstack/react-query" {
  interface Register {
    /** `reportErrors`: a failure reaches the person as a toast, for hooks whose callers report nothing. */
    mutationMeta: { reportErrors?: boolean };
  }
}

/** A window's query client. A mutation marked `reportErrors` says so when it fails, wherever it was called from. */
export const createQueryClient = (defaultOptions: DefaultOptions): QueryClient =>
  new QueryClient({
    defaultOptions,
    mutationCache: new MutationCache({ onError: (error, _variables, _context, mutation) => { if (mutation.meta?.reportErrors) reportError(error); } })
  });
