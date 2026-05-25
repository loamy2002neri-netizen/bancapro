// ─────────────────────────────────────────────
//  Configuração do banco de dados (OPCIONAL)
//
//  • Se você DEIXAR como está (com COLE_...), o app funciona em
//    modo LOCAL: contas e dados ficam salvos no próprio navegador.
//
//  • Se você COLAR as 2 chaves do Supabase abaixo, o app passa a
//    usar o banco na NUVEM (sincroniza login entre aparelhos).
//    Pegue os valores em: Project Settings → API
//    (a chave "anon public" pode ficar aqui — é pública por design;
//     a segurança vem das regras RLS no banco.)
// ─────────────────────────────────────────────
window.SUPABASE_URL = 'https://jmkshpqarmctbchoxadu.supabase.co';
window.SUPABASE_ANON_KEY = 'sb_publishable_mpvpadpbWZv0i040jDP09Q_gnyYn01p';

// ─────────────────────────────────────────────
//  Checkout das assinaturas (Kirvano)
//  Cole aqui os links de checkout das ofertas criadas no Kirvano.
//  Enquanto estiver com "COLE_...", o botão mostra um aviso.
// ─────────────────────────────────────────────
window.CHECKOUT_MENSAL = 'https://pay.kirvano.com/2f15d0a6-b33c-4a80-9210-41a2da119a09';
window.CHECKOUT_ANUAL  = 'https://pay.kirvano.com/dc3e064f-88bb-49b5-9514-94263d870ee1';
