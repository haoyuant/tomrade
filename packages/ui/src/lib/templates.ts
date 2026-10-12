import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Cadence, ScheduleInput, TemplateInput } from "@tomradex/schedules";
import { invoke, subscribe } from "./api";

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

const DAYS = { en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], zh: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] } as const;

/** A cadence in a few words: "every day at 08:00", "每 3 天 09:00". */
export function cadenceLabel(c: Cadence, locale: string): string {
  const zh = locale === "zh";
  const days = (list: number[]) => [...list].sort().map((d) => DAYS[zh ? "zh" : "en"][d - 1]).join(zh ? "、" : ", ");
  switch (c.kind) {
    case "daily": return zh ? `每天 ${c.at}` : `every day at ${c.at}`;
    case "weekdays": return zh ? `工作日 ${c.at}` : `weekdays at ${c.at}`;
    case "weekly": return zh ? `每${days(c.days)} ${c.at}` : `every ${days(c.days)} at ${c.at}`;
    case "monthly": return zh ? `每月 ${c.day} 号 ${c.at}` : `day ${c.day} of each month at ${c.at}`;
    case "days": return zh ? `每 ${c.every} 天 ${c.at}` : `every ${c.every} days at ${c.at}`;
    case "hourly": return c.every === 1 ? (zh ? "每小时" : "every hour") : zh ? `每 ${c.every} 小时` : `every ${c.every} hours`;
  }
}

/** When it runs next, as a calendar reads it: "Mon, Oct 19, 09:00". */
export const nextLabel = (ts: number, locale: string) =>
  new Date(ts).toLocaleString(locale === "zh" ? "zh-CN" : "en", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

export const dayNames = (locale: string) => DAYS[locale === "zh" ? "zh" : "en"];
