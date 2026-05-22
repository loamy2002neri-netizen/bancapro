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
window.SUPABASE_URL = 'COLE_SUA_PROJECT_URL_AQUI';
window.SUPABASE_ANON_KEY = 'COLE_SUA_ANON_PUBLIC_KEY_AQUI';
