-- ════════════════════════════════════════════════════════════
--  007 — RANKING DE GRUPOS (donos de comunidade x alunos)
--
--  Pedido (18/09/26): donos de grupo querem acompanhar o lucro dos
--  alunos deles e premiar por faixa (10k, 50k, 100k...) com pulseira,
--  placa, brinde.
--
--  Regras decididas com o dono do Apostack:
--    • Metrica = LUCRO ACUMULADO (entradas - saidas), contado a partir
--      da data em que o aluno ENTROU no grupo.
--    • Cada dono define as proprias faixas de premiacao.
--    • O dono CRIA o grupo sozinho pelo app.
--    • Sobre os alunos o dono so OBSERVA: nao remove, nao edita nada.
--
--  Acesso: as tabelas ficam fechadas (RLS sem policy). Tudo passa pelas
--  funcoes security definer abaixo, que conferem quem esta chamando.
--
--  ATENCAO: desligue o Google Tradutor antes de colar no painel.
-- ════════════════════════════════════════════════════════════

-- ─────────────────────────── TABELAS ───────────────────────────
create table if not exists public.ranking_groups (
  id         uuid primary key default gen_random_uuid(),
  nome       text        not null,
  dono_email text        not null,
  codigo     text        not null unique,
  criado_em  timestamptz not null default now()
);
create index if not exists ranking_groups_dono_idx on public.ranking_groups (lower(dono_email));

create table if not exists public.ranking_group_members (
  grupo_id  uuid        not null references public.ranking_groups(id) on delete cascade,
  email     text        not null,
  entrou_em timestamptz not null default now(),
  primary key (grupo_id, email)
);
create index if not exists ranking_group_members_email_idx on public.ranking_group_members (lower(email));

create table if not exists public.ranking_group_tiers (
  id       bigserial primary key,
  grupo_id uuid    not null references public.ranking_groups(id) on delete cascade,
  meta     numeric not null check (meta > 0),
  premio   text    not null,
  unique (grupo_id, meta)
);

alter table public.ranking_groups        enable row level security;
alter table public.ranking_group_members enable row level security;
alter table public.ranking_group_tiers   enable row level security;
-- Sem policy de proposito: acesso direto negado, so pelas funcoes abaixo.

-- ─────────────────────────── HELPERS ───────────────────────────
create or replace function public.quem_sou_eu()
returns text language sql stable as $fn$
  select lower(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', ''));
$fn$;

-- Gera codigo curto e unico pro grupo (sem 0/O/1/I pra nao confundir).
create or replace function public.gera_codigo_grupo()
returns text language plpgsql as $fn$
declare
  v_alfabeto text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_cod text;
  i int;
begin
  loop
    v_cod := '';
    for i in 1..6 loop
      v_cod := v_cod || substr(v_alfabeto, 1 + floor(random() * length(v_alfabeto))::int, 1);
    end loop;
    exit when not exists (select 1 from public.ranking_groups g where g.codigo = v_cod);
  end loop;
  return v_cod;
end;
$fn$;

-- ─────────────────────── CRIAR / LISTAR GRUPO ───────────────────────
create or replace function public.criar_grupo_ranking(p_nome text)
returns table(id uuid, nome text, codigo text)
language plpgsql security definer set search_path = public, auth as $fn$
declare
  v_eu   text := public.quem_sou_eu();
  v_nome text := btrim(coalesce(p_nome, ''));
  v_id   uuid;
  v_cod  text;
begin
  if v_eu = '' then raise exception 'precisa estar logado'; end if;
  if v_nome = '' then raise exception 'o grupo precisa de um nome'; end if;
  if length(v_nome) > 60 then v_nome := left(v_nome, 60); end if;
  -- teto pra nao virar bagunca: 5 grupos por dono
  if (select count(*) from public.ranking_groups g where lower(g.dono_email) = v_eu) >= 5 then
    raise exception 'limite de 5 grupos por conta';
  end if;

  v_cod := public.gera_codigo_grupo();
  insert into public.ranking_groups (nome, dono_email, codigo)
  values (v_nome, v_eu, v_cod)
  returning ranking_groups.id into v_id;

  return query select v_id, v_nome, v_cod;
end;
$fn$;

create or replace function public.meus_grupos_ranking()
returns table(id uuid, nome text, codigo text, membros bigint, criado_em timestamptz)
language plpgsql security definer set search_path = public, auth as $fn$
declare v_eu text := public.quem_sou_eu();
begin
  if v_eu = '' then return; end if;
  return query
    select g.id, g.nome, g.codigo,
           (select count(*) from public.ranking_group_members m where m.grupo_id = g.id),
           g.criado_em
    from public.ranking_groups g
    where lower(g.dono_email) = v_eu
    order by g.criado_em;
end;
$fn$;

-- ─────────────────────────── FAIXAS ───────────────────────────
-- p_faixas: [{"meta":10000,"premio":"Pulseira"}, {"meta":50000,"premio":"Placa"}]
create or replace function public.definir_faixas_grupo(p_grupo_id uuid, p_faixas jsonb)
returns void
language plpgsql security definer set search_path = public, auth as $fn$
declare v_eu text := public.quem_sou_eu();
begin
  if not exists (select 1 from public.ranking_groups g
                 where g.id = p_grupo_id and lower(g.dono_email) = v_eu) then
    raise exception 'esse grupo nao e seu';
  end if;
  if jsonb_typeof(p_faixas) <> 'array' then raise exception 'faixas invalidas'; end if;
  if jsonb_array_length(p_faixas) > 12 then raise exception 'maximo de 12 faixas'; end if;

  delete from public.ranking_group_tiers t where t.grupo_id = p_grupo_id;
  insert into public.ranking_group_tiers (grupo_id, meta, premio)
  select p_grupo_id,
         (f->>'meta')::numeric,
         left(btrim(coalesce(f->>'premio', 'Premio')), 60)
  from jsonb_array_elements(p_faixas) f
  where (f->>'meta') ~ '^[0-9]+(\.[0-9]+)?$' and (f->>'meta')::numeric > 0
  on conflict (grupo_id, meta) do nothing;
end;
$fn$;

create or replace function public.faixas_do_grupo(p_grupo_id uuid)
returns table(meta numeric, premio text)
language plpgsql security definer set search_path = public, auth as $fn$
declare v_eu text := public.quem_sou_eu();
begin
  if v_eu = '' then return; end if;
  if not exists (
       select 1 from public.ranking_groups g where g.id = p_grupo_id
         and (lower(g.dono_email) = v_eu
              or exists (select 1 from public.ranking_group_members m
                         where m.grupo_id = g.id and lower(m.email) = v_eu))
     ) then
    raise exception 'sem acesso a esse grupo';
  end if;
  return query select t.meta, t.premio from public.ranking_group_tiers t
               where t.grupo_id = p_grupo_id order by t.meta;
end;
$fn$;

-- ───────────────────── ENTRAR NO GRUPO (ALUNO) ─────────────────────
create or replace function public.entrar_no_grupo_ranking(p_codigo text)
returns table(grupo_id uuid, nome text)
language plpgsql security definer set search_path = public, auth as $fn$
declare
  v_eu  text := public.quem_sou_eu();
  v_cod text := upper(btrim(coalesce(p_codigo, '')));
  v_id   uuid;
  v_nome text;
  v_dono text;
begin
  if v_eu = '' then raise exception 'precisa estar logado'; end if;
  select g.id, g.nome, g.dono_email into v_id, v_nome, v_dono
    from public.ranking_groups g where g.codigo = v_cod;
  if v_id is null then raise exception 'codigo nao encontrado'; end if;
  if lower(v_dono) = v_eu then raise exception 'voce e o dono desse grupo'; end if;

  insert into public.ranking_group_members (grupo_id, email) values (v_id, v_eu)
  on conflict (grupo_id, email) do nothing;

  return query select v_id, v_nome;
end;
$fn$;

create or replace function public.grupos_que_participo()
returns table(id uuid, nome text, entrou_em timestamptz)
language plpgsql security definer set search_path = public, auth as $fn$
declare v_eu text := public.quem_sou_eu();
begin
  if v_eu = '' then return; end if;
  return query
    select g.id, g.nome, m.entrou_em
    from public.ranking_group_members m
    join public.ranking_groups g on g.id = m.grupo_id
    where lower(m.email) = v_eu
    order by m.entrou_em;
end;
$fn$;

create or replace function public.sair_do_grupo_ranking(p_grupo_id uuid)
returns void
language plpgsql security definer set search_path = public, auth as $fn$
declare v_eu text := public.quem_sou_eu();
begin
  if v_eu = '' then raise exception 'precisa estar logado'; end if;
  -- o ALUNO sai por vontade propria; o dono nao remove ninguem (decisao do produto)
  delete from public.ranking_group_members m
   where m.grupo_id = p_grupo_id and lower(m.email) = v_eu;
end;
$fn$;

-- ───────────────────────── RANKING DO GRUPO ─────────────────────────
-- Lucro acumulado de cada aluno a partir da data em que entrou no grupo.
-- O email so volta preenchido pro DONO (ele precisa identificar quem premiar);
-- pros alunos volta null, aparece so o nome de exibicao.
create or replace function public.ranking_do_grupo(p_grupo_id uuid)
returns table(display_name text, email text, lucro numeric, entrou_em timestamptz,
              faixa_atingida numeric, premio_atingido text, proxima_faixa numeric)
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
               -- aluno sem transacoes salvas: vira lista vazia em vez de
               -- estourar erro de cast e derrubar o ranking inteiro
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

-- ─────────────────────────── PERMISSOES ───────────────────────────
revoke all on function public.criar_grupo_ranking(text)            from public;
revoke all on function public.definir_faixas_grupo(uuid, jsonb)    from public;
revoke all on function public.entrar_no_grupo_ranking(text)        from public;
revoke all on function public.ranking_do_grupo(uuid)               from public;

grant execute on function public.quem_sou_eu()                     to authenticated;
grant execute on function public.criar_grupo_ranking(text)         to authenticated;
grant execute on function public.meus_grupos_ranking()             to authenticated;
grant execute on function public.definir_faixas_grupo(uuid, jsonb) to authenticated;
grant execute on function public.faixas_do_grupo(uuid)             to authenticated;
grant execute on function public.entrar_no_grupo_ranking(text)     to authenticated;
grant execute on function public.grupos_que_participo()            to authenticated;
grant execute on function public.sair_do_grupo_ranking(uuid)       to authenticated;
grant execute on function public.ranking_do_grupo(uuid)            to authenticated;

-- ─── Apagar um grupo (so o dono) ───
-- Faltava na primeira versao: grupo criado por engano ficava preso pra sempre
-- e ainda ocupava uma das 5 vagas. O cascade leva membros e faixas junto.
create or replace function public.excluir_grupo_ranking(p_grupo_id uuid)
returns void
language plpgsql security definer set search_path = public, auth as $fn$
declare v_eu text := public.quem_sou_eu();
begin
  if v_eu = '' then raise exception 'precisa estar logado'; end if;
  delete from public.ranking_groups g
   where g.id = p_grupo_id and lower(g.dono_email) = v_eu;
end;
$fn$;

grant execute on function public.excluir_grupo_ranking(uuid) to authenticated;

-- ─── Criar grupo vira beneficio de AFILIADO (18/09/26) ───
-- Quem monta ranking de comunidade e parceiro cadastrado, nao qualquer
-- usuario. A tela esconde o card, mas quem barra de verdade e isto aqui.
-- O dono do Apostack (is_owner_email) passa sempre.
create or replace function public.criar_grupo_ranking(p_nome text)
returns table(id uuid, nome text, codigo text)
language plpgsql security definer set search_path = public, auth as $fn$
declare
  v_eu   text := public.quem_sou_eu();
  v_nome text := btrim(coalesce(p_nome, ''));
  v_id   uuid;
  v_cod  text;
begin
  if v_eu = '' then raise exception 'precisa estar logado'; end if;

  if not (public.is_owner_email(v_eu)
          or exists (select 1 from public.affiliates a where lower(a.email) = v_eu)) then
    raise exception 'so afiliado cria grupo';
  end if;

  if v_nome = '' then raise exception 'o grupo precisa de um nome'; end if;
  if length(v_nome) > 60 then v_nome := left(v_nome, 60); end if;
  if (select count(*) from public.ranking_groups g where lower(g.dono_email) = v_eu) >= 5 then
    raise exception 'limite de 5 grupos por conta';
  end if;

  v_cod := public.gera_codigo_grupo();
  insert into public.ranking_groups (nome, dono_email, codigo)
  values (v_nome, v_eu, v_cod)
  returning ranking_groups.id into v_id;

  return query select v_id, v_nome, v_cod;
end;
$fn$;

-- ─── FIX 18/09/26: "column reference grupo_id is ambiguous" ───
-- A funcao devolve uma coluna chamada grupo_id (RETURNS TABLE) e a tabela
-- ranking_group_members tambem tem grupo_id. No "on conflict (grupo_id, email)"
-- o Postgres nao sabia a qual das duas o nome se referia e quebrava na hora
-- de entrar no grupo. Solucao: apontar o conflito pelo NOME DA CHAVE em vez
-- de listar colunas — sem ambiguidade e sem mudar a assinatura da funcao
-- (o app continua lendo .nome normalmente).
create or replace function public.entrar_no_grupo_ranking(p_codigo text)
returns table(grupo_id uuid, nome text)
language plpgsql security definer set search_path = public, auth as $fn$
declare
  v_eu   text := public.quem_sou_eu();
  v_cod  text := upper(btrim(coalesce(p_codigo, '')));
  v_id   uuid;
  v_nome text;
  v_dono text;
begin
  if v_eu = '' then raise exception 'precisa estar logado'; end if;
  select g.id, g.nome, g.dono_email into v_id, v_nome, v_dono
    from public.ranking_groups g where g.codigo = v_cod;
  if v_id is null then raise exception 'codigo nao encontrado'; end if;
  if lower(v_dono) = v_eu then raise exception 'voce e o dono desse grupo'; end if;

  insert into public.ranking_group_members (grupo_id, email)
  values (v_id, v_eu)
  on conflict on constraint ranking_group_members_pkey do nothing;

  return query select v_id, v_nome;
end;
$fn$;

-- ─── Entrada automatica no grupo de quem indicou (18/09/26) ───
-- Pedido dos afiliados: quem se cadastra pelo link deles tem que cair no
-- ranking deles sem digitar codigo. O vinculo ja existe na tabela referrals;
-- aqui a gente so pega o grupo mais antigo do indicador e insere a pessoa.
-- Idempotente: pode rodar em todo login sem duplicar.
create or replace function public.entrar_no_grupo_do_indicador()
returns table(grupo_id uuid, nome text)
language plpgsql security definer set search_path = public, auth as $fn$
declare
  v_eu   text := public.quem_sou_eu();
  v_dono text;
  v_id   uuid;
  v_nome text;
begin
  if v_eu = '' then return; end if;
  select lower(r.referrer_email) into v_dono
    from public.referrals r
   where lower(r.referred_email) = v_eu and r.referrer_email is not null
   limit 1;
  if v_dono is null or v_dono = v_eu then return; end if;

  select g.id, g.nome into v_id, v_nome
    from public.ranking_groups g
   where lower(g.dono_email) = v_dono
   order by g.criado_em
   limit 1;
  if v_id is null then return; end if;

  insert into public.ranking_group_members (grupo_id, email)
  values (v_id, v_eu)
  on conflict on constraint ranking_group_members_pkey do nothing;

  return query select v_id, v_nome;
end;
$fn$;

grant execute on function public.entrar_no_grupo_do_indicador() to authenticated;
