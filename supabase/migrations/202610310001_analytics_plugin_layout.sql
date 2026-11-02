-- Registry 3 and the plugin layout surface (TOM-862).
--
-- Registry 3 is registry 2 plus one surface: a view drawn by a plugin's own
-- layout, counted as a use when it opens, like the board, table and graph.
--
--   backlog.plugin / open   a plugin's layout shown in the backlog region
--
-- It mirrors packages/analytics/src/features.ts; the package's tests compare
-- the two, so a registry change without its migration fails CI.
begin;

insert into public.tomrade_analytics_registry (registry, feature_id, action, counted, dims)
select 3, feature_id, action, counted, dims
  from public.tomrade_analytics_registry
 where registry = 2;

insert into public.tomrade_analytics_registry (registry, feature_id, action, counted, dims) values
  (3, 'backlog.plugin', 'open', true, null);

commit;
