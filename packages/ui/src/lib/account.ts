import { useQuery } from "@tanstack/react-query";
import type {} from "@tomradex/hub-cloud";
import { invoke } from "./api";
import { useHubInfo } from "./queries";

export function useAccount() {
  const hub = useHubInfo();
  return useQuery({ queryKey: ["account"], queryFn: () => invoke("account.info"), enabled: hub.data?.cloudEnabled === true, refetchInterval: 3000, retry: false });
}
