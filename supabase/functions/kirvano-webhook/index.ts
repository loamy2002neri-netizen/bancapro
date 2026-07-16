// Edge Function: kirvano-webhook
// Recebe o webhook do Kirvano e:
//   1. Marca o assinante como ativo/inativo na tabela "subscribers".
//   2. Gera/reverte comissoes de afiliados (30% comum, 50% VIP) com retencao de 7 dias.
// IMPORTANTE: ao criar no painel do Supabase, DESLIGUE "Verify JWT" (o Kirvano nao manda JWT).
//
// NOTA: esta e a copia versionada da funcao que roda em producao. A pasta supabase/
// esta no .gitignore, entao NAO sobe pro GitHub Pages — serve so de backup/referencia.
// Fonte da verdade e a funcao deployada no painel Supabase.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SECRET = "bancapro_whk_7Kq2mZ9xT4";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== SECRET) {
    return new Response("unauthorized", { status: 401 });
  }
  let body: any;
  try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
  console.log("Kirvano webhook recebido:", JSON.stringify(body));

  const email = String(body?.customer?.email || body?.email || "").toLowerCase().trim();
  const event = String(body?.event || "").toUpperCase();
  const plan = body?.plan?.name || body?.products?.[0]?.name || null;

  const paymentId = String(
    body?.sale?.id || body?.transaction_id || body?.id || body?.checkout_id || ""
  );
  const amount = Number(
    body?.sale?.value || body?.amount || body?.total || body?.plan?.value || 0
  );

  if (!email) return new Response("sem email", { status: 200 });

  let status: string | null = null;
  let isApproved = false;
  let isReverted = false;
  if (/APPROVED|RENEWED|PAID|COMPLETED/.test(event)) { status = "active"; isApproved = true; }
  // SO desativa em REVERSAO REAL DE DINHEIRO.
  // BUG CRITICO ANTERIOR: CANCEL e EXPIRED tambem desativavam. O Kirvano manda
  // esses eventos no FIM DO CICLO mensal (antes/junto da renovacao), entao
  // assinantes PAGANTES eram derrubados em lote na data de renovacao — varios
  // no mesmo segundo. Cliente pagava e via o paywall. Fim do ciclo != cancelamento.
  else if (/REFUND|CHARGEBACK|DISPUTE/.test(event)) { status = "inactive"; isReverted = true; }
  else {
    // Loga eventos nao tratados (inclui CANCEL/EXPIRED) pra a gente ver o nome
    // real nos logs e decidir com dado, sem derrubar ninguem.
    console.log("evento NAO desativa (apenas registrado):", event, "| email:", email);
    return new Response("evento ignorado: " + event, { status: 200 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ════════════════════════════════════════════════════
  // 1. SUBSCRIBERS (logica EXISTENTE - intocada)
  // ════════════════════════════════════════════════════
  const payload: Record<string, unknown> = { email, status, updated_at: new Date().toISOString() };
  if (plan) payload.plan = plan;
  // Assinatura recorrente NAO tem prazo manual. Ao ATIVAR, limpa valid_until
  // residual de liberacao antiga que bloqueava o pagante quando a data passava.
  if (status === "active") payload.valid_until = null;

  const { error } = await supabase.from("subscribers")
    .upsert(payload, { onConflict: "email" });
  if (error) { console.error("Erro DB:", error); return new Response("db error", { status: 500 }); }

  // ════════════════════════════════════════════════════
  // 2. AFILIADOS — 30% pra comum, 50% pra VIP
  // ════════════════════════════════════════════════════
  try {
    const { data: ref } = await supabase
      .from("referrals")
      .select("referrer_email")
      .eq("referred_email", email)
      .maybeSingle();

    if (ref?.referrer_email) {
      if (isApproved && paymentId && amount > 0) {
        // ─── PAGAMENTO APROVADO: cria comissao em retencao (7 dias) ───
        let percentage = 30; // comum 30% — VIP override pra 50% abaixo

        // VIP override (50%) — verifica tabela affiliates existente
        try {
          const { data: vip } = await supabase
            .from("affiliates")
            .select("commission")
            .eq("email", ref.referrer_email)
            .maybeSingle();
          if (vip?.commission) percentage = 50;
        } catch {}

        const commissionAmt = +(amount * percentage / 100).toFixed(2);
        const availableAt = new Date(Date.now() + 7 * 86400000);

        const { error: commErr } = await supabase
          .from("affiliate_commissions")
          .insert({
            affiliate_email: ref.referrer_email,
            referred_email: email,
            kirvano_payment_id: paymentId,
            payment_amount: amount,
            commission_percentage: percentage,
            commission_amount: commissionAmt,
            status: "pending",
            available_at: availableAt.toISOString(),
          });

        // 23505 = duplicate key (pagamento ja processado) — ignora
        if (commErr && commErr.code !== "23505") {
          console.error("Erro ao criar comissao:", commErr);
        } else {
          console.log(`Comissao criada: ${ref.referrer_email} ganha R$ ${commissionAmt} (${percentage}%)`);
        }

        await supabase
          .from("referrals")
          .update({ is_active_paid: true, converted_at: new Date().toISOString() })
          .eq("referred_email", email);

      } else if (isReverted) {
        // ─── REEMBOLSO/CHARGEBACK/CANCEL: reverte comissoes ainda nao pagas ───
        await supabase
          .from("affiliate_commissions")
          .update({ status: "reversed", reversed_at: new Date().toISOString() })
          .eq("referred_email", email)
          .eq("status", "pending");

        await supabase
          .from("referrals")
          .update({ is_active_paid: false })
          .eq("referred_email", email);

        console.log(`Comissao revertida pra ${ref.referrer_email} (indicado: ${email})`);
      }
    }
  } catch (affErr) {
    console.error("Erro afiliados (nao critico):", affErr);
  }

  return new Response("ok:" + status, { status: 200 });
});
