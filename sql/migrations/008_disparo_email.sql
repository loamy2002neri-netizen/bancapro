-- ════════════════════════════════════════════════════════════
--  008 — DISPARO DE E-MAIL PARA OS USUARIOS
--
--  Pedido (19/09/26): mandar comunicado pra base toda por e-mail.
--  O envio em si acontece na Edge Function "disparo-email" (Resend).
--  Aqui fica so o que o banco precisa saber: quem pediu pra NAO receber.
--
--  Por que descadastro importa: e-mail em massa sem saida vira denuncia de
--  spam, e denuncia queima o dominio — depois disso nem e-mail de senha
--  chega no cliente. O link de sair vai no rodape de todo disparo.
--
--  ATENCAO: desligue o Google Tradutor antes de colar no painel.
-- ════════════════════════════════════════════════════════════

create table if not exists public.email_optout (
  email     text primary key,
  motivo    text,
  criado_em timestamptz not null default now()
);

alter table public.email_optout enable row level security;
-- Sem policy: so a Edge Function (service role) le e escreve aqui.

-- Historico dos disparos, pra saber o que ja foi mandado e pra quem.
create table if not exists public.email_disparos (
  id          bigserial primary key,
  assunto     text not null,
  corpo       text not null,
  publico     text not null,
  enviados    int  not null default 0,
  falhas      int  not null default 0,
  disparado_por text,
  criado_em   timestamptz not null default now()
);

alter table public.email_disparos enable row level security;

-- Lista os ultimos disparos pro painel do dono (so owner enxerga)
create or replace function public.meus_disparos_email()
returns table(id bigint, assunto text, publico text, enviados int, falhas int, criado_em timestamptz)
language plpgsql security definer set search_path = public, auth as $fn$
declare v_eu text := public.quem_sou_eu();
begin
  if v_eu = '' or not public.is_owner_email(v_eu) then return; end if;
  return query
    select d.id, d.assunto, d.publico, d.enviados, d.falhas, d.criado_em
    from public.email_disparos d
    order by d.criado_em desc
    limit 20;
end;
$fn$;

grant execute on function public.meus_disparos_email() to authenticated;
