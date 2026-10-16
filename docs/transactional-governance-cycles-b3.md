# Etapa B3 — Ciclos Plug e perfis no mesmo commit isolado

Esta etapa permanece desconectada do `governanceStore.js` e das rotas operacionais.
Ela estende `GovernanceRepository` com `governanceTransactionNoOp()` e adiciona à
`TransactionalGovernanceFacade` as operações correlacionadas abaixo.

## Contrato

- `reserveAndCreatePendingProfile`: cria `plugCycles`, perfil `PENDING_APPROVAL`,
  histórico e envelope PPU inicial em uma transação. O `plugCycleId` default é
  determinístico a partir de CPS e evento. A identidade funcional/AAS é persistida e
  comparada por hash canônico.
- `activateCycle`: transiciona `RESERVED` para `ACTIVE` somente com evidência contendo
  `accepted: true` e `transitionId`.
- `recordCycleFailure`: registra estágio/erro e mantém `FAILED` como estado bloqueante.
- `closeCorrelatedCycle`: fecha ciclo e perfil juntos somente com CPS, evento, ciclo,
  perfil e evidência aceita de Unplug correspondentes.

## Estados e checkpoints

Estados: `RESERVED`, `ACTIVE`, `FAILED`, `CLOSED`.

Checkpoints persistidos em cada ciclo:

- `profilePersisted`: confirmado no commit que contém o perfil;
- `lifecycleTransitioned`: confirmado apenas por `activateCycle` com evidência aceita;
- `ppuOutboxStored`: verdadeiro apenas se o envelope foi inserido na outbox;
- `closeRequested`: verdadeiro somente no commit de fechamento com Unplug aceito.

Perfil e ciclo permanecem conceitos separados. Ativação muda `plugCycleStatus` do perfil,
mas nunca muda `PENDING_APPROVAL`; fechamento preserva `APPROVED` ou `DENIED`.

## Idempotência

O mutator pode retornar `governanceTransactionNoOp(value)` depois de verificar o estado
sob o lock. O repository então não incrementa `revision`, não valida/grava o draft e não
altera bytes, timestamps, histórico, outbox ou versões. Retry com evidência divergente é
conflito, não `NO_OP`.

## Falhas parciais e limites

Uma falha anterior ao rename não confirma nenhuma parte do agregado. Depois da reserva,
uma falha operacional hipotética deve ser registrada por `recordCycleFailure`; a B3 não
chama lifecycle real. `FAILED` não expira e não é liberado automaticamente. Ainda não há
operação de reconciliação de `FAILED`, autenticação real do ator humano ou worker para
`effectIntent`/outbox. Essas lacunas precisam ser resolvidas antes do cutover.

As garantias de lock continuam restritas a processos participantes no mesmo host e
filesystem local com `mkdir` e rename atômicos. Nenhum comportamento desta etapa protege
o store operacional enquanto os writers legados não adotarem o repository.
