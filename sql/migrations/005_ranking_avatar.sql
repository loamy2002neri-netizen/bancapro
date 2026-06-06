-- ════════════════════════════════════════════════════════════
--  005_ranking_avatar.sql
--
--  Adiciona campo `avatar` (foto do usuario em data URL base64)
--  nos retornos das 4 RPCs de leaderboard.
--
--  Frontend usa pra renderizar IMG em vez de iniciais quando o user
--  tem foto cadastrada. Se nao tiver, retorna null e cai no fallback
--  de iniciais.
--
--  ATENCAO: muda assinatura de retorno — precisa DROP + CREATE.
-- ════════════════════════════════════════════════════════════

-- Drop tudo primeiro (mudou signature: adicionou avatar)
DROP FUNCTION IF EXISTS public.get_leaderboard();
DROP FUNCTION IF EXISTS public.get_leaderboard_today();
DROP FUNCTION IF EXISTS public.get_leaderboard_weekly();
DROP FUNCTION IF EXISTS public.get_leaderboard_monthly();

-- ── get_leaderboard (geral) ──
CREATE FUNCTION public.get_leaderboard()
RETURNS TABLE(display_name text, profit numeric, is_pro boolean, avatar text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  RETURN QUERY
  WITH parsed AS (
    SELECT
      ud.user_id, au.email,
      COALESCE(NULLIF(ud.data->>'bancapro-display-name',''), SPLIT_PART(au.email,'@',1)) AS display_name,
      ud.data->>'bancapro-avatar' AS avatar,
      ((ud.data->>'bancapro-transactions'))::jsonb AS txs
    FROM public.user_data ud
    JOIN auth.users au ON au.id = ud.user_id
    WHERE ud.data ? 'bancapro-transactions'
      AND NOT EXISTS(SELECT 1 FROM public.banned_from_ranking_users b WHERE b.email = LOWER(au.email))
      AND NOT is_owner_email(au.email)
  ),
  computed AS (
    SELECT p.user_id, p.email, p.display_name, p.avatar,
      COALESCE((
        SELECT SUM(CASE
          WHEN (tx->>'type') = 'income'  THEN  (tx->>'value')::numeric
          WHEN (tx->>'type') = 'expense' THEN -(tx->>'value')::numeric
          ELSE 0 END)
        FROM jsonb_array_elements(p.txs) AS tx
      ), 0) AS profit,
      COALESCE((
        SELECT s.status IN ('active','trialing')
        FROM public.subscribers s
        WHERE LOWER(s.email) = LOWER(p.email) LIMIT 1
      ), false) AS is_pro
    FROM parsed p
  )
  SELECT c.display_name, c.profit, c.is_pro, c.avatar
  FROM computed c
  WHERE c.profit > 0
  ORDER BY c.profit DESC LIMIT 100;
END;
$$;

-- ── get_leaderboard_today ──
CREATE FUNCTION public.get_leaderboard_today()
RETURNS TABLE(display_name text, profit numeric, is_pro boolean, avatar text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_today text := to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD');
BEGIN
  RETURN QUERY
  WITH parsed AS (
    SELECT
      ud.user_id, au.email,
      COALESCE(NULLIF(ud.data->>'bancapro-display-name',''), SPLIT_PART(au.email,'@',1)) AS display_name,
      ud.data->>'bancapro-avatar' AS avatar,
      ((ud.data->>'bancapro-transactions'))::jsonb AS txs
    FROM public.user_data ud
    JOIN auth.users au ON au.id = ud.user_id
    WHERE ud.data ? 'bancapro-transactions'
      AND NOT EXISTS(SELECT 1 FROM public.banned_from_ranking_users b WHERE b.email = LOWER(au.email))
      AND NOT is_owner_email(au.email)
  ),
  computed AS (
    SELECT p.user_id, p.email, p.display_name, p.avatar,
      COALESCE((
        SELECT SUM(CASE
          WHEN (tx->>'type') = 'income'  THEN  (tx->>'value')::numeric
          WHEN (tx->>'type') = 'expense' THEN -(tx->>'value')::numeric
          ELSE 0 END)
        FROM jsonb_array_elements(p.txs) AS tx
        WHERE LEFT(tx->>'date', 10) = v_today
          AND (tx->>'created_at' IS NULL OR LEFT(tx->>'created_at', 10) = v_today)
      ), 0) AS profit,
      COALESCE((
        SELECT s.status IN ('active','trialing')
        FROM public.subscribers s
        WHERE LOWER(s.email) = LOWER(p.email) LIMIT 1
      ), false) AS is_pro
    FROM parsed p
  )
  SELECT c.display_name, c.profit, c.is_pro, c.avatar
  FROM computed c
  WHERE c.profit > 0
  ORDER BY c.profit DESC LIMIT 100;
END;
$$;

-- ── get_leaderboard_weekly ──
CREATE FUNCTION public.get_leaderboard_weekly()
RETURNS TABLE(display_name text, profit numeric, is_pro boolean, avatar text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_week_start text := to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date - INTERVAL '6 days', 'YYYY-MM-DD');
  v_today text := to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD');
BEGIN
  RETURN QUERY
  WITH parsed AS (
    SELECT
      ud.user_id, au.email,
      COALESCE(NULLIF(ud.data->>'bancapro-display-name',''), SPLIT_PART(au.email,'@',1)) AS display_name,
      ud.data->>'bancapro-avatar' AS avatar,
      ((ud.data->>'bancapro-transactions'))::jsonb AS txs
    FROM public.user_data ud
    JOIN auth.users au ON au.id = ud.user_id
    WHERE ud.data ? 'bancapro-transactions'
      AND NOT EXISTS(SELECT 1 FROM public.banned_from_ranking_users b WHERE b.email = LOWER(au.email))
      AND NOT is_owner_email(au.email)
  ),
  computed AS (
    SELECT p.user_id, p.email, p.display_name, p.avatar,
      COALESCE((
        SELECT SUM(CASE
          WHEN (tx->>'type') = 'income'  THEN  (tx->>'value')::numeric
          WHEN (tx->>'type') = 'expense' THEN -(tx->>'value')::numeric
          ELSE 0 END)
        FROM jsonb_array_elements(p.txs) AS tx
        WHERE LEFT(tx->>'date', 10) BETWEEN v_week_start AND v_today
      ), 0) AS profit,
      COALESCE((
        SELECT s.status IN ('active','trialing')
        FROM public.subscribers s
        WHERE LOWER(s.email) = LOWER(p.email) LIMIT 1
      ), false) AS is_pro
    FROM parsed p
  )
  SELECT c.display_name, c.profit, c.is_pro, c.avatar
  FROM computed c
  WHERE c.profit > 0
  ORDER BY c.profit DESC LIMIT 100;
END;
$$;

-- ── get_leaderboard_monthly ──
CREATE FUNCTION public.get_leaderboard_monthly()
RETURNS TABLE(display_name text, profit numeric, is_pro boolean, avatar text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_month text := to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM');
BEGIN
  RETURN QUERY
  WITH parsed AS (
    SELECT
      ud.user_id, au.email,
      COALESCE(NULLIF(ud.data->>'bancapro-display-name',''), SPLIT_PART(au.email,'@',1)) AS display_name,
      ud.data->>'bancapro-avatar' AS avatar,
      ((ud.data->>'bancapro-transactions'))::jsonb AS txs
    FROM public.user_data ud
    JOIN auth.users au ON au.id = ud.user_id
    WHERE ud.data ? 'bancapro-transactions'
      AND NOT EXISTS(SELECT 1 FROM public.banned_from_ranking_users b WHERE b.email = LOWER(au.email))
      AND NOT is_owner_email(au.email)
  ),
  computed AS (
    SELECT p.user_id, p.email, p.display_name, p.avatar,
      COALESCE((
        SELECT SUM(CASE
          WHEN (tx->>'type') = 'income'  THEN  (tx->>'value')::numeric
          WHEN (tx->>'type') = 'expense' THEN -(tx->>'value')::numeric
          ELSE 0 END)
        FROM jsonb_array_elements(p.txs) AS tx
        WHERE LEFT(tx->>'date', 7) = v_month
      ), 0) AS profit,
      COALESCE((
        SELECT s.status IN ('active','trialing')
        FROM public.subscribers s
        WHERE LOWER(s.email) = LOWER(p.email) LIMIT 1
      ), false) AS is_pro
    FROM parsed p
  )
  SELECT c.display_name, c.profit, c.is_pro, c.avatar
  FROM computed c
  WHERE c.profit > 0
  ORDER BY c.profit DESC LIMIT 100;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_leaderboard() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_leaderboard_today() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_leaderboard_weekly() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_leaderboard_monthly() TO anon, authenticated;
