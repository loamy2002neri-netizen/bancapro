# BancaPRO — Gestão Financeira

Aplicação web para gestão financeira de banca de apostas esportivas, com dashboard, KPIs, gráficos, transações, ranking e comparativo de métodos (Surebet, Delay, Freebet, Duplo Green).

## Estrutura

```
BancaPRO/
├── index.html      # Estrutura HTML
├── style.css       # Estilos
├── script.js       # Lógica da aplicação
└── README.md
```

## Como rodar

### Opção 1 — Abrir direto no navegador
Dê duplo clique em `index.html`.

### Opção 2 — Live Server no VS Code (recomendado)
1. Abra a pasta no VS Code (`File → Open Folder`)
2. Instale a extensão **Live Server** (Ritwick Dey)
3. Clique com o botão direito em `index.html` → **Open with Live Server**
4. A página recarrega automaticamente a cada `Ctrl+S`

## Tecnologias

- HTML5, CSS3, JavaScript (vanilla)
- [Chart.js 4.4.0](https://www.chartjs.org/) — via CDN
- `localStorage` para persistência

## Funcionalidades

- Tela de login/cadastro
- Dashboard com KPIs e gráficos
- Cadastro e listagem de transações (receitas/despesas)
- Comparativo entre métodos de aposta
- Evolução por método nos últimos 6 meses
- Tema escuro/claro
- Layout responsivo (desktop e mobile)
- Notificações toast e modais com focus trap
- Atalho ESC para fechar modais
