import { useState } from "react";
import type { Workspace } from "@tomradex/plugin-studio";
import { useOptionalAgentDock } from "~/components/chrome/ProjectShell";
import { Icon } from "~/components/icons";
import { Eyebrow, SectionHead, Tag } from "~/components/ui/atoms";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Menu, MenuActionItem } from "~/components/ui/menu";
import { useEngines } from "~/lib/agent";
import { useI18n, type MessageKey } from "~/lib/i18n";
import {
  useBecomePublisher,
  useCommunityAccount,
  useLinkGitHub,
  usePublish,
  usePublished,
  useSnapshots,
  useStudioContinue,
  useStudioCreate,
  useStudioPack,
  useStudioRemove,
  useStudioRestore,
  useWorkspaces
} from "~/lib/plugins";
import { openExternal, reveal } from "~/lib/shell";
import { useToast } from "~/lib/toast";
import { ConfirmBuildDialog } from "./ConfirmBuildDialog";
import { Field, TrustTags, messageOf, useCurrentProject } from "./parts";

const STATE: Record<string, MessageKey> = {
  active: "pluginsPanel.stateRunning",
  pending: "pluginsPanel.stateWaiting",
  failed: "pluginsPanel.stateFailed",
  disabled: "pluginsPanel.stateOff"
};

export function MineTab({ onLeave }: { onLeave?: () => void }) {
  const { t } = useI18n();
  const projectId = useCurrentProject();
  const workspaces = useWorkspaces();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <SectionHead
        title={t("plugins.tabMine")}
        aside={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)} disabled={!projectId} title={projectId ? undefined : t("plugins.needsProject")} data-testid="new-plugin">
            <Icon name="i-plus" size={13} /> {t("plugins.newPlugin")}
          </button>
        }
      >
        {t("plugins.mineLede")}
      </SectionHead>
      {!projectId && <p className="meta-txt">{t("plugins.needsProject")}</p>}
      {workspaces.data && !workspaces.data.length && <p className="meta-txt">{t("plugins.noWorkspaces")}</p>}
      <div className="stack-2" data-testid="workspaces">
        {workspaces.data?.map((w) => <WorkspaceRow key={w.name} workspace={w} onLeave={onLeave} />)}
      </div>
      <PublishedVersions />
      {creating && projectId && <NewPluginDialog projectId={projectId} onClose={() => setCreating(false)} onLeave={onLeave} />}
    </>
  );
}

function WorkspaceRow({ workspace: w, onLeave }: { workspace: Workspace; onLeave?: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const projectId = useCurrentProject();
  const dock = useOptionalAgentDock();
  const cont = useStudioContinue();
  const pack = useStudioPack();
  const [dialog, setDialog] = useState<"confirm" | "publish" | "restore" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = w.view;
  const pending = !!view?.extension?.pending;
  const fail = (e: unknown) => setError(messageOf(e));
  return (
    <div className="plug-ext" data-id={w.id}>
      <div className="cfg-row">
        <Icon name="i-pen" size={15} style={{ color: "var(--accent)" }} />
        <div className="cfg-name">
          {w.title} <span className="meta-txt mono">{w.id}</span> <span className="meta-txt">{t("plugins.version", { version: w.version })}</span>
          <div className="meta-txt dense">{w.description}</div>
          <div className="row plug-tags" style={{ gap: 6, marginTop: 3 }}>
            <TrustTags tier="dev" risk={view?.extension?.risk.level} />
            {pending && (
              <button type="button" className="btn btn-primary btn-xs" onClick={() => setDialog("confirm")}>
                {t("plugins.reviewBuild")}
              </button>
            )}
          </div>
          {view?.state === "failed" && !pending && view.error && <div className="meta-txt dense" style={{ color: "var(--danger)" }}>{view.error}</div>}
          {error && <div className="meta-txt dense" style={{ color: "var(--danger)" }}>{error}</div>}
        </div>
        <Tag tone={pending || view?.state === "active" ? "strong" : "neutral"}>{pending ? t("plugins.pending") : view ? t(STATE[view.state]!) : t("plugins.notLoaded")}</Tag>
        {projectId && dock && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={cont.isPending}
            onClick={() =>
              cont.mutate(
                { projectId, name: w.name },
                {
                  onSuccess: ({ threadId }) => {
                    dock.showThread(threadId);
                    onLeave?.();
                  },
                  onError: fail
                }
              )
            }
          >
            {t("plugins.continue")}
          </button>
        )}
        <Menu
          label={w.title}
          align="end"
          modal
          trigger={
            <button type="button" className="btn btn-icon" aria-label={t("plugins.details")}>
              <Icon name="i-sliders" size={13} />
            </button>
          }
        >
          <MenuActionItem
            icon={<Icon name="i-archive" size={13} />}
            name={t("plugins.pack")}
            onSelect={() =>
              pack.mutate(w.name, {
                onSuccess: ({ file, report }) => {
                  if (file) {
                    toast({ body: t("plugins.packed", { file: file.split(/[\\/]/).at(-1) ?? file }), actions: [{ label: t("plugins.reveal"), run: () => reveal(file) }] });
                  } else setError(t("plugins.packBlocked", { problems: report.problems.join("; ") }));
                },
                onError: fail
              })
            }
          />
          <MenuActionItem icon={<Icon name="i-upload" size={13} />} name={t("plugins.publish")} onSelect={() => setDialog("publish")} />
          <MenuActionItem icon={<Icon name="i-undo" size={13} />} name={t("plugins.restore")} onSelect={() => setDialog("restore")} />
          <MenuActionItem icon={<Icon name="i-folder" size={13} />} name={t("plugins.reveal")} onSelect={() => reveal(w.dir)} />
          <MenuActionItem icon={<Icon name="i-trash" size={13} />} name={t("plugins.deleteWorkspace")} onSelect={() => setDialog("delete")} />
        </Menu>
      </div>
      {dialog === "confirm" && <ConfirmBuildDialog name={w.name} title={w.title} onClose={() => setDialog(null)} />}
      {dialog === "publish" && <PublishDialog workspace={w} onClose={() => setDialog(null)} />}
      {dialog === "restore" && <RestoreDialog workspace={w} onClose={() => setDialog(null)} />}
      {dialog === "delete" && <DeleteDialog workspace={w} onClose={() => setDialog(null)} />}
    </div>
  );
}

const NAME = /^[a-z][a-z0-9-]{1,40}$/;

function NewPluginDialog({ projectId, onClose, onLeave }: { projectId: string; onClose: () => void; onLeave?: () => void }) {
  const { t } = useI18n();
  const dock = useOptionalAgentDock();
  const engines = useEngines();
  const create = useStudioCreate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const usable = (engines.data ?? []).filter((e) => e.ok);
  const [engine, setEngine] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const valid = NAME.test(name) && description.trim().length > 3;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} label={t("plugins.newTitle")} className="sheet-md">
      <DialogHead title={t("plugins.newTitle")} />
      <DialogBody>
        <div className="stack-3" data-testid="new-plugin-dialog">
          <Field label={t("plugins.nameLabel")} htmlFor="npName">
            <input id="npName" className="input mono" value={name} placeholder="stale-in-doing" onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} />
            <span className="meta-txt">{t("plugins.nameHint")}</span>
          </Field>
          <Field label={t("plugins.describeLabel")} htmlFor="npDesc">
            <textarea id="npDesc" className="input" rows={4} value={description} placeholder={t("plugins.describePlaceholder")} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label={t("plugins.engineLabel")} htmlFor="npEngine">
            <select id="npEngine" className="select" value={engine} onChange={(e) => setEngine(e.target.value)}>
              <option value="">{t("plugins.engineDefault")}</option>
              {usable.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </select>
          </Field>
          {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        </div>
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("plugins.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!valid || create.isPending}
          onClick={() =>
            create.mutate(
              { projectId, name, description: description.trim(), engine: engine || undefined },
              {
                onSuccess: ({ threadId }) => {
                  onClose();
                  dock?.showThread(threadId);
                  onLeave?.();
                },
                onError: (e) => setError(messageOf(e))
              }
            )
          }
        >
          {t("plugins.startBuilding")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}

function PublishDialog({ workspace: w, onClose }: { workspace: Workspace; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const account = useCommunityAccount();
  const link = useLinkGitHub();
  const become = useBecomePublisher();
  const publish = usePublish();
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = account.data;
  const login = a?.publisher ?? a?.github ?? null;
  const ready = !!a?.signedIn && !!a.publisher && a.githubToken;
  const name = w.id.split("/")[1] ?? w.name;
  const step = (done: boolean, label: string, hint?: string, action?: React.ReactNode) => (
    <li className="row" style={{ gap: 8, alignItems: "flex-start" }}>
      <Icon name={done ? "i-check" : "i-clock"} size={13} style={{ color: done ? "var(--accent)" : "var(--meta)", marginTop: 3 }} />
      <div style={{ flex: 1 }}>
        {label}
        {hint && <div className="meta-txt dense">{hint}</div>}
      </div>
      {!done && action}
    </li>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} label={t("plugins.publishTitle", { title: w.title })} className="sheet-md">
      <DialogHead title={t("plugins.publishTitle", { title: w.title })} />
      <DialogBody>
        <div className="stack-3" data-testid="publish-dialog">
          <p>{t("plugins.publishLede")}</p>
          {account.error && <p style={{ color: "var(--danger)" }}>{messageOf(account.error)}</p>}
          <ul className="dash stack-2">
            {step(!!a?.signedIn, t("plugins.stepAccount"), t("plugins.stepAccountHint"))}
            {step(
              !!a?.github,
              t("plugins.stepGitHub"),
              linking ? t("plugins.linking") : undefined,
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!a?.signedIn || link.isPending}
                onClick={() =>
                  link.mutate(undefined, {
                    onSuccess: ({ url }) => {
                      setLinking(true);
                      openExternal(url);
                    },
                    onError: (e) => setError(messageOf(e))
                  })
                }
              >
                {t("plugins.linkGitHub")}
              </button>
            )}
            {step(
              !!a?.publisher,
              t("plugins.stepPublisher", { login: a?.github ?? "…" }),
              undefined,
              <button type="button" className="btn btn-secondary" disabled={!a?.github || become.isPending} onClick={() => become.mutate(undefined, { onError: (e) => setError(messageOf(e)) })}>
                {t("plugins.becomePublisher")}
              </button>
            )}
            {step(!!a?.githubToken, t("plugins.stepToken"), t("plugins.stepTokenHint"))}
          </ul>
          {login && <p className="meta-txt">{t("plugins.publishAs", { id: `${login}/${name}`, login })}</p>}
          {publish.isPending && <p className="meta-txt">{t("plugins.publishing")}</p>}
          {error && <p style={{ color: "var(--danger)", whiteSpace: "pre-wrap" }}>{error}</p>}
        </div>
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("plugins.close")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready || publish.isPending}
          onClick={() =>
            publish.mutate(w.dir, {
              onSuccess: (r) => {
                toast({ body: t("plugins.published", { id: r.id, version: r.version }) });
                onClose();
              },
              onError: (e) => setError(messageOf(e))
            })
          }
        >
          {t("plugins.publishNow", { version: w.version })}
        </button>
      </DialogFoot>
    </Dialog>
  );
}

function PublishedVersions() {
  const { t } = useI18n();
  const account = useCommunityAccount();
  const published = usePublished(!!account.data?.publisher);
  if (!published.data?.length) return null;
  return (
    <>
      <hr className="rule" />
      <SectionHead title={t("plugins.publishedVersions")} />
      <div className="stack-2" data-testid="published">
        {published.data.map((v) => (
          <div key={`${v.pluginId}@${v.version}`} className="cfg-row">
            <div className="cfg-name">
              <span className="mono">{`${v.pluginId}@${v.version}`}</span>
              <div className="row plug-tags" style={{ gap: 6, marginTop: 3 }}>
                <Tag tone="neutral">{t(v.status === "revoked" ? "plugins.ver_revoked" : "plugins.ver_listed")}</Tag>
                <TrustTags tier={v.tier} risk={v.risk} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function RestoreDialog({ workspace: w, onClose }: { workspace: Workspace; onClose: () => void }) {
  const { t, locale } = useI18n() as ReturnType<typeof useI18n> & { locale?: string };
  const toast = useToast();
  const snapshots = useSnapshots(w.name);
  const restore = useStudioRestore();
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} label={t("plugins.restoreTitle", { title: w.title })} className="sheet-md">
      <DialogHead title={t("plugins.restoreTitle", { title: w.title })} />
      <DialogBody>
        <div className="stack-3">
          <p>{t("plugins.restoreLede")}</p>
          {snapshots.data && !snapshots.data.length && <p className="meta-txt">{t("plugins.noSnapshots")}</p>}
          <ul className="dash stack-2">
            {snapshots.data?.map((s) => (
              <li key={s.file} className="row" style={{ gap: 8 }}>
                <span style={{ flex: 1 }}>{t("plugins.restoreFrom", { when: new Date(s.at).toLocaleString(locale), rows: s.rows })}</span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={restore.isPending}
                  onClick={() =>
                    restore.mutate(
                      { name: w.name, file: s.file },
                      {
                        onSuccess: ({ rows }) => {
                          toast({ body: t("plugins.restored", { rows }) });
                          onClose();
                        },
                        onError: (e) => setError(messageOf(e))
                      }
                    )
                  }
                >
                  {t("plugins.restore")}
                </button>
              </li>
            ))}
          </ul>
          {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        </div>
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("plugins.close")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}

function DeleteDialog({ workspace: w, onClose }: { workspace: Workspace; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const remove = useStudioRemove();
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} label={t("plugins.deleteTitle", { title: w.title })} className="sheet-md">
      <DialogHead title={t("plugins.deleteTitle", { title: w.title })} />
      <DialogBody>
        <p>{t("plugins.deleteLede")}</p>
        <label className="row" style={{ gap: 8, marginTop: "var(--space-3)" }}>
          <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} /> {t("plugins.deleteFiles")}
        </label>
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        <Eyebrow className="meta-txt mono">{w.dir}</Eyebrow>
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("plugins.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(
              { name: w.name, deleteFiles },
              {
                onSuccess: () => {
                  toast({ body: t("plugins.deleted", { title: w.title }) });
                  onClose();
                },
                onError: (e) => setError(messageOf(e))
              }
            )
          }
        >
          {t("plugins.deleteWorkspace").replace("…", "")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}
