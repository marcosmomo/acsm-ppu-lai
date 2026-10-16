# B6.2.6 — Autoridade lifecycle lógica isolada

## Auditoria do legado

- `lib/acsm/plugStore.mjs::transitionPlugAssetLifecycle(cpsId, lifecyclePhase, timestamp)` localiza o asset por CPS e modifica snapshot em `globalThis`. Retorna `{ ok, cpsId, lifecyclePhase, state }`; não recebe plugEventId/plugCycleId/profileId, não valida ciclo/ordem, não gera `transitionId` e não persiste estado em armazenamento durável multiprocesso.
- `lib/acsm/unplugLifecycle.mjs::executeAcsmUnplug(cpsId, timestamp)` chama a transição em memória e depois `closeGovernancePlugCycle(cpsId, ...)`. O fechamento usa só CPS e ocorre em outra persistência; portanto, existe janela de falha e risco de fechar ciclo diferente.
- `lib/acsm/plugPostHandler.mjs` cria o perfil de governança antes de chamar a transição Plug; depois prepara/enfileira outbox e observação Evolution. A correlação de entrada é CPS/evento, mas os IDs de ciclo/perfil não são argumentos do `transitionPlugAssetLifecycle`. O caminho de snapshot também chama fechamento por CPS para fases unplug.
- `lib/governance/lifecycleEvidence.mjs` emite `BACKEND_ACCEPTED` somente para resultado tipado e origem validada; o Store atual não produz esse resultado tipado.
- `lib/governance/lifecycleEvidenceRepository.mjs` persiste evidência no Repository, mas se chamado depois de uma alteração de lifecycle separada há janela entre os commits.
- `lib/governance/transactionalGovernanceAdapters.mjs` exige evidência injetada para ativação/fechamento, mas não fornece a autoridade lifecycle operacional.

Logo, o legado atual é uma projeção mutável em memória e não pode ser tratado como autoridade durável. Não foi alterado ou chamado nesta etapa.

## Decisão

O protótipo escolhe a estratégia de **um agregado no GovernanceRepository**, sem segundo arquivo/banco:

| Opção | Resultado |
| --- | --- |
| A. Manter Plug Store e gravar evidência depois | Não atômico: estado pode mudar sem evidência recuperável ou vice-versa; há também diferença entre estado `globalThis` e processos concorrentes. Requer outbox/reconciliação e não foi escolhido. |
| B. Estado lógico, ciclo, evidência e checkpoint no GovernanceRepository | Uma transação/lock do mesmo documento grava todos. É implementado no protótipo e reusa a persistência local existente, sem migração automática nem novo banco. |
| C. Banco transacional | Poderia funcionar se estado, ciclo, perfil e evidência pertencessem ao mesmo banco/commit. Nenhum banco de governança independente foi comprovado; MySQL operacional está fora do escopo. Criar/migrar um banco não se justifica nesta etapa. |

## Protótipo

`lib/governance/transactionalLifecycleAuthority.mjs` exporta `TransactionalLifecycleAuthority({ repository, source, verifyTransitionResult, now })` e `transition({ identity, operation, expectedRevision })`, `read({ identity })` e `readiness()`.

1. Sob o lock do Repository, verifica os quatro IDs contra o `plugCycleId`, `governanceProfileId` e versão de perfil correspondentes.
2. Lê `authoritativeLifecycleState` persistido no ciclo. Só permite Plug de `idle`/`unplugged` e Unplug de `plug`/`play`.
3. Deriva `transitionId` estável por SHA-256 da versão de esquema, identidade completa e operação; timestamp não participa do ID.
4. Constrói um resultado tipado server-side — o chamador não fornece `accepted`, resultado, timestamp nem resposta HTTP como prova —, verifica a autoridade injetada e cria evidência exclusivamente `BACKEND_ACCEPTED`.
5. No mesmo `repository.transact`, grava estado lógico, registro da transição, evidência v1.0, checkpoint `plugEvidenceStored`/`unplugEvidenceStored` e histórico. A validação estrutural do Repository assegura que estado, transição, evidência, IDs e checkpoint permaneçam correlacionados.
6. Só retorna a evidência depois de `transact()` publicar o commit. Falha antes da publicação não retorna evidência aceita e deixa intacto o estado anterior.

Retry da mesma identidade/operação retorna o registro persistido e `NO_OP`; a tentativa não muda timestamp, revisão ou histórico. Reutilização do slot com divergência falha. A identidade completa é usada em cada chamada, então Unplug atrasado de outro ciclo não pode afetar ciclo novo.

O estado lógico resultante fica gravado, mas o estado de governança do ciclo permanece `RESERVED` (Plug) ou como estava (Unplug); `lifecycleTransitioned` não é promovido e `closeRequested` não é ligado. Nenhum perfil é aprovado/rejeitado/fechado. `BACKEND_ACCEPTED` descreve commit lógico no backend, nunca ACK nem execução física.

O verificador injetado é chamado sincronicamente enquanto o lock está ativo; deve ser uma verificação local, determinística e sem I/O externo. No teste é um mock, não identidade de serviço real. Não há publish MQTT, REST, HCM, OPC UA ou comando físico.

## Falhas e recuperação

| Falha | Estado recuperável |
| --- | --- |
| Erro de validação, estado anterior inesperado ou identidade incorreta | Transação aborta; nenhum registro novo. |
| Falha antes do rename/publicação | Estado, evidência e checkpoint antigos permanecem juntos; retry após reinício pode repetir a transição. |
| Processo encerra depois da publicação | Os três registros são recuperados do mesmo JSON; retry retorna NO_OP. |
| Dois processos tentam a mesma transição | Lock serializa; um grava, o outro retorna a mesma evidência sem escrita. |
| Ciclo fechado ou IDs de ciclo/perfil obsoletos | Conflito; nunca resolve apenas por CPS. |
| Autoridade/verificador real indisponível | A integração não deve invocar a autoridade; readiness permanece BLOCKED. |

## Testes executados

`test/transactional-lifecycle-authority.test.mjs` usa fixtures sanitizadas e cópias em diretórios temporários; `test/fixtures/transactional-lifecycle-authority-worker.mjs` testa processos Node distintos no mesmo arquivo temporário. Casos: Plug/Unplug, IDs divergentes, transição não permitida, retry idempotente, reinício entre fases, failpoint pré-publicação, concorrência, consistência da evidência/estado, ausência de inferência física e dependências puras.

## Lacunas para substituir o legado

- Identidade de serviço/autenticação real e verificador confiável; o mock de teste não é credencial.
- Todos os escritores/leitores operacionais precisam passar pela autoridade/repository. Enquanto o `plugStore` e rotas antigas forem escritores, haverá duas autoridades.
- Migração explícita do estado lifecycle real para o agregado; o campo `authoritativeLifecycleState` não deve ser inicializado com estado presumido ou vindo de resposta não confiável.
- Cutover coordenado: suspender escritores, backup consistente, compatibilidade de todos os processos no mesmo host/filesystem local, migração/reconciliação dos ciclos abertos e rollback testado.
- Integração separada da evidência lógica com ACK e telemetria física real. Não inferir estado físico de commit backend.
- Política para Unplug lógico aceito enquanto o ciclo de governança ainda estiver RESERVED, seguido de fechamento correlacionado e recuperável sem aprovação automática.

`readiness()` retorna sempre `BLOCKED` para esta instância de protótipo. Não foi iniciada B6.3 nem cutover.
