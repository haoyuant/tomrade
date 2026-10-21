import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {} from "@tomradex/mcp-client";
import type { McpServerView } from "@tomradex/mcp-client";
import { invoke, subscribe } from "./api";

const mcpClientKeys = { servers: ["mcpClient", "servers"] as const };

/** Live: the main process broadcasts every connection change, so nothing polls. */
export function useMcpServers() {
  const qc = useQueryClient();
  useEffect(() => subscribe("mcpClient.changed", (servers) => qc.setQueryData(mcpClientKeys.servers, servers)), [qc]);
  return useQuery({ queryKey: mcpClientKeys.servers, queryFn: (): Promise<McpServerView[]> => invoke("mcpClient.servers") });
}

export function useReconnectMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke("mcpClient.reconnect", id),
    onSuccess: (servers) => qc.setQueryData(mcpClientKeys.servers, servers)
  });
}

export const useTestMcpServer = () => useMutation({ mutationFn: (server: unknown) => invoke("mcpClient.test", server) });

export const useParseMcpConfig = () => useMutation({ mutationFn: (text: string) => invoke("mcpClient.parseConfig", text) });
