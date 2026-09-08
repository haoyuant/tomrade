import { useEffect, useState } from "react";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Eyebrow } from "~/components/ui/atoms";
import { SchemaField, defaultsOf, fieldsOf, type JsonSchema } from "~/components/ui/schema-form";
import { useI18n } from "~/lib/i18n";
import { useAttachProject, useStorageConnection, useStorageProviders } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { ConnectionPanel, DestinationPicker, message } from "./destination";

/**
 * Joining a project someone else published. `attach` was always provider-agnostic;
 * this is the way in for every destination rather than only for a folder somebody
 * had already cloned by hand.
 *
 * Nothing is created here: the project already exists, and its own file names it.
 * That is why the id, the name and the key prefix are never asked for.
 */
export function OpenProjectDialog({
  open,
  onOpenChange,
  onOpened
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpened: (projectId: string) => void;
}) {
  const { t } = useI18n();
  const providers = useStorageProviders();
  const attach = useAttachProject();
  const toast = useToast();
  const [providerId, setProviderId] = useState("folder");
  const [config, setConfig] = useState<Record<string, unknown>>({});

  const provider = providers.data?.find((p) => p.id === providerId);
  const connection = useStorageConnection(provider?.connection ? providerId : undefined);
  const ready = !provider?.connection || connection.data?.connected === true;

  // Opening starts clean: a half-typed repository from last time is not an answer.
  useEffect(() => {
    if (!open) return;
    const first = providers.data?.find((p) => p.id === "folder") ?? providers.data?.[0];
    setProviderId(first?.id ?? "folder");
    setConfig(first ? defaultsOf(first.schema as JsonSchema) : {});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (id: string) => {
    setProviderId(id);
    const next = providers.data?.find((p) => p.id === id);
    setConfig(next ? defaultsOf(next.schema as JsonSchema) : {});
  };

  const submit = () => {
    if (!provider || !ready || attach.isPending) return;
    attach.mutate(
      { providerId, config },
      {
        onSuccess: (projectId) => {
          onOpenChange(false);
          onOpened(projectId);
        },
        onError: (error) => toast({ body: message(error) })
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("openProjectDialog.dialogLabel")}>
      <DialogHead title={t("openProjectDialog.dialogLabel")} />
      <DialogBody className="stack-4">
        <p className="dlg-sub">{t("openProjectDialog.intro")}</p>

        <div className="field">
          <label htmlFor="opProvider">{t("openProjectDialog.whereItIsLabel")}</label>
          <select id="opProvider" className="input" disabled={attach.isPending} value={providerId} onChange={(e) => choose(e.target.value)}>
            {(providers.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          {provider?.description && <span className="meta-txt">{provider.description}</span>}
        </div>

        {provider?.connection && <ConnectionPanel provider={provider} />}

        {provider && ready && (
          <>
            {provider.browsable && <DestinationPicker provider={provider} onPick={setConfig} />}
            <div className="panel stack-3">
              {(fieldsOf(provider.schema as JsonSchema) ?? []).map(([name, field]) => (
                <SchemaField
                  key={name}
                  id="op"
                  name={name}
                  schema={field}
                  disabled={attach.isPending}
                  value={config[name]}
                  onChange={(value) => setConfig({ ...config, [name]: value })}
                />
              ))}
            </div>
          </>
        )}

        <div>
          <Eyebrow>{t("openProjectDialog.whatHappens")}</Eyebrow>
          <ul className="dash" style={{ marginTop: "var(--space-2)" }}>
            <li>{t("openProjectDialog.bullet1")}</li>
            <li>{t("openProjectDialog.bullet2")}</li>
            <li>{t("openProjectDialog.bullet3")}</li>
          </ul>
        </div>
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
          {t("openProjectDialog.cancel")}
        </button>
        <button type="button" className="btn btn-primary" disabled={!provider || !ready || attach.isPending} onClick={submit}>
          {attach.isPending ? t("openProjectDialog.opening") : t("openProjectDialog.openProject")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}
