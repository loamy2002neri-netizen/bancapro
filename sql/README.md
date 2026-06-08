# SQL — Migrations & Diagnósticos

## 📁 Estrutura

```
sql/
├── README.md                          # você está aqui
├── migrations/                        # mudanças DESTRUTIVAS/persistentes no banco
│   ├── 001_ranking_anti_backdate.sql
│   ├── 002_referral_code_anonymous.sql
│   ├── 003_owner_filter_rpcs.sql
│   └── 004_ban_admins.sql
└── diagnostico_*.sql                  # queries de leitura/check (não muda nada)
```

## 🚦 Como funciona

### Migrations
Cada arquivo numerado (`001_`, `002_`...) é uma **migration imutável**:
- Roda **UMA VEZ** no Supabase, depois fica como histórico
- Pra desfazer, criar `00X_revert_NNN.sql`
- Sempre incrementar o número — nunca renumerar antigas
- Idempotente quando possível (usar `CREATE OR REPLACE`, `ON CONFLICT`, etc.)

### Diagnósticos
Queries de leitura pra debugar — pode rodar quantas vezes quiser, não muda nada.

## ✅ Status das migrations aplicadas em produção

| # | Arquivo | Aplicada? | Data |
|---|---|---|---|
| 001 | `ranking_anti_backdate.sql` | ✅ Sim | 2026-06-05 |
| 002 | `referral_code_anonymous.sql` | ✅ Sim | 2026-06-05 |
| 003 | `owner_filter_rpcs.sql` | ✅ Sim | 2026-06-06 |
| 004 | `ban_admins.sql` | ✅ Sim | 2026-06-06 |
| 005 | `ranking_avatar.sql` | ✅ Sim | 2026-06-08 |

> **Atualizar essa tabela toda vez que rodar uma migration nova!**

## 🆕 Pra criar uma migration nova

1. Próximo número: `005_descricao_curta.sql`
2. Escrever SQL idempotente (use `CREATE OR REPLACE FUNCTION`, `ON CONFLICT DO NOTHING`, etc)
3. Aplicar no Supabase SQL Editor
4. Marcar como ✅ Aplicada na tabela acima
5. Commitar

## 🔄 Pra um Supabase NOVO (setup do zero)

Rodar todas as migrations em ordem:
```
001 → 002 → 003 → 004
```

## 📋 RPCs ativos no banco

- `get_leaderboard()` (geral)
- `get_leaderboard_today()`
- `get_leaderboard_weekly()`
- `get_leaderboard_monthly()`
- `resolve_referral_code(p_code text)`
- `get_my_affiliate()`
- `get_my_referral_stats(p_email text)`
- `get_my_referrals_list(p_email text)`
- `admin_list_affiliate_withdrawals(p_status text)`
- `admin_mark_withdrawal_paid(p_id uuid, p_note text)`
- `admin_reject_withdrawal(p_id uuid, p_reason text)`
- `is_owner_email(p_email text)` (helper)

## 🛡️ Tabelas críticas

| Tabela | Propósito |
|---|---|
| `user_data` | JSONB com `bancapro-*` keys por usuário |
| `subscribers` | Status de assinatura (active/cancelled/etc) |
| `referrals` | Quem indicou quem (link `?ref=`) |
| `affiliate_commissions` | Comissões pendentes/disponíveis/pagas |
| `affiliate_withdrawals` | Pedidos de saque via Pix |
| `affiliate_codes` | Códigos VIP fixos (não-derivados) |
| `banned_from_ranking_users` | Banidos do leaderboard (inclui owners) |

---

**Sempre que mudar algo no banco, atualizar este README.**
