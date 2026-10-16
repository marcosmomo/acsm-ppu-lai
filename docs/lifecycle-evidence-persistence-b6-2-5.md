# B6.2.5 — Persistência isolada de evidências lifecycle

## Decisão arquitetural

**Escolhida: B — evidências aninhadas no `plugCycles` do mesmo `GovernanceRepository`.** O Repository já faz lock multiprocesso no host, leitura estrita, revisão, escrita temporária/fsync/rename e commit de um documento inteiro. Ciclo, registro de evidência, checkpoint de armazenamento e histórico entram no mesmo draft e são publicados juntos.

| Alternativa | Atomicidade | Recuperação/concorrência | Custo e riscos |
| --- | --- | --- | --- |
| A. Arquivo independente | Não é atômico com ciclo/checkpoint; janelas entre arquivos. | Exige lock compartilhado e protocolo de reconciliação; recuperação pode ver só um dos lados. | Duplica a autoridade, cresce risco de conflito/reconciliação e ainda exige retenção do histórico. |
| B. Mesmo Repository | Uma publicação do documento contém evidência, checkpoint e histórico. | Reusa o lock/revision; retries idempotentes verificam sob o mesmo lock e processos cooperantes não perdem atualização. | Documento cresce com retenção; transação reescreve o JSON completo. Mudança de schema é aditiva/opcional e não migra a fonte operacional. |
| C. Banco transacional existente | Potencialmente forte se evidência, ciclo e checkpoints compartilharem a mesma transação. | Depende de identificar um banco que seja autoritativo para governança; MySQL operacional está fora do escopo e não foi usado. | Não há base transacional apropriada comprovada nesta tarefa; introduzir uma seria injustificado e exigiria migração/cutover. |

## Modelo e API

Arquivo: `lib/governance/lifecycleEvidenceRepository.mjs`.

`new LifecycleEvidenceRepository({ repository, verifyEvidenceOrigin, confirmationPolicy, now, resolveExpectedPreviousState })` recebe explicitamente o `GovernanceRepository`, o verificador confiável server-side, política mínima de confirmação e resolver local de ordem/estado. O cliente da operação não consegue fornecer/substituir verificador ou política.

- `record({ identity, evidence, expectedRevision })`: valida identidade completa e evidência versionada; verifica ciclo e perfil exatos; rejeita transição duplicada com conteúdo/identidade divergente; grava em `plugCycles[plugCycleId].lifecycleEvidence.PLUG|UNPLUG`, checkpoint específico e histórico em uma transação.
- `reconcile({ identity, operation, expectedRevision })`: revalida evidência pendente quando o estado anterior autoritativo se torna disponível. Só altera status documental para `VALIDATED`; não ativa nem fecha ciclo.
- `readCycle({ identity })`: recupera ciclo, evidência Plug/Unplug, checkpoints e estado de processamento.
- `listPendingReconciliation()`: lista somente referências/identificadores de evidências aguardando reconciliação.

Status de processamento da evidência: `VALIDATED` ou `PENDING_RECONCILIATION`. `VALIDATED` significa validação documental/origem/ordem conforme política injetada, não confirmação física. Níveis continuam separados: BACKEND_ACCEPTED, COMMUNICATION_ACK e PHYSICAL_STATE_CONFIRMED. A política pode rejeitar níveis inferiores; ACK nunca é elevado automaticamente a estado físico.

Checkpoints aditivos `plugEvidenceStored`/`unplugEvidenceStored` significam apenas que o documento está persistido. Não alteram `lifecycleTransitioned`, `closeRequested`, estado `RESERVED/ACTIVE/FAILED/CLOSED`, status do perfil ou aprovação. O teste comprova que evidência Plug deixa ciclo `RESERVED` e perfil `PENDING_APPROVAL`; evidência Unplug deixa ciclo `ACTIVE` e aberto.

## Atomicidade e recuperação real

O Repository escreve o ciclo inteiro uma vez; evidência, checkpoint específico e entrada de histórico são confirmados juntos. Não há estado persistido em que apenas um desses três componentes tenha sido publicado. Um `NO_OP` idêntico mantém revisão e bytes do documento sem alteração. Uma falha antes do rename deixa a revisão confirmada anterior intacta; após reinício, a leitura estrita recupera o estado publicado.

O teste de processos distintos demonstra serialização para processos que compartilham o mesmo Repository/arquivo e filesystem local. Isso não protege escritores legados que não adotem o mesmo lock. Não alegamos garantia para NFS/SMB/múltiplos hosts.

O conteúdo `PENDING_RECONCILIATION` é persistido quando a ordem não pode ser estabelecida com o estado autoritativo disponível. A reconciliação revalida identidade, origem, hash, política e `previousState`. Ausência de estado não converte a evidência em válida nem progride o ciclo.

## Confiança e limites

- O verificador de origem é injetado na construção do serviço e deve ser uma função server-side confiável; nenhuma autoridade operacional é criada por esta entrega.
- O Repository não dá durabilidade a um `transitionId` de origem inexistente: é necessário que o componente emissor real persista um registro de transição durável e recuperável.
- O resolver de estado deve consultar um estado autoritativo/local já disponível e ser síncrono; se não houver base suficiente, a evidência permanece pendente. Não usar body HTTP, relógio isolado ou timeout como estado.
- Não foi criado banco. O documento tende a crescer: integração real deverá definir retenção/arquivamento sem apagar evidências necessárias ao histórico/auditoria e sem quebrar atomicidade.
- Store é isolado e exige caminho absoluto injetado; não lê nem altera `governance-store.json` operacional.
- Sem emissor autenticado, persistência autoritativa da transição, política real de nível, confirmação física e coordenação de todos os escritores, readiness permanece BLOCKED. Não avançar B6.3 com base nestes testes.
