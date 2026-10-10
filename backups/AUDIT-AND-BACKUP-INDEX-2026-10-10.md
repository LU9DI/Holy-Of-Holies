# Holy of Holies — índice de auditoria e backup

Data: 2026-10-10 UTC.

## Repositório principal
- Repositório: https://github.com/LU9DI/Holy-Of-Holies
- Branch principal: `main`
- Commit com idempotência e reconciliação: `1ac7572da48ca27f57d20452536ea420247572b1`
- PR #1 mesclada: https://github.com/LU9DI/Holy-Of-Holies/pull/1
- CI da PR passou no commit `c90bc3dacd5727aee51188452c4347f2a2b66b19`: https://github.com/LU9DI/Holy-Of-Holies/actions/runs/38014713909
- CI do commit principal após o merge: https://github.com/LU9DI/Holy-Of-Holies/actions/runs/38014735832

## Conteúdo versionado
O snapshot contém o código-fonte JavaScript, testes automatizados, documentação de arquitetura e segurança, configuração de pacote, verificações de licença/workflow e o workflow de CI.

O ZIP da branch pode ser obtido em:
https://github.com/LU9DI/Holy-Of-Holies/archive/refs/heads/backup-snapshot-2026-10-10.zip

O ZIP da branch principal pode ser obtido em:
https://github.com/LU9DI/Holy-Of-Holies/archive/refs/heads/main.zip

## Correções de segurança publicadas
- Persistência do `providerScope` confiável no journal de operações.
- Reconciliação negada antes de consultar o provedor se o registro pendente não tiver escopo durável.
- Reconciliação negada antes de consultar o provedor se o escopo solicitado não corresponder ao escopo persistido.
- Testes de regressão para ambos os casos.

## Limites do backup
Os ZIPs gerados pelo GitHub contêm os arquivos versionados na branch. Não incluem arquivos locais nunca commitados nem recuperam conteúdo que existia exclusivamente em conversas apagadas. O hash de um Git blob não é um SHA-256 do arquivo ZIP.

A chave de idempotência não prova execução exatamente uma vez. A integração real deve encaminhar a chave ao provedor, validar sua semântica de retenção e usar consulta autoritativa e evidência independente para resultados incertos.
