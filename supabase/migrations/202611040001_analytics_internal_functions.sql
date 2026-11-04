-- Ingest's helpers are for ingest alone. PostgreSQL gives every new function's
-- EXECUTE to PUBLIC, and these three were never taken back, so anyone holding
-- the publishable key could call them over /rest/v1/rpc. ensure_month is a
-- security definer that makes a partition for whatever month it is handed:
-- called in a loop it fills the database with empty tables. Ingest and the
-- scope trigger run them as the tables' owner, which keeps its EXECUTE.
begin;

revoke all on function public.tomrade_analytics_ensure_month(timestamptz) from public, anon, authenticated;
revoke all on function public.tomrade_analytics_region() from public, anon, authenticated;
revoke all on function public.tomrade_analytics_scope_allows(text) from public, anon, authenticated;

commit;
