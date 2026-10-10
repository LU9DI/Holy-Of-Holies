# Índice de auditoria e preservação — 2026-10-10

Este arquivo consolida os estados remotos verificados. **Relatórios publicados não significam que os arquivos ZIP/fonte completos foram enviados.**

| Projeto | Repositório / estado verificado | Backup e pendências |
|---|---|---|
| Holy of Holies | https://github.com/LU9DI/Holy-Of-Holies/tree/backup-snapshot-2026-10-10 | Branch de backup preserva código rastreado e histórico Git; PR #1 aberta. CI após correção: 148 testes passaram. ZIP da branch: https://github.com/LU9DI/Holy-Of-Holies/archive/refs/heads/backup-snapshot-2026-10-10.zip |
| AURIX | https://github.com/LU9DI/AURIX — árvore recursiva tem 26 entradas, incluindo alguns arquivos de código, não o snapshot completo | ZIP local/Library: 16,810,255 bytes; SHA-256 `26675f1ce8f1d6e581abd9942e2a60a2f15fdb7e949bde586dfa3fa14978e126`; 246 entradas verificadas. ZIP e árvore completa ainda não enviados. |
| AEGIS / MALEBOLGE | https://github.com/LU9DI/AEGIS — árvore remota tem 3 arquivos de documentação | ZIP local/Library: 27,238,155 bytes; SHA-256 `d668f26b76d1df332bdec6fa363305c2d9e5aa167c21c10ec00b7eb8f2a9be03`; 365 entradas verificadas. Código e ZIP ainda não enviados. |
| Zion | https://github.com/LU9DI/zion — árvore remota tem 13 entradas, principalmente documentação/configuração, sem árvore-fonte runtime completa | ZIP local/Library: 13,858,755 bytes; SHA-256 `e0d7ae6ac2ed68f4dda1f975204df360be6c68ca79be4a86829d25430311f74a`; 388 entradas verificadas. Código completo e ZIP ainda não enviados. Sidecar de checksum antigo diverge. |
| Sentinel | https://github.com/LU9DI/Sentinel — 59 entradas na árvore verificada | PR #7 aberta, mergeable=false; integração PostgreSQL falha por mismatch de parâmetros no INSERT e cleanup bloqueado por FK. |
| DOT / Filtra.AI | https://github.com/LU9DI/saas-reputacao-ia — 475 entradas na árvore verificada | PR #48 e #49 abertas, CI falha. PR #49 remove fluxo PDF antigo; revisar antes de merge. |
| Backend / Jatai | https://github.com/LU9DI/backend | PR #110 aberta, CI falha e deploy foi pulado; PR remove o antigo arquivo de relatório PDF. |
| Tax platform | https://github.com/LU9DI/tax-platform-br | PR #14 aberta, mergeable=false, 2 commits à frente e 72 atrás; falham testes IBS/CBS, JWT, perfil tributário e histórico Fator R. |

## Resultados de auditoria
- **AURIX:** compileall passou; 292 testes coletados, mas suíte interrompida por timeout; Ruff não executado. Achados altos: variável local usada antes da atribuição no ramo robots.txt e risco de DNS rebinding na proteção SSRF.
- **AEGIS:** 227 testes e 76 subtestes documentados como aprovados. Há lacunas em snapshots históricos; o baseline Git recuperado não reconstitui commits intermediários. Protótipo de pesquisa, não certificado.
- **Zion:** 533 testes documentados como aprovados, 166 arquivos JS verificados, demos aprovadas. O hash do sidecar antigo não corresponde ao ZIP materializado mais recente.
- **Holy of Holies:** o teste pós-restart esperava o código errado; a expectativa foi alinhada a `OPERATION_ALREADY_CLAIMED`, mantendo negação de redispatch. CI posterior: 148/148 testes.
- **Sentinel, DOT, backend e tax:** as PRs listadas não foram mescladas por esta auditoria.

## Estado da publicação
Os relatórios textuais e índices desta auditoria foram adicionados aos repositórios onde a conexão GitHub permitiu. **Os três ZIPs AURIX/AEGIS/Zion não foram carregados como arquivos binários e os repositórios AEGIS/Zion não contêm a árvore de código completa.** Não declarar “tudo publicado” até que os ZIPs/árvores de fonte estejam efetivamente presentes e verificados em GitHub. Material exclusivamente conversacional ou em conversa apagada não pode ser garantido como recuperado.


## Manifestos de checksum publicados
- AURIX: https://github.com/LU9DI/AURIX/blob/main/backups/SHA256SUMS-AURIX-2026-10-09.txt
- AEGIS: https://github.com/LU9DI/AEGIS/blob/main/SHA256SUMS-AEGIS-2026-10-09.txt
- Zion: https://github.com/LU9DI/zion/blob/main/SHA256SUMS-zion-master-v0.33.32.txt
