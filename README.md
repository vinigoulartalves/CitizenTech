# Calçada Livre

MVP acadêmico da FIAP Global Solution. O cidadão pode registrar barreiras em calçadas e travessias, receber um protocolo e consultar seu andamento. O operador revisa a categoria e publica atualizações.

## Executar localmente

Use Node.js 24 ou superior. A aplicação usa os módulos nativos do Node.js e não precisa instalar dependências.

No PowerShell:

```powershell
$env:OPERATOR_KEY = "chave-local-de-demonstracao"
npm start
```

No Bash:

```bash
OPERATOR_KEY=chave-local-de-demonstracao npm start
```

Abra http://127.0.0.1:3000 e use a mesma chave no painel de triagem. Os relatos são persistidos em `data/calcada-livre.sqlite`. É possível ajustar a porta e o caminho do banco com `PORT` e `DATABASE_PATH`.

## Demonstração

1. Clique em **Preencher exemplo** e envie o relato simulado sem foto. Guarde o protocolo.
2. Em **Triagem**, carregue os relatos, revise a sugestão **Rampa obstruída** e escreva a nota pública. Clique em **Mover para Em análise**.
3. Consulte o protocolo e confira o novo status e o histórico.

O classificador funciona por regras locais e simula a sugestão de uma futura IA. Use a variável `CLASSIFIER_MODE=unavailable` ao iniciar o servidor para simular indisponibilidade. Novos relatos seguem para classificação manual. O exemplo é fictício e não foi coletado em campo.

O rascunho de texto fica no navegador. O envio exige conexão com a aplicação. Fotos ficam no banco local e são acessíveis pela triagem. A consulta por protocolo mostra status, categoria e notas públicas.

## Verificação

```bash
npm test
```

A suíte cobre registro sem foto, consulta após triagem, indisponibilidade do classificador e controle de acesso à foto. O workflow CI executa as verificações em push para `main` e em PRs para essa branch.

O MVP é voltado à demonstração local. Azure App Service, PostgreSQL gerenciado, Blob Storage e a promoção de homologação para produção são partes da arquitetura proposta para uma etapa futura.
