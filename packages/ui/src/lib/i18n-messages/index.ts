import { agentPanel } from "./agentPanel";
import { board } from "./board";
import { boardSettingsDialog } from "./boardSettingsDialog";
import { card } from "./card";
import { commandPalette } from "./commandPalette";
import { common } from "./common";
import { deleteIssueDialog } from "./deleteIssueDialog";
import { destination } from "./destination";
import { detailPane } from "./detailPane";
import { fields } from "./fields";
import { fieldsDialog } from "./fieldsDialog";
import { issueScreen } from "./issueScreen";
import { language } from "./language";
import { newIssueDialog } from "./newIssueDialog";
import { newProjectDialog } from "./newProjectDialog";
import { openProjectDialog } from "./openProjectDialog";
import { playbooks } from "./playbooks";
import { pluginsPanel } from "./pluginsPanel";
import { projectSettingsDialog } from "./projectSettingsDialog";
import { projectsScreen } from "./projectsScreen";
import { queryBar } from "./queryBar";
import { settingsDialog } from "./settingsDialog";
import { sidebar } from "./sidebar";
import { statusBar } from "./statusBar";
import { storageBlock } from "./storageBlock";
import { theme } from "./theme";
import { titleBar } from "./titleBar";
import { toast } from "./toast";
import { viewSettingsDialog } from "./viewSettingsDialog";
import { workspace } from "./workspace";
import { graphView } from "./graphView";
import { workspaceContext } from "./workspaceContext";

export const en = {
  common: common.en,
  theme: theme.en,
  language: language.en,
  settingsDialog: settingsDialog.en,
  playbooks: playbooks.en,
  pluginsPanel: pluginsPanel.en,
  boardSettingsDialog: boardSettingsDialog.en,
  deleteIssueDialog: deleteIssueDialog.en,
  newIssueDialog: newIssueDialog.en,
  viewSettingsDialog: viewSettingsDialog.en,
  fieldsDialog: fieldsDialog.en,
  destination: destination.en,
  toast: toast.en,

  projectsScreen: projectsScreen.en,
  newProjectDialog: newProjectDialog.en,
  openProjectDialog: openProjectDialog.en,
  projectSettingsDialog: projectSettingsDialog.en,
  storageBlock: storageBlock.en,

  titleBar: titleBar.en,
  sidebar: sidebar.en,
  statusBar: statusBar.en,
  commandPalette: commandPalette.en,

  workspace: workspace.en,
  board: board.en,
  card: card.en,
  graphView: graphView.en,
  queryBar: queryBar.en,
  workspaceContext: workspaceContext.en,

  issueScreen: issueScreen.en,
  detailPane: detailPane.en,
  fields: fields.en,
  agentPanel: agentPanel.en
};

export const zh: typeof en = {
  common: common.zh,
  theme: theme.zh,
  language: language.zh,
  settingsDialog: settingsDialog.zh,
  playbooks: playbooks.zh,
  pluginsPanel: pluginsPanel.zh,
  boardSettingsDialog: boardSettingsDialog.zh,
  deleteIssueDialog: deleteIssueDialog.zh,
  newIssueDialog: newIssueDialog.zh,
  viewSettingsDialog: viewSettingsDialog.zh,
  fieldsDialog: fieldsDialog.zh,
  destination: destination.zh,
  toast: toast.zh,

  projectsScreen: projectsScreen.zh,
  newProjectDialog: newProjectDialog.zh,
  openProjectDialog: openProjectDialog.zh,
  projectSettingsDialog: projectSettingsDialog.zh,
  storageBlock: storageBlock.zh,

  titleBar: titleBar.zh,
  sidebar: sidebar.zh,
  statusBar: statusBar.zh,
  commandPalette: commandPalette.zh,

  workspace: workspace.zh,
  board: board.zh,
  card: card.zh,
  graphView: graphView.zh,
  queryBar: queryBar.zh,
  workspaceContext: workspaceContext.zh,

  issueScreen: issueScreen.zh,
  detailPane: detailPane.zh,
  fields: fields.zh,
  agentPanel: agentPanel.zh
};
