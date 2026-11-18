-- Registry 4 (TOM-1117): the actions the client now reports, and what shipped after registry 3.
--
-- Registry 4 is registry 3 plus:
--
--   code.link        / repo_connected   a repository connected for agents in the person's own terminal
--   doctor           / send_feedback    feedback sent to the maintainers
--   settings         / change           eighteen more built-in sections in its closed set of dims
--   agent.nightshift   open✓ start✓ stop                          auto run (night shift)
--   code.dispatch      send✓ take_back                             a ticket sent to another computer
--   code.review        open✓ comment send_comments✓ mark_reviewed request_review✓
--   backlog.delivery   submit accept request_changes               a general ticket's delivery (sub)
--   code.worktrees     remove                                      worktrees removed by hand (sub)
--   project.takeover   open✓ apply✓                                take over existing work
--   project.settings   open✓ rules_save brief_save role_save
--   backlog.history    open✓ rollback✓
--   project.page       open✓ publish✓                              build page
--   agent.playbook     save✓ import✓
--
-- ✓ counts as a use. Inserting the rows re-judges whatever registry-4 clients
-- sent before this ran (202611110104). It mirrors packages/analytics/src/features.ts;
-- the package's tests compare the two, so a registry change without its migration fails CI.
begin;

insert into public.tomrade_analytics_registry (registry, feature_id, action, counted, dims)
select 4, feature_id, action, counted, dims
  from public.tomrade_analytics_registry
 where registry = 3
   and not (feature_id = 'settings' and action = 'change');

insert into public.tomrade_analytics_registry (registry, feature_id, action, counted, dims) values
  (4, 'settings', 'change', false, array[
    'theme', 'language', 'customThemes', 'themeAutomation', 'notifications', 'updates', 'account', 'agent', 'mcp', 'plugins', 'im', 'analytics',
    'acpRegistry', 'changeReview', 'dispatch', 'files', 'keybindings', 'mcpServers', 'models', 'notes', 'onboarding', 'performanceMode',
    'pet', 'prFeedback', 'shell', 'terminalIdle', 'terminalRecording', 'unifiedSky', 'watchdog', 'worktrees'
  ]),
  (4, 'code.link', 'repo_connected', false, null),
  (4, 'doctor', 'send_feedback', false, null),
  (4, 'agent.nightshift', 'open', true, null),
  (4, 'agent.nightshift', 'start', true, null),
  (4, 'agent.nightshift', 'stop', false, null),
  (4, 'code.dispatch', 'send', true, null),
  (4, 'code.dispatch', 'take_back', false, null),
  (4, 'code.review', 'open', true, null),
  (4, 'code.review', 'comment', false, null),
  (4, 'code.review', 'send_comments', true, null),
  (4, 'code.review', 'mark_reviewed', false, null),
  (4, 'code.review', 'request_review', true, null),
  (4, 'backlog.delivery', 'submit', false, null),
  (4, 'backlog.delivery', 'accept', false, null),
  (4, 'backlog.delivery', 'request_changes', false, null),
  (4, 'code.worktrees', 'remove', false, null),
  (4, 'project.takeover', 'open', true, null),
  (4, 'project.takeover', 'apply', true, null),
  (4, 'project.settings', 'open', true, null),
  (4, 'project.settings', 'rules_save', false, null),
  (4, 'project.settings', 'brief_save', false, null),
  (4, 'project.settings', 'role_save', false, null),
  (4, 'backlog.history', 'open', true, null),
  (4, 'backlog.history', 'rollback', true, null),
  (4, 'project.page', 'open', true, null),
  (4, 'project.page', 'publish', true, null),
  (4, 'agent.playbook', 'save', true, null),
  (4, 'agent.playbook', 'import', true, null);

commit;
