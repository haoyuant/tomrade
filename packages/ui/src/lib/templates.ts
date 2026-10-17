import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Cadence, ScheduleInput, TemplateInput } from "@tomradex/schedules";
import { invoke, subscribe } from "./api";
import { INTL_TAG } from "./domain";
import type { Locale } from "./i18n";

const keys = {
  all: (projectId: string) => ["schedules", projectId] as const,
  templates: (projectId: string) => ["schedules", projectId, "templates"] as const,
  schedules: (projectId: string) => ["schedules", projectId, "list"] as const,
  runs: (projectId: string, templateId: string) => ["schedules", projectId, "runs", templateId] as const,
  suggestions: (locale: string) => ["schedules", "suggestions", locale] as const
};

/** Anything a template, a schedule or a run changes refetches the lot: they are few. */
function useLive(projectId: string) {
  const qc = useQueryClient();
  useEffect(() => subscribe("schedules.changed", (id) => id === projectId && void qc.invalidateQueries({ queryKey: keys.all(projectId) })), [projectId, qc]);
}

/** Errors (the plugin is off) come back as a failed query, not an empty list. */
export function useTemplates(projectId: string) {
  useLive(projectId);
  return useQuery({ queryKey: keys.templates(projectId), queryFn: () => invoke("schedules.templates", projectId), retry: false });
}

export function useSchedules(projectId: string) {
  useLive(projectId);
  return useQuery({ queryKey: keys.schedules(projectId), queryFn: () => invoke("schedules.list", projectId), retry: false });
}

export const useTemplateRuns = (projectId: string, templateId: string | null) =>
  useQuery({ queryKey: keys.runs(projectId, templateId ?? ""), queryFn: () => invoke("schedules.runs", projectId, templateId!, 5), enabled: !!templateId });

export const useSuggestions = (locale: string) => useQuery({ queryKey: keys.suggestions(locale), queryFn: () => invoke("schedules.suggestions"), staleTime: Infinity, retry: false });

export function useTemplateActions(projectId: string) {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: keys.all(projectId) });
  return {
    create: useMutation({ mutationFn: (input: TemplateInput) => invoke("schedules.createTemplate", projectId, input), onSuccess: done }),
    update: useMutation({ mutationFn: ({ id, input }: { id: string; input: TemplateInput }) => invoke("schedules.updateTemplate", projectId, id, input), onSuccess: done }),
    remove: useMutation({ mutationFn: (id: string) => invoke("schedules.removeTemplate", projectId, id), onSuccess: done }),
    run: useMutation({ mutationFn: (id: string) => invoke("schedules.run", projectId, id), onSuccess: done }),
    addSuggestion: useMutation({ mutationFn: ({ id, withSchedule }: { id: string; withSchedule: boolean }) => invoke("schedules.addSuggestion", projectId, id, withSchedule), onSuccess: done }),
    schedule: useMutation({ mutationFn: (input: ScheduleInput) => invoke("schedules.create", projectId, input), onSuccess: done }),
    reschedule: useMutation({ mutationFn: ({ id, input }: { id: string; input: ScheduleInput }) => invoke("schedules.update", projectId, id, input), onSuccess: done }),
    unschedule: useMutation({ mutationFn: (id: string) => invoke("schedules.remove", projectId, id), onSuccess: done })
  };
}

const DAYS: Record<Locale, readonly string[]> = {
  en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  zh: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
  "zh-Hant": ["週一", "週二", "週三", "週四", "週五", "週六", "週日"],
  ja: ["月", "火", "水", "木", "金", "土", "日"],
  es: ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"],
  de: ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
  fr: ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"]
};

type CadenceWords = { [K in Cadence["kind"]]: (c: Extract<Cadence, { kind: K }>, days: (list: number[]) => string) => string };

const CADENCE: Record<Locale, CadenceWords> = {
  en: {
    daily: (c) => `every day at ${c.at}`,
    weekdays: (c) => `weekdays at ${c.at}`,
    weekly: (c, days) => `every ${days(c.days)} at ${c.at}`,
    monthly: (c) => `day ${c.day} of each month at ${c.at}`,
    days: (c) => `every ${c.every} days at ${c.at}`,
    hourly: (c) => (c.every === 1 ? "every hour" : `every ${c.every} hours`)
  },
  zh: {
    daily: (c) => `每天 ${c.at}`,
    weekdays: (c) => `工作日 ${c.at}`,
    weekly: (c, days) => `每${days(c.days)} ${c.at}`,
    monthly: (c) => `每月 ${c.day} 号 ${c.at}`,
    days: (c) => `每 ${c.every} 天 ${c.at}`,
    hourly: (c) => (c.every === 1 ? "每小时" : `每 ${c.every} 小时`)
  },
  "zh-Hant": {
    daily: (c) => `每天 ${c.at}`,
    weekdays: (c) => `工作日 ${c.at}`,
    weekly: (c, days) => `每${days(c.days)} ${c.at}`,
    monthly: (c) => `每月 ${c.day} 號 ${c.at}`,
    days: (c) => `每 ${c.every} 天 ${c.at}`,
    hourly: (c) => (c.every === 1 ? "每小時" : `每 ${c.every} 小時`)
  },
  ja: {
    daily: (c) => `毎日 ${c.at}`,
    weekdays: (c) => `平日 ${c.at}`,
    weekly: (c, days) => `毎週${days(c.days)} ${c.at}`,
    monthly: (c) => `毎月 ${c.day} 日 ${c.at}`,
    days: (c) => `${c.every} 日ごと ${c.at}`,
    hourly: (c) => (c.every === 1 ? "1 時間ごと" : `${c.every} 時間ごと`)
  },
  es: {
    daily: (c) => `cada día a las ${c.at}`,
    weekdays: (c) => `días laborables a las ${c.at}`,
    weekly: (c, days) => `cada ${days(c.days)} a las ${c.at}`,
    monthly: (c) => `el día ${c.day} de cada mes a las ${c.at}`,
    days: (c) => `cada ${c.every} días a las ${c.at}`,
    hourly: (c) => (c.every === 1 ? "cada hora" : `cada ${c.every} horas`)
  },
  de: {
    daily: (c) => `täglich um ${c.at}`,
    weekdays: (c) => `werktags um ${c.at}`,
    weekly: (c, days) => `jeden ${days(c.days)} um ${c.at}`,
    monthly: (c) => `am ${c.day}. jedes Monats um ${c.at}`,
    days: (c) => `alle ${c.every} Tage um ${c.at}`,
    hourly: (c) => (c.every === 1 ? "stündlich" : `alle ${c.every} Stunden`)
  },
  fr: {
    daily: (c) => `tous les jours à ${c.at}`,
    weekdays: (c) => `en semaine à ${c.at}`,
    weekly: (c, days) => `chaque ${days(c.days)} à ${c.at}`,
    monthly: (c) => `le ${c.day} de chaque mois à ${c.at}`,
    days: (c) => `tous les ${c.every} jours à ${c.at}`,
    hourly: (c) => (c.every === 1 ? "toutes les heures" : `toutes les ${c.every} heures`)
  }
};

const known = (locale: string): Locale => (locale in DAYS ? (locale as Locale) : "en");

/** A cadence in a few words: "every day at 08:00", "每 3 天 09:00". */
export function cadenceLabel(c: Cadence, locale: string): string {
  const l = known(locale);
  const cjk = l === "zh" || l === "zh-Hant";
  const days = (list: number[]) => [...list].sort().map((d) => DAYS[l][d - 1]).join(cjk ? "、" : ", ");
  return (CADENCE[l][c.kind] as (c: Cadence, days: (list: number[]) => string) => string)(c, days);
}

/** When it runs next, as a calendar reads it: "Mon, Oct 19, 09:00". */
export const nextLabel = (ts: number, locale: string) =>
  new Date(ts).toLocaleString(INTL_TAG[known(locale)], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

export const dayNames = (locale: string) => DAYS[known(locale)];
