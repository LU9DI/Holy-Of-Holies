# Holy of Holies — auditoria de preservação completa

Data da verificação: 2026-10-10 (UTC)

## Resultado

Esta branch foi criada a partir da branch `main` para preservar o código publicado com a mesma ancestralidade Git, mais este relatório e o índice de preservação.

- Repositório: https://github.com/LU9DI/Holy-Of-Holies
- Commit-base da `main`: `72385a29c35a0f9d4258843c6c6486cfcccb3bca`
- Branch de preservação: `backup-complete-2026-10-10`
- PR #1: https://github.com/LU9DI/Holy-Of-Holies/pull/1
- CI da main no commit-base: https://github.com/LU9DI/Holy-Of-Holies/actions/runs/38014815458

## Verificações executadas

1. Árvore Git recursiva da `main`: 46 arquivos versionados, árvore não truncada.
2. Árvore Git recursiva de `backup-snapshot-2026-10-10`: 48 arquivos versionados, árvore não truncada.
3. Comparação de caminhos e Git blob SHAs: todos os 46 arquivos de `main` estão presentes no snapshot antigo e nenhum arquivo de código comparado diverge. O snapshot antigo tem ainda dois relatórios.
4. A comparação de commits revelou que o snapshot antigo e a `main` têm históricos divergentes: o snapshot antigo está 27 commits à frente e 2 atrás da main (conforme comparação entre refs feita na auditoria). Isso é divergência de ancestralidade, não prova de perda de código.
5. A branch histórica `backup-snapshot-2026-10-09` conserva uma versão anterior. Cinco arquivos diferem da `main`: `README.md`, `src/provider-reconciliation.mjs`, `src/provider-reconciliation.test.mjs`, `src/tool-registry-recovery-integration.test.mjs` e `src/tool-registry.mjs`. A comparação mostra evolução posterior; não prova, por si só, que sejam alterações perdidas.
6. O snapshot de preservação anterior tem os mesmos caminhos e conteúdos de código da main, mas não possui a mesma ancestralidade. Esta nova branch foi criada a partir da main para corrigir esse problema de preservação.

## Histórico preservado

As branches existentes foram mantidas, sem exclusão ou sobrescrita:
- `main`
- `feat/provider-idempotency-context`
- `backup-snapshot-2026-10-09`
- `backup-snapshot-2026-10-10`

Esta branch adicional, `backup-complete-2026-10-10`, parte diretamente da `main` e adiciona os documentos de auditoria. Assim, o snapshot anterior e seu histórico não são destruídos.

## Mudanças principais publicadas

- Chaves de idempotência determinísticas com escopo do provedor.
- Persistência do `providerScope` no journal de recuperação.
- Reconciliação bloqueada antes da consulta ao provedor se o escopo não estiver persistido ou divergir do escopo solicitado.
- Testes de regressão para os casos de escopo ausente e divergente.
- Testes e documentação de recuperação de operações interrompidas.

## O que esta auditoria não consegue provar

Esta auditoria comprova a consistência entre as árvores Git atualmente acessíveis e registra a divergência histórica encontrada. Ela **não pode provar que absolutamente tudo produzido durante toda a vida do projeto foi recuperado**. GitHub não fornece, por essas branches, arquivos locais nunca commitados, alterações não enviadas, ou conteúdo que existia somente em conversas apagadas. Para comprovar esses itens seria necessário localizar as fontes originais (clones, arquivos ZIP, artefatos ou conversas) e compará-las.

Os arquivos ZIP do GitHub contêm somente arquivos versionados da branch escolhida. A criação desta branch não recupera material externo ausente.

## Recomendação operacional

Use `main` como branch de desenvolvimento e `backup-complete-2026-10-10` como snapshot de preservação com histórico alinhado. Mantenha as duas branches de snapshot anteriores como registros históricos até que eventuais cópias externas sejam auditadas. Não declare completude histórica absoluta sem comparar essas fontes adicionais.
