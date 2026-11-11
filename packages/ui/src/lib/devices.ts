import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeviceSession, DeviceView, DevicesInfo } from "@tomradex/hub-cloud";
import { invoke } from "./api";
import { keys, useHubInfo } from "./queries";

/** The account's machines. Asked only where the account service runs; a change anywhere arrives as `devices.changed`. */
export function useDevices() {
  const hub = useHubInfo();
  return useQuery({ queryKey: keys.devices, queryFn: () => invoke("devices.info"), enabled: hub.data?.cloudEnabled === true, retry: false });
}

/** Rename, remove and check again each answer with the list as it is afterwards. */
export function useDeviceActions() {
  const qc = useQueryClient();
  const took = (info: DevicesInfo) => qc.setQueryData(keys.devices, info);
  return {
    rename: useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => invoke("devices.rename", id, name), onSuccess: took }),
    remove: useMutation({ mutationFn: (id: string) => invoke("devices.remove", id), onSuccess: took }),
    recheck: useMutation({ mutationFn: () => invoke("devices.recheck"), onSuccess: took })
  };
}

/** Another machine's session on this ticket: the one that is on, else the one seen last. */
export function elsewhereOn(devices: DeviceView[] | undefined, projectId: string, key: string): { device: DeviceView; session: DeviceSession } | null {
  const found = (devices ?? []).flatMap((device) => (device.self ? [] : device.sessions.filter((s) => s.projectId === projectId && s.key === key).map((session) => ({ device, session }))));
  found.sort((a, b) => Number(b.device.online) - Number(a.device.online) || (b.device.activityAt ?? 0) - (a.device.activityAt ?? 0));
  return found[0] ?? null;
}
