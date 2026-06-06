-- ════════════════════════════════════════════════════════════
--  FIX: Ranking HOJE — anti-backdate (defesa em camadas)
--  Bug: usuario adiciona transacao HOJE mas com data=ONTEM,
--       e isso aparecia no ranking de Hoje.
--  Fix: alem de filtrar por tx.date=today, agora tambem exige
--       que tx.created_at (carimbado no front) seja de hoje.
--       Transacoes legadas (sem created_at) caem no filtro antigo.
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
      ud.user_id,
      au.email,
      coalesce(nullif(ud.data->>'bancapro-display-name',''), split_part(au.email,'@',1)) as display_name,
      ((ud.data->>'bancapro-transactions'))::jsonb as txs
    from public.user_data ud
    join auth.users au on au.id = ud.user_id
    where ud.data ? 'bancapro-transactions'
      and not exists(select 1 from public.banned_from_ranking_users b where b.email = lower(au.email))
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
          -- Anti-backdate: se tx tem created_at, exige que tambem caia em HOJE.
          -- Sem created_at (transacoes legadas) cai no filtro antigo so de date.
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
