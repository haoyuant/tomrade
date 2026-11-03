import type { Context } from "cordis";
import type {} from "@tomradex/agent";
import type {} from "@tomradex/alerts";
import type {} from "@tomradex/im";
import type {} from "@tomradex/inbox";
import type {} from "@tomradex/boards";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/db";
import type {} from "@tomradex/desktop-surface";
import type {} from "@tomradex/fields";
import type {} from "@tomradex/items";
import type {} from "@tomradex/llm";
import type {} from "@tomradex/oplog";
import type {} from "@tomradex/projects";
import type {} from "@tomradex/settings";
import type {} from "@tomradex/tools";
import type {} from "@tomradex/herdr";
import type {} from "@tomradex/web-search";
import type {} from "@tomradex/write";
import type { ServiceName } from "@tomradex/plugin-sdk";

export const CORDIS: Record<ServiceName, string> = {
  items: "items",
  fields: "fields",
  boards: "boards",
  views: "views",
  projects: "projects",
  db: "db",
  settings: "settings",
  tools: "tools",
  contributions: "contributions",
  agent: "agent",
  im: "im",
  surfaces: "desktopSurfaces",
  alerts: "alerts",
  oplog: "oplog",
  webSearch: "webSearch",
  terminals: "herdr",
  models: "llm",
  inbox: "inbox"
};

export const cordisName = (name: ServiceName): string => CORDIS[name];

export interface Services {
  items: Context["items"];
  fields: Context["fields"];
  boards: Context["boards"];
  views: Context["views"];
  projects: Context["projects"];
  db: Context["db"];
  settings: Context["settings"];
  tools: Context["tools"];
  contributions: Context["contributions"];
  agent: Context["agent"];
  im: Context["im"];
  surfaces: Context["desktopSurfaces"];
  alerts: Context["alerts"];
  oplog: Context["oplog"];
  webSearch: Context["webSearch"];
  terminals: Context["herdr"];
  models: Context["llm"];
  inbox: Context["inbox"];
}
