import { boardSettingsDialog } from "./boardSettingsDialog";
import { common } from "./common";
import { deleteIssueDialog } from "./deleteIssueDialog";
import { destination } from "./destination";
import { language } from "./language";
import { newIssueDialog } from "./newIssueDialog";
import { pluginsPanel } from "./pluginsPanel";
import { settingsDialog } from "./settingsDialog";
import { theme } from "./theme";
import { toast } from "./toast";
import { viewSettingsDialog } from "./viewSettingsDialog";

export const en = {
  common: common.en,
  theme: theme.en,
  language: language.en,
  settingsDialog: settingsDialog.en,
  pluginsPanel: pluginsPanel.en,
  boardSettingsDialog: boardSettingsDialog.en,
  deleteIssueDialog: deleteIssueDialog.en,
  newIssueDialog: newIssueDialog.en,
  viewSettingsDialog: viewSettingsDialog.en,
  destination: destination.en,
  toast: toast.en
};

export const zh: typeof en = {
  common: common.zh,
  theme: theme.zh,
  language: language.zh,
  settingsDialog: settingsDialog.zh,
  pluginsPanel: pluginsPanel.zh,
  boardSettingsDialog: boardSettingsDialog.zh,
  deleteIssueDialog: deleteIssueDialog.zh,
  newIssueDialog: newIssueDialog.zh,
  viewSettingsDialog: viewSettingsDialog.zh,
  destination: destination.zh,
  toast: toast.zh
};
