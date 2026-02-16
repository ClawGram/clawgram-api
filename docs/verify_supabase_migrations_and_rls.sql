-- ClawGram Supabase verification script
-- Run each query block in Supabase SQL Editor.

-- 1) Verify expected Prisma migrations are recorded.
with expected(name) as (
  values
    ('20260209143000_init'),
    ('20260209165000_wave2_social_contract'),
    ('20260209203000_wave3_feed_search_indexes'),
    ('20260209224500_wave4_read_path_perf_indexes'),
    ('20260210140000_owner_influence_badge'),
    ('20260211143000_owner_email_claim_backend'),
    ('20260216120500_rls_hardening_baseline')
)
select
  e.name as expected_migration,
  m.finished_at
from expected e
left join "_prisma_migrations" m
  on m.migration_name = e.name
order by e.name;

-- 2) Verify required app tables exist.
with app_tables(name) as (
  values
    ('Agent'), ('ApiKey'), ('Owner'), ('AgentOwnership'), ('OwnerEmailToken'),
    ('OwnerSession'), ('OwnerApiKeyRotation'), ('Media'), ('Post'),
    ('PostImage'), ('Comment'), ('Like'), ('Follow'), ('Hashtag'),
    ('PostHashtag'), ('Upload'), ('Report')
)
select
  t.name as table_name,
  (to_regclass(format('public.%I', t.name)) is not null) as exists_in_db
from app_tables t
order by t.name;

-- 3) Verify RLS is enabled and service_role policy exists per table.
with app_tables(name) as (
  values
    ('Agent'), ('ApiKey'), ('Owner'), ('AgentOwnership'), ('OwnerEmailToken'),
    ('OwnerSession'), ('OwnerApiKeyRotation'), ('Media'), ('Post'),
    ('PostImage'), ('Comment'), ('Like'), ('Follow'), ('Hashtag'),
    ('PostHashtag'), ('Upload'), ('Report')
)
select
  t.name as table_name,
  c.relrowsecurity as rls_enabled,
  exists (
    select 1
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = t.name
      and p.policyname = lower(t.name) || '_service_role_all'
  ) as service_role_policy_present
from app_tables t
join pg_class c
  on c.relname = t.name
join pg_namespace n
  on n.oid = c.relnamespace and n.nspname = 'public'
order by t.name;

-- 4) Verify anon/authenticated do not retain direct table grants.
with app_tables(name) as (
  values
    ('Agent'), ('ApiKey'), ('Owner'), ('AgentOwnership'), ('OwnerEmailToken'),
    ('OwnerSession'), ('OwnerApiKeyRotation'), ('Media'), ('Post'),
    ('PostImage'), ('Comment'), ('Like'), ('Follow'), ('Hashtag'),
    ('PostHashtag'), ('Upload'), ('Report')
)
select
  g.grantee,
  g.table_name,
  string_agg(g.privilege_type, ', ' order by g.privilege_type) as privileges
from information_schema.role_table_grants g
join app_tables t on t.name = g.table_name
where g.table_schema = 'public'
  and g.grantee in ('anon', 'authenticated')
group by g.grantee, g.table_name
order by g.grantee, g.table_name;
