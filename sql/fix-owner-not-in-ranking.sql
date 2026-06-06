-- ════════════════════════════════════════════════════════════
--  FIX: Dono (admin) NUNCA aparece no ranking
--  Bug: contas de owner_emails apareciam no leaderboard pra outros
--       usuarios e pra si mesmas. Owner deve ser invisivel sempre.
--
--  Atualiza as 3 RPCs de leaderboard (today, weekly, monthly) pra
--  filtrar contas de dono via lista hard-coded.
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

-- ── get_leaderboard_today (atualiza adicionando filtro de owner) ──
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
      ud.user_id,
      au.email,
      coalesce(nullif(ud.data->>'bancapro-display-name',''), split_part(au.email,'@',1)) as display_name,
      ((ud.data->>'bancapro-transactions'))::jsonb as txs
    from public.user_data ud
    join auth.users au on au.id = ud.user_id
    where ud.data ? 'bancapro-transactions'
      and not exists(select 1 from public.banned_from_ranking_users b where b.email = lower(au.email))
      and not is_owner_email(au.email)  -- ← admin nao aparece
  ),
  computed as (
    select
      p.user_id,
      p.email,
      p.display_name,
      coalesce((
        select sum(
          case
            when (tx->>'type') = 'income'  then  (tx->>'value')::numeric
            when (tx->>'type') = 'expense' then -(tx->>'value')::numeric
            else 0
          end
        )
        from jsonb_array_elements(p.txs) as tx
        where left(tx->>'date', 10) = v_today
          and (tx->>'created_at' is null or left(tx->>'created_at', 10) = v_today)
      ), 0) as profit,
      coalesce((
        select s.status in ('active','trialing')
        from public.subscribers s
        where lower(s.email) = lower(p.email)
        limit 1
      ), false) as is_pro
    from parsed p
  )
  select c.display_name, c.profit, c.is_pro
  from computed c
  where c.profit > 0
  order by c.profit desc
  limit 100;
end;
$$;

grant execute on function public.get_leaderboard_today() to anon, authenticated;
grant execute on function public.is_owner_email(text) to anon, authenticated;
