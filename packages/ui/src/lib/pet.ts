import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { AssistantAccessory } from "@tomradex/contributions";
import type { PetImageUpload, PetMood } from "@tomradex/pet";
import { invoke, invokeDynamic, subscribe, subscribeDynamic } from "./api";

interface AccessoryState {
  mood: string;
}

const stateOf = (value: unknown): AccessoryState =>
  typeof value === "object" && value !== null && typeof (value as { mood?: unknown }).mood === "string" ? { mood: (value as { mood: string }).mood } : { mood: "idle" };

const key = (accessory: AssistantAccessory, threadId: string | null) => ["assistant-accessory", accessory.id, accessory.stateChannel, threadId ?? ""] as const;

export function useAccessoryState(accessory: AssistantAccessory, threadId: string | null) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: key(accessory, threadId),
    queryFn: async () => stateOf(await invokeDynamic(accessory.stateChannel, threadId)),
    staleTime: Infinity,
    retry: false
  });
  useEffect(() => {
    return subscribeDynamic(accessory.changedChannel, (changedThreadId, state) => {
      if (changedThreadId === threadId) qc.setQueryData(key(accessory, threadId), stateOf(state));
    });
  }, [accessory, qc, threadId]);
  return query;
}

export const petKeys = {
  profiles: ["pet", "profiles"] as const,
  preview: (profileId: string) => ["pet", "preview", profileId] as const
};

/** Pets made from the user's own images; the main process says when any of them change. */
export function usePetProfiles() {
  const qc = useQueryClient();
  useEffect(() => subscribe("pet.profilesChanged", () => void qc.invalidateQueries({ queryKey: ["pet"] })), [qc]);
  return useQuery({ queryKey: petKeys.profiles, queryFn: () => invoke("pet.profiles") });
}

export const usePetPreview = (profileId: string) =>
  useQuery({ queryKey: petKeys.preview(profileId), queryFn: () => invoke("pet.profilePreview", profileId), staleTime: Infinity });

/** Every edit is answered by `pet.profilesChanged`, which refreshes the lists; these only report failure. */
export const useCreatePetProfile = () => useMutation({ mutationFn: (name: string) => invoke("pet.createProfile", name) });
export const useUpdatePetProfile = () =>
  useMutation({ mutationFn: (args: { id: string; patch: { name?: string; pixelated?: boolean } }) => invoke("pet.updateProfile", args.id, args.patch) });
export const useDeletePetProfile = () => useMutation({ mutationFn: (id: string) => invoke("pet.deleteProfile", id) });
export const useActivatePetProfile = () => useMutation({ mutationFn: (id: string) => invoke("pet.activateProfile", id) });
export const useSetPetImage = () =>
  useMutation({ mutationFn: (args: { id: string; mood: PetMood; upload: PetImageUpload }) => invoke("pet.setImage", args.id, args.mood, args.upload) });
export const useClearPetImage = () => useMutation({ mutationFn: (args: { id: string; mood: PetMood }) => invoke("pet.clearImage", args.id, args.mood) });
