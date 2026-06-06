-- ════════════════════════════════════════════════════════════
--  FIX: Codigo de afiliado anonimo (refuser + UUID-suffix)
--
--  Antes: codigo derivado do email (LOAMYZZZ69) expunha quem indicou
--         -> muitos nao se cadastravam por reconhecer a pessoa.
--  Agora: codigo neutro "refuser" + ultimos 6 chars do user_id (UUID)
--         -> ex: refuser567890. Anonimo, deterministico, unico.
--
--  Esta migracao atualiza a RPC resolve_referral_code pra reconhecer
--  o novo formato e devolver o email do referrer.
-- ════════════════════════════════════════════════════════════

create or replace function public.resolve_referral_code(p_code text)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_code   text := lower(trim(coalesce(p_code, '')));
  v_suffix text;
  v_email  text;
begin
  if v_code = '' then return null; end if;

  -- Caso 1: codigo VIP (tabela affiliate_codes, case-insensitive)
  select lower(ac.email) into v_email
  from public.affiliate_codes ac
  where lower(ac.code) = v_code
  limit 1;

  if v_email is not null then
    return v_email;
  end if;

  -- Caso 2: novo formato anonimo "refuser" + ultimos 6 chars hex do user_id
  if v_code like 'refuser%' and length(v_code) = 13 then
    v_suffix := substring(v_code from 8 for 6); -- 6 chars depois de "refuser"
    select lower(au.email) into v_email
    from auth.users au
    where right(replace(au.id::text, '-', ''), 6) = v_suffix
    limit 1;
    if v_email is not null then
      return v_email;
    end if;
  end if;

  -- Caso 3 (legado): formato antigo UPPERCASE email-prefix (compat)
  -- Mantem por seguranca caso links antigos circulem
  select lower(au.email) into v_email
  from auth.users au
  where upper(regexp_replace(split_part(au.email, '@', 1), '[^a-zA-Z0-9]', '', 'g')) = upper(v_code)
  limit 1;

  return v_email; -- pode ser null se nao achar
end;
$$;

grant execute on function public.resolve_referral_code(text) to anon, authenticated;
