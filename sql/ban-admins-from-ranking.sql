-- ════════════════════════════════════════════════════════════
--  FIX DEFINITIVO: bana os admins na tabela banned_from_ranking_users
--  Isso eh independente das RPCs — qualquer RPC que use o filtro
--  `not exists (select 1 from banned_from_ranking_users ...)` ja
--  vai bloquear admin automaticamente.
--
--  Usa ON CONFLICT pra ser idempotente (pode rodar varias vezes
--  sem dar erro).
-- ════════════════════════════════════════════════════════════

INSERT INTO public.banned_from_ranking_users (email, reason)
VALUES
  ('loamy2002neri@gmail.com', 'owner'),
  ('loamy69zzz@gmail.com',    'owner')
ON CONFLICT (email) DO UPDATE SET reason = excluded.reason;

-- Verifica resultado
SELECT email, reason, created_at
FROM public.banned_from_ranking_users
WHERE reason = 'owner';
