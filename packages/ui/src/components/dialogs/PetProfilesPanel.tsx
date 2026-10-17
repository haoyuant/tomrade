import { useEffect, useRef, useState } from "react";
import type { PetMood, PetProfileView } from "@tomradex/pet";
import { Icon } from "~/components/icons";
import { SectionHead, Tag } from "~/components/ui/atoms";
import { readAttachment } from "~/components/workspace/AgentAttachment";
import { PetCanvas } from "~/components/workspace/PetCanvas";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useActivatePetProfile, useClearPetImage, useCreatePetProfile, useDeletePetProfile, usePetPreview, usePetProfiles, useSetPetImage, useUpdatePetProfile } from "~/lib/pet";
import { measurePetImage, PET_IMAGE_TYPES } from "~/lib/petPlayer";
import { readableError } from "~/lib/toast";
import { cn } from "~/lib/utils";

const moodKey = (mood: PetMood) => `petProfiles.mood_${mood}` as MessageKey;
const whenKey = (mood: PetMood) => `petProfiles.mood_${mood}_when` as MessageKey;

/** One state of the pet being edited: what it shows, when, and the way to change it. */
function MoodSlot({ profile, mood, maxBytes, onError }: { profile: PetProfileView; mood: PetMood; maxBytes: number; onError: (message: string | null) => void }) {
  const { t } = useI18n();
  const preview = usePetPreview(profile.id);
  const setImage = useSetPetImage();
  const clearImage = useClearPetImage();
  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const custom = profile.custom.includes(mood);
  const mb = Math.round(maxBytes / 1024 / 1024);

  const upload = async (file: File) => {
    onError(null);
    if (file.size > maxBytes) return onError(t("petProfiles.tooBig", { mb }));
    setReading(true);
    try {
      const box = await measurePetImage(file).catch(() => {
        throw new Error(t("petProfiles.unsupported"));
      });
      await setImage.mutateAsync({ id: profile.id, mood, upload: { base64: await readAttachment(file), box } });
    } catch (error) {
      onError(readableError(error));
    } finally {
      setReading(false);
    }
  };

  return (
    <div className={cn("pet-slot", custom && "is-custom")} data-mood={mood}>
      <PetCanvas className="pet-slot-preview" animation={preview.data?.[mood]} width={120} height={96} label={t(moodKey(mood))} />
      <div className="pet-slot-body">
        <div className="row" style={{ gap: 6 }}>
          <span className="pet-slot-name">{t(moodKey(mood))}</span>
          {!profile.builtIn && <Tag tone={custom ? "strong" : "faint"}>{custom ? t("petProfiles.yours") : t("petProfiles.fromBuiltIn")}</Tag>}
        </div>
        <span className="meta-txt dense">{t(whenKey(mood))}</span>
        {!profile.builtIn && (
          <div className="row" style={{ gap: 6, marginTop: 4 }}>
            <button type="button" className="btn btn-secondary btn-xs" disabled={reading || setImage.isPending} onClick={() => input.current?.click()}>
              {reading ? t("petProfiles.reading") : custom ? t("petProfiles.replace") : t("petProfiles.choose")}
            </button>
            {custom && (
              <button type="button" className="btn btn-ghost btn-xs" disabled={clearImage.isPending} onClick={() => clearImage.mutate({ id: profile.id, mood }, { onError: (e) => onError(readableError(e)) })}>
                {t("petProfiles.useBuiltIn")}
              </button>
            )}
            <input
              ref={input}
              type="file"
              accept={PET_IMAGE_TYPES.join(",")}
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void upload(file);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileEditor({ profile, moods, maxBytes }: { profile: PetProfileView; moods: PetMood[]; maxBytes: number }) {
  const { t } = useI18n();
  const update = useUpdatePetProfile();
  const remove = useDeletePetProfile();
  const [name, setName] = useState(profile.name);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setName(profile.name), [profile.id, profile.name]);
  useEffect(() => setError(null), [profile.id]);

  const rename = () => {
    if (name.trim() && name.trim() !== profile.name) update.mutate({ id: profile.id, patch: { name } }, { onError: (e) => setError(readableError(e)) });
    else setName(profile.name);
  };

  return (
    <div className="panel stack-3" data-testid="pet-editor">
      {profile.builtIn ? (
        <p className="meta-txt">{t("petProfiles.builtInNote")}</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor="petName">{t("petProfiles.name")}</label>
            <input
              id="petName"
              className="input"
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              onBlur={rename}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </div>
          <label className="row pet-pixel" style={{ gap: 8 }}>
            <input type="checkbox" checked={profile.pixelated} onChange={(event) => update.mutate({ id: profile.id, patch: { pixelated: event.target.checked } }, { onError: (e) => setError(readableError(e)) })} />
            <span>
              {t("petProfiles.pixelArt")}
              <span className="meta-txt dense" style={{ display: "block" }}>{t("petProfiles.pixelArtHint")}</span>
            </span>
          </label>
          <p className="meta-txt dense">{t("petProfiles.formats", { mb: Math.round(maxBytes / 1024 / 1024) })}</p>
        </>
      )}
      <div className="pet-slots">
        {moods.map((mood) => (
          <MoodSlot key={mood} profile={profile} mood={mood} maxBytes={maxBytes} onError={setError} />
        ))}
      </div>
      {error && (
        <p className="meta-txt dense" role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
      {!profile.builtIn && (
        <div className="row">
          {confirming ? (
            <button type="button" className="btn btn-danger" autoFocus onBlur={() => setConfirming(false)} onClick={() => remove.mutate(profile.id, { onError: (e) => setError(readableError(e)) })}>
              {t("petProfiles.confirmDelete", { name: profile.name })}
            </button>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(true)}>
              <Icon name="i-trash" size={13} /> {t("petProfiles.delete")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The pets on this machine: the built-in one, which can't be changed or
 * removed, and any the user made from their own images. Picking one in the
 * list opens it for editing; "Use" puts it on screen.
 */
export function PetProfilesPanel() {
  const { t } = useI18n();
  const profiles = usePetProfiles();
  const create = useCreatePetProfile();
  const activate = useActivatePetProfile();
  const [selected, setSelected] = useState<string | null>(null);
  const view = profiles.data;
  if (!view) return null;
  const editing = view.profiles.find((p) => p.id === (selected ?? view.active)) ?? view.profiles[0];
  const label = (p: PetProfileView) => (p.builtIn ? t("petProfiles.builtInName") : p.name);

  const addPet = async () => {
    const pet = await create.mutateAsync(t("petProfiles.newPetName"));
    await activate.mutateAsync(pet.id);
    setSelected(pet.id);
  };

  return (
    <>
      <SectionHead title={t("petProfiles.heading")}>{t("petProfiles.lede")}</SectionHead>
      <div className="stack-3">
        {view.profiles.map((p) => (
          <div key={p.id} className={cn("cfg-row pet-profile", p.id === editing.id && "is-selected")} data-profile={p.id}>
            <button type="button" className="pet-profile-pick" aria-pressed={p.id === editing.id} onClick={() => setSelected(p.id)}>
              <span className="cfg-name">{label(p)}</span>
              {p.builtIn && <Tag tone="faint">{t("petProfiles.builtInTag")}</Tag>}
            </button>
            {p.id === view.active ? (
              <Tag tone="strong">{t("petProfiles.inUse")}</Tag>
            ) : (
              <button type="button" className="btn btn-ghost btn-xs" disabled={activate.isPending} onClick={() => activate.mutate(p.id)}>
                {t("petProfiles.use")}
              </button>
            )}
          </div>
        ))}
        {view.canSave ? (
          <div className="row">
            <button type="button" className="btn btn-secondary" disabled={create.isPending} onClick={() => void addPet()} data-testid="pet-new">
              <Icon name="i-plus" size={13} /> {t("petProfiles.newPet")}
            </button>
          </div>
        ) : (
          <p className="meta-txt">{t("petProfiles.noFolder")}</p>
        )}
        <ProfileEditor key={editing.id} profile={editing} moods={view.moods} maxBytes={view.maxImageBytes} />
      </div>
    </>
  );
}
