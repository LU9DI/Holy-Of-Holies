# Holy of Holies — auditoria técnica profunda (primeira passagem)

Data: 2026-10-10 (UTC)
Escopo: branch `main` no commit `7bbffab8b105d831eaa277ea0e6b6620d2f40219`; inspeção estática dos arquivos publicados, documentação, configuração de CI, branches e metadados públicos do GitHub.

## Resumo executivo

A base contém módulos reais e testes para máquina de estados, política, ledger JSONL, orquestração, registro de ferramentas, recuperação/reconciliação de operações, workspace, revogação e verificação assinada. A execução de CI consultada passou no commit auditado.

**Conclusão:** o projeto ainda é uma fundação de core, não uma plataforma autônoma pronta para produção. O próprio README e os documentos de arquitetura/segurança declaram limitações substanciais. A CI verde confirma somente os checks implementados, não a segurança global nem a completude funcional.

Esta é uma auditoria estática de primeira passagem, não um pentest, análise formal, fuzzing, execução local independente ou certificação. Nenhuma vulnerabilidade explorável foi declarada sem reprodução.

## Lacunas e riscos priorizados

### P0 — Bloqueadores antes de executar código não confiável ou anunciar segurança de produção

1. **Isolamento de execução não equivale a sandbox formal.**
   - Evidência: `src/verification-runner.mjs`, `src/container-verification-runner.mjs`, `docs/security-model.md` e `docs/architecture.md`.
   - O runner de processo no host não isola rede, filesystem, credenciais, syscalls ou processos descendentes. O runner OCI adiciona controles (imagem por digest, sem rede, mount de workspace somente leitura, usuário não root e limites), mas continua dependente do runtime/kernel e da configuração do host.
   - A documentação já alerta para não executar código hostil sem uma fronteira de isolamento operada separadamente.
   - Ação: executar tarefas não confiáveis somente em workers descartáveis/rootless, sem credenciais do host, com runtime endurecido e políticas verificadas; testar fuga, descendentes, timeout/cancelamento, consumo de recursos e falhas do runtime.

2. **Identidade, política e aprovação confiáveis são injetadas pelo consumidor, não fornecidas como serviço de produção.**
   - Evidência: `src/durable-tool-registry.mjs`, `src/tool-registry.mjs`, `docs/security-model.md`.
   - O core exige callbacks de autorização e consumo atômico de aprovação, mas não implementa identidade criptográfica de usuário, emissão/verificação de aprovação confiável ou armazenamento compartilhado desses registros. Callbacks incorretos podem anular as garantias do core.
   - Ação: definir e implementar uma fronteira de identidade/autorização, aprovações vinculadas a principal + ação + recurso + hash canônico da entrada, consumo single-use atômico e testes de replay/concorrência. Manter segredos fora do processo do agente.

3. **Emissão de atestados exige um serviço de confiança separado e gestão operacional de chaves ainda não entregue.**
   - Evidência: `src/verification-attestor.mjs`, `src/verification-engine.mjs`, `src/verification-coordinator.mjs`, documentação de segurança.
   - O código separa assinatura e verificação, o que é positivo, mas não provisiona HSM/KMS, rotação, custódia, recuperação, auditoria de acesso ou deployment seguro do emissor. O set de IDs já emitidos no emissor é em memória; unicidade durável precisa ser garantida pela composição/serviço que o hospeda.
   - Ação: serviço emissor isolado, chave protegida, rotação/revogação de chaves, registro durável e atômico de IDs, controle de relógio, backup/recuperação e testes de replay após reinício.

### P1 — Lacunas críticas de confiabilidade e governança

4. **O ledger é local e cresce sem estratégia de compactação/arquivamento.**
   - Evidência: `src/event-ledger.mjs`.
   - A implementação lê e valida o arquivo JSONL inteiro em operações de leitura e antes de cada append; com histórico crescente, o custo de I/O e memória aumenta e o custo acumulado de escrita pode degradar fortemente. Um lock file residual após crash bloqueia o ledger deliberadamente e exige intervenção manual. A cadeia SHA-256 detecta alterações que não recalculam os hashes, mas não impede que um atacante privilegiado reescreva todo o arquivo.
   - Ação: medir escala e limites, introduzir estratégia testada de segmentos/snapshots, recuperação operacional documentada, backups verificados e ancoragem externa assinada; não remover locks automaticamente sem protocolo de propriedade.

5. **A garantia de recuperação é limitada a journaling e reconciliação; não há exactly-once distribuído.**
   - Evidência: `src/operation-recovery.mjs`, `src/provider-reconciliation.mjs`, `src/idempotency-key.mjs`.
   - O projeto corretamente não promete exactly-once. O resultado depende do adaptador real encaminhar a chave estável ao campo de idempotência do provedor e de uma consulta de estado/evidência independente. Não há adaptadores reais de produção nem garantias de consenso distribuído no core.
   - Ação: contratos de adaptador versionados, matriz por provedor, teste de timeout após efeito remoto, repetição, respostas contraditórias, conta/escopo incorreto e evidência forjada; proibir retry automático enquanto o resultado estiver desconhecido.

6. **Risco de TOCTOU entre hash do workspace e conteúdo efetivamente verificado.**
   - Evidência: `src/container-verification-runner.mjs` e `src/verification-engine.mjs`.
   - Hash antes/depois detecta muitas alterações, mas não é prova universal de que o conteúdo lido pelo processo de verificação foi exatamente o conteúdo atestado se outro processo puder modificar/restaurar o workspace durante a execução. A documentação reconhece corridas contra processos com o mesmo usuário do sistema.
   - Ação: usar snapshot imutável ou cópia content-addressed para verificação, sem escritores concorrentes; atestar o digest exato do snapshot montado e testar concorrência maliciosa.

7. **A branch `main` não aparece protegida e não há rulesets visíveis.**
   - Evidência: API pública de branches retorna `protected: false` para `main`; endpoint de rulesets retorna lista vazia. O endpoint detalhado de branch protection não pôde ser lido pela integração (403), portanto detalhes adicionais não são afirmados.
   - Impacto: a CI existe, mas não foi confirmado que seja uma condição obrigatória para merge/push; não há evidência de bloqueio de force-push ou exigência de revisão.
   - Ação: habilitar proteção de `main`, exigir CI e revisão, bloquear force-push/deleção, exigir resolução de conversas e restringir bypass administrativo conforme o modelo de manutenção.

8. **A CI é estreita em relação à superfície de risco.**
   - Evidência: `.github/workflows/ci.yml` contém um job em Ubuntu com Node 22 e executa `npm run check`; este script verifica sintaxe de uma lista explícita de módulos, licença, formato de workflows e testes Node.
   - Lacunas observáveis: nenhuma matriz de versões/SO, cobertura de testes, fuzz/property testing, análise estática de segurança dedicada, auditoria de segredos, SBOM, verificação de dependências/licenças transitivas ou teste de integração com runtime OCI real.
   - Ação: ampliar checks gradualmente; fazer a lista de arquivos sintaticamente verificados ser derivada automaticamente, publicar cobertura, executar testes de falha/concorrência e testar container runner em worker descartável. Fixar actions por SHA já é um controle positivo existente.

9. **O sistema autônomo ponta a ponta não está implementado.**
   - Evidência: README e documentos de arquitetura dizem que o workflow autônomo completo e a implantação de confiança de produção permanecem incompletos. O repositório fornece primitivas e contratos, não um runtime completo com planejamento, ciclo de execução, gestão de modelos, adapters de produção, observabilidade e operação.
   - Ação: definir requisitos de produto e critérios de aceite ponta a ponta antes de chamar o core de plataforma funcional; separar claramente interfaces implementadas, adapters de exemplo e recursos planejados.

### P2 — Preparação para lançamento e manutenção

10. **Não há release/tag publicada nem processo de release reproduzível verificado.**
    - Evidência: endpoint de releases retornou lista vazia; o projeto se descreve como fundação inicial.
    - Ação: versionamento SemVer, changelog, artefatos imutáveis, notas de release, verificações de proveniência e instruções de rollback.

11. **Governança de contribuição e resposta a vulnerabilidades incompleta.**
    - Evidência: README diz que uma contribuição formal ainda é necessária; árvore da `main` não contém `CONTRIBUTING.md` nem `SECURITY.md`.
    - Ação: política de contribuição, canal privado de divulgação, SLA de triagem, política de suporte/versões e processo de publicação de correções.

12. **Auditoria de dependências e notices não está automatizada.**
    - Evidência: o projeto declara zero dependências runtime e tem checagem de texto da licença, mas `scripts/check-license.mjs` só confere metadados e o texto AGPL; não substitui inventário de dependências transitivas, proveniência de código, avisos de terceiros ou SBOM.
    - Ação: gerar SBOM, auditar licenças/notices, automatizar alertas de vulnerabilidade e documentar a procedência de código incorporado. A ausência de dependências runtime reduz o escopo, mas não elimina esse requisito.

13. **Pacote ainda está marcado como privado e não está pronto para publicação no registry.**
    - Evidência: `package.json` contém `"private": true`, sem pipeline de publicação. Isso pode ser intencional enquanto o projeto não está estável; é uma lacuna apenas se houver intenção de publicar o pacote npm.
    - Ação: manter privado até release formal; depois revisar nome/versão, export map, compatibilidade, README de consumo, provenance e processo de publicação.

14. **Não há `.gitignore` na árvore da `main`.**
    - Evidência: árvore recursiva versionada não contém `.gitignore`.
    - Ação: adicionar regras para estado local, logs, arquivos temporários, cobertura e segredos; confirmar que nenhum artefato sensível já foi commitado. Não foi encontrado segredo nesta inspeção limitada, o que não equivale a um secret scan.

15. **O script local `apply-holy-of-holies-provider-scope-fix.py` não foi encontrado na busca do código publicado.**
    - Evidência: busca por nome exato no código do repositório não retornou resultado; ele não está na árvore de `main`.
    - Ação: tratar como possível artefato externo/local até localizar a cópia original; comparar seu conteúdo com os commits e testes antes de recuperá-lo. A ausência na branch não prova que o arquivo nunca existiu fora do GitHub.

## Controles positivos observados

- CI no commit auditado passou: https://github.com/LU9DI/Holy-Of-Holies/actions/runs/38015844203
- A workflow fixa as GitHub Actions externas por SHA completo e usa permissões de conteúdo somente leitura.
- Os testes versionados não exibem declarações explícitas de testes ignorados nas amostras inspecionadas.
- O código documenta honestamente diversas limitações e usa comportamento fail-closed em várias fronteiras.
- O core separa a chave privada de assinatura do verificador público, usa allowlists de comandos e implementa limites de entrada/saída.
- O backup alinhado à main continua separado do código principal e preserva os relatórios de auditoria.

## Plano de remediação recomendado

1. **P0 / segurança operacional:** não executar código hostil no host; definir worker descartável e serviço de aprovação/identidade confiável.
2. **P1 / integridade:** proteger `main`, estabelecer testes de concorrência/TOCTOU e validar recuperação de efeitos remotos por adaptador.
3. **P1 / escala:** medir ledger sob carga e projetar segmentação/arquivamento sem quebrar a cadeia de integridade.
4. **P1 / produto:** definir e implementar o fluxo autônomo end-to-end e adapters reais, mantendo integrações opcionais.
5. **P2 / lançamento:** segurança privada, contribuição, SBOM/notices, secret scanning, changelog e release reproduzível.
6. **Preservação:** localizar backups/clones/artefatos locais e comparar, em especial, o script Python não encontrado no repositório.

## Limites desta auditoria

- A análise de código foi estática e parcial, por leitura dos arquivos do GitHub; não foi executado pentest nem fuzzing.
- A CI consultada passou, mas não foi repetida localmente nesta sessão.
- Não foi possível inspecionar detalhes de proteção de branch por falta de permissão da integração (403); a branch pública consta como não protegida e a API de rulesets não retornou regras.
- A ausência de arquivo no GitHub não demonstra ausência em computador local, ZIP externo, outra conta ou conversa anterior.
- Os itens acima são lacunas de engenharia/produção e riscos de desenho; não devem ser interpretados todos como vulnerabilidades exploráveis confirmadas.
