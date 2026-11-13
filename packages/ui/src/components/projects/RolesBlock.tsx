import { useMemo, useState } from "react";
import type { Role, RoleInput, RoleStage } from "@tomradex/roles";
import { Icon } from "~/components/icons";
import { Spacer, Tag } from "~/components/ui/atoms";
import { useEngines } from "~/lib/agent";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { ROLE_LIMITS, useRemoveRole, useRoles, useSaveRole } from "~/lib/roles";
import { errorSpec, useToast } from "~/lib/toast";

const INSTRUCTIONS_MAX = 8000;

/** What the editor holds of a role: what a person can change of it. */
type Draft = Required<Pick<RoleInput, "title" | "stage" | "engines" | "permission" | "instructions">> & { id?: string };

const draftOf = (role: Role): Draft => ({ id: role.id, title: role.title, stage: role.stage, engines: role.engines, permission: role.permission, instructions: role.instructions });
const same = (a: Draft, b: Draft) => a.title.trim() === b.title && a.stage === b.stage && a.permission === b.permission && a.instructions.trim() === b.instructions && a.engines.join("\n") === b.engines.join("\n");

/**
 * The project's roles: the two every project has and the ones it made, each opened in place to be changed. A role
 * saves on its own, apart from the sheet's Save.
 */
export function RolesBlock({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const roles = useRoles(projectId);
  const save = useSaveRole(projectId);
  const remove = useRemoveRole(projectId);
  const engines = useEngines();
  const known = useMemo(() => (engines.data ?? []).filter((engine) => engine.capabilities.includes("code")), [engines.data]);
  const titleOf = (id: string) => known.find((engine) => engine.id === id)?.title ?? t("roles.engineElsewhere", { agent: id });
  // The role open in the editor: one of the list's by id, or a new one that has no id yet.
  const [open, setOpen] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const list = roles.data ?? [];
  const shown = open === "new" ? null : (list.find((role) => role.id === open) ?? null);
  const busy = save.isPending || remove.isPending;

  const edit = (role: Role) => {
    setOpen(role.id);
    setDraft(draftOf(role));
  };
  const begin = (from?: Role) => {
    setOpen("new");
    setDraft(from ? { ...draftOf(from), id: undefined, title: t("roles.copyOf", { title: from.title }) } : { title: t("roles.newTitle"), stage: "implement", engines: [], permission: null, instructions: "" });
  };
  const close = () => {
    setOpen(null);
    setDraft(null);
  };
  const submit = () => {
    if (!draft) return;
    save.mutate(draft, {
      onSuccess: (saved) => {
        toast({ body: t("roles.saved") });
        edit(saved);
      },
      onError: (err) => toast(errorSpec(err))
    });
  };
  const drop = (role: Role) =>
    remove.mutate(role.id, {
      onSuccess: () => {
        toast({ body: role.builtin ? t("roles.restored", { title: role.title }) : t("roles.removed") });
        close();
      },
      onError: (err) => toast(errorSpec(err))
    });

  const dirty = !!draft && (open === "new" || (!!shown && !same(draft, draftOf(shown))));
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const addable = known.filter((engine) => !draft?.engines.includes(engine.id));

  const editor = draft && (
    <div className="role-editor stack-3" data-testid="role-editor">
      <div className="grid-2">
        <div className="field">
          <label htmlFor="roleName">{t("roles.nameLabel")}</label>
          <input id="roleName" className="input" maxLength={60} value={draft.title} disabled={busy} onChange={(e) => set({ title: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="roleStage">{t("roles.stageLabel")}</label>
          <select id="roleStage" className="select" value={draft.stage} disabled={busy || !!shown?.builtin} onChange={(e) => set({ stage: e.target.value as RoleStage, ...(e.target.value === "review" ? { permission: "read" as const } : draft.stage === "review" ? { permission: null } : {}) })}>
            <option value="implement">{t("roles.stage_implement")}</option>
            <option value="review">{t("roles.stage_review")}</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="roleEngineAdd">{t("roles.enginesLabel")}</label>
        {draft.engines.length > 0 ? (
          <ol className="role-engines" data-testid="role-engines">
            {draft.engines.map((id, at) => (
              <li key={id} className="role-engines__item">
                <span className="num meta-txt">{at + 1}</span>
                <span className="role-engines__name">{titleOf(id)}</span>
                <button type="button" className="btn btn-icon" disabled={busy || at === 0} aria-label={t("roles.engineUp", { agent: titleOf(id) })} title={t("roles.engineUp", { agent: titleOf(id) })} onClick={() => set({ engines: [...draft.engines.slice(0, at - 1), id, draft.engines[at - 1]!, ...draft.engines.slice(at + 1)] })}>
                  <Icon name="i-chevdown" size={13} className="role-engines__up" />
                </button>
                <button type="button" className="btn btn-icon" disabled={busy} aria-label={t("roles.engineRemove", { agent: titleOf(id) })} title={t("roles.engineRemove", { agent: titleOf(id) })} onClick={() => set({ engines: draft.engines.filter((engine) => engine !== id) })}>
                  <Icon name="i-close" size={13} />
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="meta-txt">{t("roles.enginesNone")}</p>
        )}
        {addable.length > 0 && (
          <select id="roleEngineAdd" className="select" data-testid="role-engine-add" value="" disabled={busy} onChange={(e) => e.target.value && set({ engines: [...draft.engines, e.target.value] })}>
            <option value="">{t("roles.enginesAdd")}</option>
            {addable.map((engine) => (
              <option key={engine.id} value={engine.id}>{engine.title}</option>
            ))}
          </select>
        )}
        {draft.engines.length > 0 && <p className="meta-txt dense">{t("roles.enginesHint")}</p>}
      </div>

      <div className="field">
        <label htmlFor="roleLimit">{t("roles.limitLabel")}</label>
        {draft.stage === "review" ? (
          <p className="meta-txt" id="roleLimit">{t("roles.limitReview")}</p>
        ) : (
          <select id="roleLimit" className="select" data-testid="role-limit" value={draft.permission ?? ""} disabled={busy} onChange={(e) => set({ permission: (e.target.value || null) as Draft["permission"] })}>
            <option value="">{t("roles.limitNone")}</option>
            {ROLE_LIMITS.map((limit) => (
              <option key={limit} value={limit}>{t(`devices.ceiling_${limit}` as MessageKey)}</option>
            ))}
          </select>
        )}
        {draft.stage !== "review" && draft.permission && <p className="meta-txt dense">{t(`devices.ceilingHint_${draft.permission}` as MessageKey)}</p>}
      </div>

      <div className="field">
        <label htmlFor="roleInstructions">{t("roles.instructionsLabel")}</label>
        <textarea id="roleInstructions" className="textarea" rows={5} maxLength={INSTRUCTIONS_MAX} placeholder={t("roles.instructionsPlaceholder")} value={draft.instructions} disabled={busy} onChange={(e) => set({ instructions: e.target.value })} />
        <p className="meta-txt dense">{t("roles.instructionsHint")}</p>
      </div>

      <div className="row" style={{ gap: "var(--space-2)" }}>
        {shown && (
          <button type="button" className="btn btn-ghost" data-testid="role-copy" disabled={busy} onClick={() => begin(shown)}>
            {t("roles.copy")}
          </button>
        )}
        {shown && (!shown.builtin || shown.changed) && (
          <button type="button" className="btn btn-ghost" data-testid="role-remove" disabled={busy} onClick={() => drop(shown)}>
            {t(shown.builtin ? "roles.reset" : "roles.remove")}
          </button>
        )}
        <Spacer />
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>
          {t(dirty ? "roles.revert" : "common.close")}
        </button>
        <button type="button" className="btn btn-primary" data-testid="role-save" disabled={busy || !dirty || !draft.title.trim()} onClick={submit}>
          {t("roles.save")}
        </button>
      </div>
    </div>
  );

  return (
    <div className="project-settings-section stack-3" data-testid="project-roles">
      <ul className="role-list">
        {list.map((role) => (
          <li key={role.id} className={`role-list__item${open === role.id ? " is-open" : ""}`}>
            <button type="button" className="role-list__head" data-testid="role-row" aria-expanded={open === role.id} onClick={() => (open === role.id ? close() : edit(role))}>
              <span className="role-list__title">{role.title}</span>
              <Tag tone="faint">{t(`roles.stage_${role.stage}` as MessageKey)}</Tag>
              {role.builtin && <Tag tone="faint">{t("roles.builtin")}</Tag>}
              <span className="meta-txt role-list__brief">
                {[role.engines.map(titleOf).join(" → "), role.stage === "implement" && role.permission ? t(`devices.ceiling_${role.permission}` as MessageKey) : ""].filter(Boolean).join(" · ")}
              </span>
            </button>
            {open === role.id && editor}
          </li>
        ))}
        {open === "new" && <li className="role-list__item is-open">{editor}</li>}
      </ul>
      {open !== "new" && (
        <div className="row">
          <button type="button" className="btn btn-secondary" data-testid="role-add" disabled={busy} onClick={() => begin()}>
            {t("roles.add")}
          </button>
        </div>
      )}
    </div>
  );
}
