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

// ─────────────────────────────────────────────
//  CONFIGURAÇÃO DE OWNER (Source of Truth única)
//
//  Pra ADICIONAR um novo admin/owner:
//    1) Adicione o email em OWNERS.emails abaixo
//    2) Adicione o nome em OWNERS.signatures pra filtrar do ranking
//    3) Rode SQL em sql/migrations/004_ban_admins.sql pra banir
//       o email novo na tabela banned_from_ranking_users
//
//  Pra REMOVER um admin:
//    1) Remove daqui
//    2) Remove do banned_from_ranking_users (DELETE)
//
//  Quem usa essa config:
//    - script.js: OWNER_EMAILS (auth/permissions) + OWNER_SIGNATURES (rank filter)
//    - sql/.../is_owner_email() — função SQL hard-coded (precisa atualizar manual)
// ─────────────────────────────────────────────
window.OWNERS = {
  // Emails de dono — acesso admin, isentos de cobrança, escondidos do ranking
  emails: [
    'loamy2002neri@gmail.com',
    'loamy69zzz@gmail.com'
  ],
  // Padrões de nome que devem ser filtrados do ranking (substring match,
  // case-insensitive, sem acentos). Pega variantes: "Loamy neri", "LOAMY NERI",
  // "loamy 2002", "Admin Loamy", etc.
  signatures: [
    'loamy neri',
    'loamy 2002',
    'loamy2002',
    'loamy 69',
    'loamy69',
    'loamyzito admin',
    'loamy admin',
    'admin loamy',
    'apostack admin'
  ]
};
