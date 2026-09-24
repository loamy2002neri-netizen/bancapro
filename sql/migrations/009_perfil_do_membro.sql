-- ════════════════════════════════════════════════════════════
--  009 — PERFIL DO MEMBRO NO RANKING DO GRUPO
--
--  Pedido (24/09/26): clicar na pessoa dentro do ranking do grupo e ver
--  as ultimas transacoes dela.
--
--  Decisoes:
--    • Quem enxerga: o dono do grupo e os colegas do MESMO grupo. Ninguem
--      de fora, nunca.
--    • So aparecem transacoes feitas A PARTIR da data em que a pessoa
--      entrou no grupo — o mesmo corte do lucro. Historico anterior e
--      vida pregressa dela e nao interessa ao grupo.
--    • O ranking passa a devolver um "membro_id" (hash do e-mail) em vez
--      de exigir o e-mail pra abrir o perfil. Assim um aluno consegue
--      abrir o perfil do colega SEM nunca receber o e-mail dele.
--
--  ATENCAO: desligue o Google Tradutor antes de colar no painel.
-- ════════════════════════════════════════════════════════════

-- ─── ranking_do_grupo ganha o membro_id ───
-- Mudar as colunas de retorno exige recriar a funcao (o Postgres nao deixa
-- trocar o tipo de retorno com "create or replace").
drop function if exists public.ranking_do_grupo(uuid);

create or replace function public.ranking_do_grupo(p_grupo_id uuid)
returns table(membro_id text, display_name text, email text, lucro numeric,
              entrou_em timestamptz, faixa_atingida numeric, premio_atingido text,
              proxima_faixa numeric)
language plpgsql security definer set search_path = public, auth as $fn$
declare
  v_eu    text := public.quem_sou_eu();
  v_edono boolean;
begin
  if v_eu = '' then return; end if;
  select (lower(g.dono_email) = v_eu) into v_edono
    from public.ranking_groups g where g.id = p_grupo_id;
  if v_edono is null then raise exception 'grupo nao encontrado'; end if;

  if not v_edono and not exists (select 1 from public.ranking_group_members m
                                 where m.grupo_id = p_grupo_id and lower(m.email) = v_eu) then
    raise exception 'sem acesso a esse grupo';
  end if;

  return query
  with base as (
    select
      m.email     as m_email,
      m.entrou_em as m_entrou,
      coalesce(nullif(ud.data->>'bancapro-display-name',''), split_part(m.email,'@',1)) as nome,
      coalesce((
        select sum(
          case when (tx->>'type') = 'income'  then  (tx->>'value')::numeric
               when (tx->>'type') = 'expense' then -(tx->>'value')::numeric
               else 0 end
        )
        from jsonb_array_elements(
               case when ud.data ? 'bancapro-transactions'
                    then (ud.data->>'bancapro-transactions')::jsonb
                    else '[]'::jsonb end) as tx
        where left(tx->>'date', 10) >=
              to_char(m.entrou_em at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')
      ), 0) as lucro_calc
    from public.ranking_group_members m
    left join auth.users au on lower(au.email) = lower(m.email)
    left join public.user_data ud on ud.user_id = au.id
    where m.grupo_id = p_grupo_id
  )
  select
    md5(lower(b.m_email)),
    b.nome,
    case when v_edono then b.m_email else null end,
    b.lucro_calc,
    b.m_entrou,
    (select max(t.meta) from public.ranking_group_tiers t
      where t.grupo_id = p_grupo_id and t.meta <= b.lucro_calc),
    (select t.premio from public.ranking_group_tiers t
      where t.grupo_id = p_grupo_id and t.meta <= b.lucro_calc
      order by t.meta desc limit 1),
    (select min(t.meta) from public.ranking_group_tiers t
      where t.grupo_id = p_grupo_id and t.meta > b.lucro_calc)
  from base b
  order by b.lucro_calc desc;
end;
$fn$;

grant execute on function public.ranking_do_grupo(uuid) to authenticated;

-- ─── Ultimas transacoes de um membro ───
create or replace function public.transacoes_do_membro(p_grupo_id uuid, p_membro_id text, p_limite int default 5)
returns table(quando text, descricao text, metodo text, tipo text, valor numeric)
language plpgsql security definer set search_path = public, auth as $fn$
declare
  v_eu     text := public.quem_sou_eu();
  v_alvo   text;
  v_entrou timestamptz;
  v_lim    int := least(greatest(coalesce(p_limite, 5), 1), 20);
begin
  if v_eu = '' then return; end if;

  -- quem pergunta precisa ser o dono OU membro do mesmo grupo
  if not exists (
       select 1 from public.ranking_groups g
        where g.id = p_grupo_id
          and (lower(g.dono_email) = v_eu
               or exists (select 1 from public.ranking_group_members m
                          where m.grupo_id = g.id and lower(m.email) = v_eu))
     ) then
    raise exception 'sem acesso a esse grupo';
  end if;

  -- e o alvo precisa ser membro DESSE grupo
  select lower(m.email), m.entrou_em into v_alvo, v_entrou
    from public.ranking_group_members m
   where m.grupo_id = p_grupo_id and md5(lower(m.email)) = p_membro_id;
  if v_alvo is null then return; end if;

  return query
  select
    left(tx->>'date', 10),
    nullif(btrim(coalesce(tx->>'desc', '')), ''),
    nullif(btrim(coalesce(tx->>'method', '')), ''),
    coalesce(tx->>'type', ''),
    coalesce((tx->>'value')::numeric, 0)
  from auth.users au
  join public.user_data ud on ud.user_id = au.id
  cross join lateral jsonb_array_elements(
    case when ud.data ? 'bancapro-transactions'
         then (ud.data->>'bancapro-transactions')::jsonb
         else '[]'::jsonb end) as tx
  where lower(au.email) = v_alvo
    and left(tx->>'date', 10) >= to_char(v_entrou at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')
  order by coalesce(tx->>'created_at', tx->>'date') desc
  limit v_lim;
end;
$fn$;

grant execute on function public.transacoes_do_membro(uuid, text, int) to authenticated;
