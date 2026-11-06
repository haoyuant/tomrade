-- Every read of the event table filters on a ts range, and sometimes on region.
-- None filters on anon_id or feature_id, and prod's index stats show these two
-- were never scanned on any partition while region_ts was used hundreds of times.
-- They only cost each ingested event two more index writes. Dropping the parent
-- index drops it on every partition, and months made later never get it.
begin;

drop index if exists public.tomrade_analytics_event_anon_ts;
drop index if exists public.tomrade_analytics_event_feature_ts;

commit;
