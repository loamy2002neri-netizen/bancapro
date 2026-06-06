-- ════════════════════════════════════════════════════════════
--  FIX: Dono (admin) NUNCA aparece no ranking — server-side
--
--  Bug confirmado: contas de owner_emails apareciam no leaderboard pra
--  outros usuarios. Frontend filtra agora, mas server-side precisa
--  cobrir tambem (defense in depth).
--
--  Atualiza TODAS as 4 RPCs de leaderboard:
--    - get_leaderboard         (total/geral)
--    - get_leaderboard_today
--    - get_leaderboard_weekly
--    - get_leaderboard_monthly
--
--  ATENCAO: lista de owner_emails precisa bater com OWNER_EMAILS no JS.
-- ════════════════════════════════════════════════════════════

-- Helper: lista de emails de dono (mesma do JS frontend)
create or replace function public.is_owner_email(p_email text)
returns boolean
language sql
immutable
as $$
  select lower(coalesce(p_email,'')) in (
    'loamy2002neri@gmail.com',
    'loamy69zzz@gmail.com'
  );
$$;

grant execute on function public.is_owner_email(text) to anon, authenticated;

-- ════════════════════════════════════════════════════════════
-- 1. get_leaderboard_today
-- ════════════════════════════════════════════════════════════
create or replace function public.get_leaderboard_today()
returns table(display_name text, profit numeric, is_pro boolean)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_today text := to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM-DD');
begin
  return query
  with parsed as (
    select
      ud.user_id, au.email,
      coalesce(nullif(ud.data->>'bancapro-display-name',''), split_part(au.email,'@',1)) as display_name,
      ((ud.data->>'bancapro-transactions'))::jsonb as txs
    from public.user_data ud
    join auth.users au on au.id = ud.user_id
    where ud.data ? 'bancapro-transactions'
      and not exists(select 1 from public.banned_from_ranking_users b where b.email = lower(au.email))
      and not is_owner_email(au.email)
  ),
  computed as (
    select p.user_id, p.email, p.display_name,
      coalesce((
        select sum(case
          when (tx->>'type') = 'income'  then  (tx->>'value')::numeric
          when (tx->>'type') = 'expense' then -(tx->>'value')::numeric
          else 0 end)
        from jsonb_array_elements(p.txs) as tx
        where left(tx->>'date', 10) = v_today
          and (tx->>'created_at' is null or left(tx->>'created_at', 10) = v_today)
      ), 0) as profit,
      coalesce((
        select s.status in ('active','trialing')
        from public.subscribers s
        where lower(s.email) = lower(p.email) limit 1
      ), false) as is_pro
    from parsed p
  )
  select c.display_name, c.profit, c.is_pro
  from computed c
  where c.profit > 0
  order by c.profit desc limit 100;
end;
$$;

-- ════════════════════════════════════════════════════════════
-- 2. get_leaderboard_weekly
-- ════════════════════════════════════════════════════════════
create or replace function public.get_leaderboard_weekly()
returns table(display_name text, profit numeric, is_pro boolean)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_week_start text := to_char((now() at time zone 'America/Sao_Paulo')::date - interval '6 days', 'YYYY-MM-DD');
  v_today text := to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM-DD');
begin
  return query
  with parsed as (
    select
      ud.user_id, au.email,
      coalesce(nullif(ud.data->>'bancapro-display-name',''), split_part(au.email,'@',1)) as display_name,
      ((ud.data->>'bancapro-transactions'))::jsonb as txs
    from public.user_data ud
    join auth.users au on au.id = ud.user_id
    where ud.data ? 'bancapro-transactions'
      and not exists(select 1 from public.banned_from_ranking_users b where b.email = lower(au.email))
      and not is_owner_email(au.email)
  ),
  computed as (
    select p.user_id, p.email, p.display_name,
      coalesce((
        select sum(case
          when (tx->>'type') = 'income'  then  (tx->>'value')::numeric
          when (tx->>'type') = 'expense' then -(tx->>'value')::numeric
          else 0 end)
        from jsonb_array_elements(p.txs) as tx
        where left(tx->>'date', 10) between v_week_start and v_today
      ), 0) as profit,
      coalesce((
        select s.status in ('active','trialing')
        from public.subscribers s
        where lower(s.email) = lower(p.email) limit 1
      ), false) as is_pro
    from parsed p
  )
  select c.display_name, c.profit, c.is_pro
  from computed c
  where c.profit > 0
  order by c.profit desc limit 100;
end;
$$;

-- ════════════════════════════════════════════════════════════
-- 3. get_leaderboard_monthly
-- ════════════════════════════════════════════════════════════
create or replace function public.get_leaderboard_monthly()
returns table(display_name text, profit numeric, is_pro boolean)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_month text := to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM');
begin
  return query
  with parsed as (
    select
      ud.user_id, au.email,
      coalesce(nullif(ud.data->>'bancapro-display-name',''), split_part(au.email,'@',1)) as display_name,
      ((ud.data->>'bancapro-transactions'))::jsonb as txs
    from public.user_data ud
    join auth.users au on au.id = ud.user_id
    where ud.data ? 'bancapro-transactions'
      and not exists(select 1 from public.banned_from_ranking_users b where b.email = lower(au.email))
      and not is_owner_email(au.email)
  ),
  computed as (
    select p.user_id, p.email, p.display_name,
      coalesce((
        select sum(case
          when (tx->>'type') = 'income'  then  (tx->>'value')::numeric
          when (tx->>'type') = 'expense' then -(tx->>'value')::numeric
          else 0 end)
        from jsonb_array_elements(p.txs) as tx
        where left(tx->>'date', 7) = v_month
      ), 0) as profit,
      coalesce((
        select s.status in ('active','trialing')
        from public.subscribers s
        where lower(s.email) = lower(p.email) limit 1
      ), false) as is_pro
    from parsed p
  )
  select c.display_name, c.profit, c.is_pro
  from computed c
  where c.profit > 0
  order by c.profit desc limit 100;
end;
$$;

-- ════════════════════════════════════════════════════════════
-- 4. get_leaderboard (geral / all-time)
-- ════════════════════════════════════════════════════════════
create or replace function public.get_leaderboard()
returns table(display_name text, profit numeric, is_pro boolean)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  return query
  with parsed as (
    select
      ud.user_id, au.email,
      coalesce(nullif(ud.data->>'bancapro-display-name',''), split_part(au.email,'@',1)) as display_name,
      ((ud.data->>'bancapro-transactions'))::jsonb as txs
    from public.user_data ud
    join auth.users au on au.id = ud.user_id
    where ud.data ? 'bancapro-transactions'
      and not exists(select 1 from public.banned_from_ranking_users b where b.email = lower(au.email))
      and not is_owner_email(au.email)
  ),
  computed as (
    select p.user_id, p.email, p.display_name,
      coalesce((
        select sum(case
          when (tx->>'type') = 'income'  then  (tx->>'value')::numeric
          when (tx->>'type') = 'expense' then -(tx->>'value')::numeric
          else 0 end)
        from jsonb_array_elements(p.txs) as tx
      ), 0) as profit,
      coalesce((
        select s.status in ('active','trialing')
        from public.subscribers s
        where lower(s.email) = lower(p.email) limit 1
      ), false) as is_pro
    from parsed p
  )
  select c.display_name, c.profit, c.is_pro
  from computed c
  where c.profit > 0
  order by c.profit desc limit 100;
end;
$$;

-- Grants
grant execute on function public.get_leaderboard() to anon, authenticated;
grant execute on function public.get_leaderboard_today() to anon, authenticated;
grant execute on function public.get_leaderboard_weekly() to anon, authenticated;
grant execute on function public.get_leaderboard_monthly() to anon, authenticated;
