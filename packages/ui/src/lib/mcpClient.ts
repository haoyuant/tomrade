import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {} from "@tomradex/mcp-client";
import type { McpServerView } from "@tomradex/mcp-client";
import { invoke, subscribe } from "./api";
import { keys } from "./queries/keys";

/** Live: the main process broadcasts every connection change, so nothing polls. */
export function useMcpServers() {
  const qc = useQueryClient();
  useEffect(() => subscribe("mcpClient.changed", (servers) => qc.setQueryData(keys.mcpClient.servers, servers)), [qc]);
  return useQuery({ queryKey: keys.mcpClient.servers, queryFn: (): Promise<McpServerView[]> => invoke("mcpClient.servers") });
}

export function useReconnectMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke("mcpClient.reconnect", id),
    onSuccess: (servers) => qc.setQueryData(keys.mcpClient.servers, servers)
  });
}

export const useTestMcpServer = () => useMutation({ mutationFn: (server: unknown) => invoke("mcpClient.test", server) });

export const useParseMcpConfig = () => useMutation({ mutationFn: (text: string) => invoke("mcpClient.parseConfig", text) });
