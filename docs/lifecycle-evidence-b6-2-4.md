# B6.2.4 — Contrato isolado de evidências lifecycle

## Escopo e resultado

`lib/governance/lifecycleEvidence.mjs` contém contrato versionado, emissor lógico puro, validador e classificação de retry. O módulo não importa Store, rota, cliente MQTT/OPC UA, rede ou runtime operacional. O emissor produz exclusivamente `BACKEND_ACCEPTED`; não existe emissor de confirmação física.

A prontidão operacional é deliberadamente `BLOCKED`: o sistema ainda não oferece uma fonte autorizada, durável e totalmente correlacionada de resultado de transição, confirmação de comunicação ou observação física.

## Contrato v1.0

Cada registro contém `schemaVersion`, `evidenceId`, `transitionId`, `cpsId`, `plugEventId`, `plugCycleId`, `profileId`, `operation`, `phase`, `previousState`, `resultingState`, `outcome`, `confirmationLevel`, `source`, `authorityReceipt`, `occurredAt`, `receivedAt`, `correlationId`, `commandId`, `evidenceReference` e `contentHash`.

Os níveis não são intercambiáveis:

| Nível | Resultado | Significado |
| --- | --- | --- |
| `BACKEND_ACCEPTED` | `ACCEPTED` | O componente backend autorizado aceitou/registrou a transição lógica. Não prova envio, ACK ou alteração física. |
| `COMMUNICATION_ACK` | `ACKNOWLEDGED` | Um ACK correlacionado foi registrado. Não prova que o estado físico desejado foi atingido. |
| `PHYSICAL_STATE_CONFIRMED` | `COMPLETED` | Uma fonte de observação física autorizada confirmou o estado. Não é emitido por este módulo. |

Os dois últimos níveis podem ser validados quando recebidos de uma fonte cujo verificador server-side reconhece a origem; sua presença em JSON não constitui prova por si só. A política de nível mínimo é obrigatória e injetada por quem chama o validador.

`source` é uma identificação declarativa, não uma credencial. A confiança vem do verificador server-side injetado, que deve retornar recibo verificável vinculado à origem e permissão. Nenhum campo enviado pelo frontend deve ser usado como prova.

## Emissão, integridade e idempotência

`createBackendLifecycleEvidence({ verifyTransitionResult, now }).issue(result, expectedIdentity)` só aceita resultado tipado `LIFECYCLE_TRANSITION_RESULT`, identidade completa igual à esperada, ID estável de transição, estados anterior/resultante, correlação do ciclo, referência de persistência/hash e recibo de autoridade. Booleano, timestamp ou HTTP 2xx isolado são insuficientes.

O `contentHash` é SHA-256 da representação canônica do payload, excluindo `evidenceId` e `contentHash`; `evidenceId` deriva do `transitionId` e `contentHash`. A referência também exige SHA-256. O hash detecta divergência/integridade, mas não autentica o produtor: isso depende do verificador e do armazenamento durável.

`classifyLifecycleEvidenceRetry(index, candidate)` retorna `IDEMPOTENT` somente se todo registro com aquele `transitionId` tiver o mesmo `evidenceId` e hash. Reutilização divergente do ID é conflito. O validador rejeita identidade de ciclo antiga, operação/fase incorreta, transição fora de ordem, timestamps inválidos, origem não verificada, hash divergente e nível abaixo da política. Ausência de evidência não deve chamar o avanço do lifecycle.

## Integração futura (não implementada)

1. O proprietário server-side do lifecycle precisa produzir um resultado de transição durável depois do commit lógico, contendo os quatro identificadores, estado anterior/resultante, `transitionId` estável e referência/hash do registro autoritativo. O código atualmente auditado não fornece este contrato completo.
2. O componente emissor deve ter identidade de serviço autenticável; o verificador deve validar essa identidade e a permissão `lifecycle.plug.record` ou `lifecycle.unplug.record`. A aceitação backend não deve ser promovida a confirmação física.
3. Persistir resultado e evidência atomicamente com a transição, ou usar outbox transacional no mesmo armazenamento autoritativo. Uma escrita separada deixa janela de falha entre transição e evidência; nesse caso, reconciliar pelo `transitionId` no registro autoritativo, nunca inferir sucesso por timeout/retry.
4. Usar índice único durável para `transitionId` e vincular cada transição a exatamente um `plugCycleId`/perfil. Se a mesma transição surgir com identidade divergente, bloquear e reconciliar; não reassociar.
5. Na inicialização, recuperar evidências do armazenamento autoritativo, validar hashes/recibos/correlação e reconstruir checkpoints. `RESERVED` permanece pendente sem evidência válida; inconsistência ou resultado ambíguo vai para `FAILED`/reconciliação explícita. Não liberar por TTL.
6. O checkpoint da governança só pode avançar após validar a evidência esperada. `BACKEND_ACCEPTED` pode satisfazer apenas política que explicitamente aceite nível backend; requisitos de comunicação/físicos demandam as respectivas fontes reais.

Para provar `COMMUNICATION_ACK`, será necessário ACK persistido e correlacionado por `commandId`/`transitionId`/ciclo. Para `PHYSICAL_STATE_CONFIRMED`, será necessária telemetria observacional confiável, autenticada e vinculada ao mesmo ciclo; comando enviado ou resposta de escrita não basta.

## Limitações

- Não existe persistência nesta entrega; a classificação de retry recebe índice fornecido pelo chamador.
- Não foi conectado a Plug, Unplug, Repository, outbox ou checkpoints.
- O recibo e as evidências de níveis superiores nos testes são fixtures de verificador simulado, não alegações operacionais.
- Ainda não há garantia de durabilidade, unicidade global entre processos ou confirmação física no runtime.
- B6.3/cutover permanece bloqueada até existir fonte autoritativa real, persistência recuperável, autenticação de serviço, política operacional explícita e testes de falha/recuperação dessa integração.
