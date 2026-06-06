-- ════════════════════════════════════════════════════════════
--  DIAGNOSTICO: verificar se os admins estao realmente banidos
-- ════════════════════════════════════════════════════════════

-- 1) Lista quem está banido (deve mostrar os 2 admins)
SELECT *
FROM public.banned_from_ranking_users
ORDER BY email;

-- 2) Lista emails reais dos admins no auth.users
SELECT id, email, raw_user_meta_data->>'name' as nome_metadata
FROM auth.users
WHERE email ILIKE '%loamy%' OR email ILIKE '%apostack%'
ORDER BY email;

-- 3) Lista display_names usados nos user_data dos admins
SELECT au.email,
       ud.data->>'bancapro-display-name' as display_name_atual
FROM public.user_data ud
JOIN auth.users au ON au.id = ud.user_id
WHERE au.email ILIKE '%loamy%' OR au.email ILIKE '%apostack%'
ORDER BY au.email;

-- 4) Testa a funcao is_owner_email()
SELECT 'loamy2002neri@gmail.com' as email,
       is_owner_email('loamy2002neri@gmail.com') as eh_owner
UNION ALL
SELECT 'loamy69zzz@gmail.com',
       is_owner_email('loamy69zzz@gmail.com');
