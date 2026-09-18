-- ═══════════════════════════════════════════════════════════════
--  006 — DA PRAZO AOS ACESSOS QUE ESTAVAM SEM PRAZO
--
--  Contexto: o webhook gravava valid_until = null ao aprovar pagamento.
--  Com CANCEL/EXPIRED nao desativando mais ninguem (correcao de 20/07),
--  quem pagou uma vez ficava 'active' pra sempre. Este script aplica a
--  regra do negocio nas linhas antigas: acesso vale ate o fim do ciclo
--  pago (+3 dias de folga). Quem nao pagou o ciclo seguinte, bloqueia.
--
--  Ciclo pelo nome do plano:
--    Plano Semanal ....... 7 dias
--    Demais (mensal) .... 30 dias
--    Liberado manualmente  NAO MEXE — e cortesia, o dono decide
--
--  ATENCAO: desligue o Google Tradutor antes de colar.
-- ═══════════════════════════════════════════════════════════════

-- ─── PASSO 1: PREVIA (so leitura, nao altera nada) ───
-- Rode primeiro e confira a coluna "resultado" antes de aplicar.
select
  email,
  plan,
  updated_at::date                 as ultimo_pagamento,
  (now()::date - updated_at::date) as dias_sem_pagar,
  case
    when plan ilike '%manual%' then 'CORTESIA — nao sera tocado'
    when updated_at + (case when plan ilike '%semanal%'
                            then interval '10 days'
                            else interval '33 days' end) > now()
      then 'CONTINUA COM ACESSO'
    else 'VAI SER BLOQUEADO'
  end                              as resultado
from public.subscribers
where status = 'active' and valid_until is null
order by updated_at desc;


-- ─── PASSO 2: APLICAR (so depois de conferir a previa) ───
-- Nao mexe em cortesia (Liberado manualmente) nem em quem ja tem prazo.
-- update public.subscribers
-- set valid_until = updated_at + (case when plan ilike '%semanal%'
--                                      then interval '10 days'
--                                      else interval '33 days' end)
-- where status = 'active'
--   and valid_until is null
--   and coalesce(plan, '') not ilike '%manual%';


-- ─── CONFERENCIA depois de aplicar ───
-- select count(*) filter (where valid_until > now()) as ainda_com_acesso,
--        count(*) filter (where valid_until <= now()) as bloqueados,
--        count(*) filter (where valid_until is null)  as cortesia
-- from public.subscribers where status = 'active';
