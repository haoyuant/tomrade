import { useI18n } from "~/lib/i18n";
import { useSecretStorage } from "~/lib/queries";

/** Says so beside a key or token field when this system has no keychain to seal it with; says nothing otherwise. */
export function PlainSecretNote() {
  const { t } = useI18n();
  const storage = useSecretStorage();
  if (storage.data !== "plaintext") return null;
  return (
    <span className="meta-txt" data-testid="plain-secret-note">
      {t("common.plainSecret")}
    </span>
  );
}
