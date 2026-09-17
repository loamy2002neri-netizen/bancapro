-- ═══════════════════════════════════════════════════════════════
--  DIAGNOSTICO — quem esta acessando de graca
--  SO LEITURA. Nao altera nada. Rodar no Supabase > SQL Editor.
--  ATENCAO: desligue o Google Tradutor antes de colar.
-- ═══════════════════════════════════════════════════════════════

-- 1) Resumo
select
  count(*) filter (where status = 'active')                              as ativos,
  count(*) filter (where status = 'active' and valid_until is null)      as ativos_sem_prazo,
  count(*) filter (where status = 'active' and valid_until is null
                   and updated_at < now() - interval '37 days')          as parados_ha_mais_de_37_dias
from public.subscribers;

-- 2) Lista: ativos sem prazo, do mais antigo pro mais novo.
--    A coluna dias_desde_ultimo_evento e a chave da leitura:
--      • se HOUVER gente com 60, 90, 120 dias -> sao os que usam de graca
--      • se TODO MUNDO estiver com muitos dias -> o Kirvano NAO esta mandando
--        os eventos de renovacao, e a correcao automatica bloquearia pagante
select
  email,
  plan,
  updated_at::date                        as ultimo_evento,
  (now()::date - updated_at::date)        as dias_desde_ultimo_evento
from public.subscribers
where status = 'active' and valid_until is null
order by updated_at asc;
