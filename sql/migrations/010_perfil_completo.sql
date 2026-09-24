-- ════════════════════════════════════════════════════════════
--  010 — CARD DE PERFIL COMPLETO NO RANKING DO GRUPO
--
--  Pedido (24/09/26): o perfil tem que mostrar foto, quanto a pessoa
--  lucrou, e o comprovante da transacao quando ela anexou um.
--  EXPRESSAMENTE FORA: o valor da banca. Quanto a pessoa tem guardado
--  nao e da conta do grupo — so o resultado que ela faz.
--
--  Cuidado de peso: comprovante e foto sao base64 (imagem inteira dentro
--  do texto). Mandar isso pra lista toda deixaria o app arrastando, entao:
--    • a lista de transacoes devolve so um SINALIZADOR de que tem anexo
--    • a imagem em si so viaja quando alguem clica pra ver, uma por vez
--
--  ATENCAO: desligue o Google Tradutor antes de colar no painel.
-- ════════════════════════════════════════════════════════════

-- ─── Card do perfil (sem banca, de proposito) ───
create or replace function public.perfil_do_membro(p_grupo_id uuid, p_membro_id text)
returns table(display_name text, avatar text, lucro numeric, entrou_em timestamptz,
              faixa_atingida numeric, premio_atingido text, proxima_faixa numeric,
              qtd_transacoes int)
language plpgsql security definer set search_path = public, auth as $fn$
declare
  v_eu     text := public.quem_sou_eu();
  v_alvo   text;
  v_entrou timestamptz;
begin
  if v_eu = '' then return; end if;

  -- quem pergunta precisa ser dono OU membro do mesmo grupo
  if not exists (
       select 1 from public.ranking_groups g
        where g.id = p_grupo_id
          and (lower(g.dono_email) = v_eu
               or exists (select 1 from public.ranking_group_members m
                          where m.grupo_id = g.id and lower(m.email) = v_eu))
     ) then
    raise exception 'sem acesso a esse grupo';
  end if;

  select lower(m.email), m.entrou_em into v_alvo, v_entrou
    from public.ranking_group_members m
   where m.grupo_id = p_grupo_id and md5(lower(m.email)) = p_membro_id;
  if v_alvo is null then return; end if;

  return query
  with dados as (
    select
      coalesce(nullif(ud.data->>'bancapro-display-name',''), split_part(v_alvo,'@',1)) as nome,
      nullif(ud.data->>'bancapro-avatar','') as foto,
      case when ud.data ? 'bancapro-transactions'
           then (ud.data->>'bancapro-transactions')::jsonb
           else '[]'::jsonb end as txs
    from auth.users au
    join public.user_data ud on ud.user_id = au.id
    where lower(au.email) = v_alvo
  ),
  conta as (
    select
      d.nome, d.foto,
      coalesce((
        select sum(case when (tx->>'type') = 'income'  then  (tx->>'value')::numeric
                        when (tx->>'type') = 'expense' then -(tx->>'value')::numeric
                        else 0 end)
        from jsonb_array_elements(d.txs) tx
        where left(tx->>'date', 10) >= to_char(v_entrou at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')
      ), 0) as lucro_calc,
      coalesce((
        select count(*)::int from jsonb_array_elements(d.txs) tx
        where left(tx->>'date', 10) >= to_char(v_entrou at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')
      ), 0) as qtd
    from dados d
  )
  select
    c.nome, c.foto, c.lucro_calc, v_entrou,
    (select max(t.meta) from public.ranking_group_tiers t
      where t.grupo_id = p_grupo_id and t.meta <= c.lucro_calc),
    (select t.premio from public.ranking_group_tiers t
      where t.grupo_id = p_grupo_id and t.meta <= c.lucro_calc
      order by t.meta desc limit 1),
    (select min(t.meta) from public.ranking_group_tiers t
      where t.grupo_id = p_grupo_id and t.meta > c.lucro_calc),
    c.qtd
  from conta c;
end;
$fn$;

grant execute on function public.perfil_do_membro(uuid, text) to authenticated;

-- ─── Transacoes agora dizem se TEM comprovante (sem mandar a imagem) ───
drop function if exists public.transacoes_do_membro(uuid, text, int);

create or replace function public.transacoes_do_membro(p_grupo_id uuid, p_membro_id text, p_limite int default 5)
returns table(tx_id text, quando text, descricao text, metodo text, tipo text,
              valor numeric, tem_comprovante boolean)
language plpgsql security definer set search_path = public, auth as $fn$
declare
  v_eu     text := public.quem_sou_eu();
  v_alvo   text;
  v_entrou timestamptz;
  v_lim    int := least(greatest(coalesce(p_limite, 5), 1), 20);
begin
  if v_eu = '' then return; end if;

  if not exists (
       select 1 from public.ranking_groups g
        where g.id = p_grupo_id
          and (lower(g.dono_email) = v_eu
               or exists (select 1 from public.ranking_group_members m
                          where m.grupo_id = g.id and lower(m.email) = v_eu))
     ) then
    raise exception 'sem acesso a esse grupo';
  end if;

  select lower(m.email), m.entrou_em into v_alvo, v_entrou
    from public.ranking_group_members m
   where m.grupo_id = p_grupo_id and md5(lower(m.email)) = p_membro_id;
  if v_alvo is null then return; end if;

  return query
  select
    coalesce(tx->>'id', ''),
    left(tx->>'date', 10),
    nullif(btrim(coalesce(tx->>'desc', '')), ''),
    nullif(btrim(coalesce(tx->>'method', '')), ''),
    coalesce(tx->>'type', ''),
    coalesce((tx->>'value')::numeric, 0),
    (coalesce(length(tx->>'attachment'), 0) > 20)
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

-- ─── A imagem do comprovante, uma por vez ───
create or replace function public.comprovante_do_membro(p_grupo_id uuid, p_membro_id text, p_tx_id text)
returns text
language plpgsql security definer set search_path = public, auth as $fn$
declare
  v_eu     text := public.quem_sou_eu();
  v_alvo   text;
  v_entrou timestamptz;
  v_img    text;
begin
  if v_eu = '' then return null; end if;

  if not exists (
       select 1 from public.ranking_groups g
        where g.id = p_grupo_id
          and (lower(g.dono_email) = v_eu
               or exists (select 1 from public.ranking_group_members m
                          where m.grupo_id = g.id and lower(m.email) = v_eu))
     ) then
    raise exception 'sem acesso a esse grupo';
  end if;

  select lower(m.email), m.entrou_em into v_alvo, v_entrou
    from public.ranking_group_members m
   where m.grupo_id = p_grupo_id and md5(lower(m.email)) = p_membro_id;
  if v_alvo is null then return null; end if;

  select tx->>'attachment' into v_img
  from auth.users au
  join public.user_data ud on ud.user_id = au.id
  cross join lateral jsonb_array_elements(
    case when ud.data ? 'bancapro-transactions'
         then (ud.data->>'bancapro-transactions')::jsonb
         else '[]'::jsonb end) as tx
  where lower(au.email) = v_alvo
    and coalesce(tx->>'id', '') = p_tx_id
    -- mesmo corte das outras: comprovante de antes de entrar no grupo nao abre
    and left(tx->>'date', 10) >= to_char(v_entrou at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')
  limit 1;

  return v_img;
end;
$fn$;

grant execute on function public.comprovante_do_membro(uuid, text, text) to authenticated;
