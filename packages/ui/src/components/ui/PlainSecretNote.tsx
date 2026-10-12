import { useQuery } from "@tanstack/react-query";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";

/** Says so beside a key or token field when this system has no keychain to seal it with; says nothing otherwise. */
export function PlainSecretNote() {
  const { t } = useI18n();
  const storage = useQuery({ queryKey: ["settings", "secretStorage"], queryFn: () => invoke("settings.secretStorage"), staleTime: Infinity, retry: false });
  if (storage.data !== "plaintext") return null;
  return (
    <span className="meta-txt" data-testid="plain-secret-note">
      {t("common.plainSecret")}
    </span>
  );
}
