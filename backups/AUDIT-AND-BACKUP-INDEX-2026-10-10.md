# Índice de preservação de projetos — 2026-10-10

Este repositório registra os resultados de auditoria e a proveniência dos snapshots recuperados. Não afirmar que os ZIPs foram publicados no GitHub: os arquivos binários estão preservados na Library/ambiente de trabalho e ainda precisam de upload binário real para se tornarem artefatos remotos.

## Estado confirmado

| Projeto | Repositório | Estado do GitHub | Backup verificado |
|---|---|---|---|
| Holy of Holies | https://github.com/LU9DI/Holy-Of-Holies | Branch `backup-snapshot-2026-10-10`; CI verde após correção do teste; PR #1 aberta | ZIP de branch: https://github.com/LU9DI/Holy-Of-Holies/archive/refs/heads/backup-snapshot-2026-10-10.zip |
| AURIX | https://github.com/LU9DI/AURIX | Repositório vazio quando auditado | `AURIX-complete-backup-v0.85.0-2026-10-09.zip`, 16,810,255 bytes; SHA-256 `26675f1ce8f1d6e581abd9942e2a60a2f15fdb7e949bde586dfa3fa14978e126` |
| AEGIS / MALEBOLGE | https://github.com/LU9DI/AEGIS | Repositório vazio quando auditado | `AEGIS-FULL-HISTORY-RECOVERY-2026-10-09.zip`, 27,238,155 bytes; SHA-256 `d668f26b76d1df332bdec6fa363305c2d9e5aa167c21c10ec00b7eb8f2a9be03` |
| Zion | https://github.com/LU9DI/zion | Repositório vazio quando auditado | `zion-master-preservation-v0.33.32.zip`, 13,858,755 bytes; SHA-256 `e0d7ae6ac2ed68f4dda1f975204df360be6c68ca79be4a86829d25430311f74a` |
| Sentinel | https://github.com/LU9DI/Sentinel | PR #7 aberta; integração PostgreSQL falha | Código rastreado no GitHub; ZIP mestre não encontrado na Library |
| DOT / Filtra.AI | https://github.com/LU9DI/saas-reputacao-ia | PR #48 e #49 abertas e com CI falhando | Revisão das PRs; não mesclar #49 sem rever a remoção do fluxo PDF |
| Backend / Jatai | https://github.com/LU9DI/backend | PR #110 aberta, CI falha e deploy pulado | Revisão da PR; não foi encontrado repo separado JataiCloud |
| Tax platform | https://github.com/LU9DI/tax-platform-br | PR #14 aberta, mergeable=false e CI falhando | Revisão de CI e necessidade de rebase |

## Resultados técnicos relevantes

- Holy of Holies: correção da expectativa de erro no teste de recuperação pós-restart; CI posterior executou 148 testes, 0 falhas.
- AURIX: ZIP e manifesto verificados; 246 entradas sem ausências/divergências. Auditoria encontrou falha de variável local no ramo robots.txt e janela potencial de DNS rebinding/SSRF. Suíte de 292 testes não terminou no tempo disponível; Ruff não executado.
- AEGIS: 365 entradas do bundle verificadas sem ausências/divergências; 227 testes e 76 subtestes passaram na execução documentada. Há lacunas históricas e limitações criptográficas explicitadas no relatório.
- Zion: 388 entradas verificadas sem ausências/divergências; 533 testes, 166 arquivos JS verificados e demos documentadas como aprovadas. O sidecar SHA-256 antigo não corresponde ao ZIP materializado mais recente; usar o hash calculado acima.
- Sentinel: PR #7 está 10 commits à frente e 28 atrás de main; integração PostgreSQL falha por divergência no número de parâmetros do INSERT e limpeza bloqueada por FK.
- DOT: PR #49 remove o antigo backend/relatorioPdf.ts e substitui o fluxo PDF por JSON-first; revisar contra o requisito de preservar o PDF.
- Backend/Jatai: PR #110 também remove o antigo relatorioPdf.ts; CI falha e deploy não executou.
- Tax: PR #14 está 2 commits à frente e 72 atrás de main; testes de cancelamento IBS/CBS, JWT, perfil tributário e histórico Fator R falham.

## Limitações explícitas

1. Os três ZIPs AURIX, AEGIS e Zion foram verificados na Library, mas **ainda não estão armazenados como arquivos binários no GitHub**. Este índice e os relatórios textuais não substituem os ZIPs.
2. Os repositórios AURIX, AEGIS e Zion estavam vazios na consulta; não afirmar que seus códigos foram publicados neles.
3. Não é possível garantir a recuperação de material que existia somente em conversas apagadas e nunca foi salvo como arquivo.
4. CI verde não equivale a merge, deploy ou auditoria independente.
5. Nenhuma PR mencionada foi mesclada por esta auditoria.

## Links úteis

- Holy of Holies backup: https://github.com/LU9DI/Holy-Of-Holies/tree/backup-snapshot-2026-10-10
- Relatório Holy of Holies: https://github.com/LU9DI/Holy-Of-Holies/blob/backup-snapshot-2026-10-10/backups/AUDIT-2026-10-10.md
- CI Holy of Holies: https://github.com/LU9DI/Holy-Of-Holies/actions/runs/38013115485
- PR Sentinel #7: https://github.com/LU9DI/Sentinel/pull/7
- PR DOT #48: https://github.com/LU9DI/saas-reputacao-ia/pull/48
- PR DOT #49: https://github.com/LU9DI/saas-reputacao-ia/pull/49
- PR Backend #110: https://github.com/LU9DI/backend/pull/110
- PR Tax #14: https://github.com/LU9DI/tax-platform-br/pull/14
