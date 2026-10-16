# Etapa B4 — Adaptadores transacionais isolados

## Escopo

`TransactionalGovernanceAdapters` traduz os contratos atuais para a fachada B3. O módulo recebe uma fachada pronta; não importa `governanceStore.js`, não conhece caminho de Store e não executa lifecycle, REST, MQTT, HCM ou comandos físicos.

## Mapa dos contratos legados

| Escritor/leitor atual | Contrato atual | Efeito ou risco atual | Adaptador B4 |
|---|---|---|---|
| `createGovernanceProfileForPlug(cpsId, cps, { plugEventId })` | perfil/status/versões | pode fechar/substituir ciclo; HCM e escrita direta | `reservePlug` exige evento e identidade AAS/funcional e retorna evento/ciclo/perfil |
| lifecycle após Plug | transição separada | efeito operacional antes/depois de escritores não atômicos | `activatePlug` apenas registra evidência aceita para o mesmo ciclo |
| `approveGovernanceProfile(cpsId, approvedBy)` | decisão e evento PPU | identidade do body não autentica; HCM | `approveProfile` exige perfil/ciclo e contexto server-side confiável |
| `rejectGovernanceProfile(cpsId, rejectedBy)` | rejeição | legado pode repetir rejeição | `rejectProfile` aceita somente perfil pendente ativo |
| `updateGovernanceProfile(cpsId, policies, updatedBy)` | atualiza limites | seleciona perfil apenas por CPS | `updatePolicies` exige CAS de perfil/ciclo e autorização |
| `checkGovernance(request)` | avalia, cria ação e pode executar | mistura decisão, persistência, HCM e efeito | `createGovernedAction` apenas persiste intenção pendente |
| `decideGovernanceAction(actionId, decision, decidedBy)` | decide e pode executar | execução ocorre no mesmo fluxo | `decideGovernedAction` persiste decisão e `effectIntent`; não executa |
| outbox enqueue/published/failed | grava por evento | escritores independentes | adaptadores delegam ao Repository; acknowledgements exigem IDs de tentativa/publicação |
| `closeGovernancePlugCycle(cpsId)` | fecha perfil atual | não correlaciona evento/ciclo/perfil | `prepareUnplug` valida sem escrita; `closeUnplug` exige quatro IDs e evidência aceita |
| `getGovernanceProfile` / Play-gate | perfil por CPS | não prova correlação com ciclo | `projectPlayGate` exige ciclo ACTIVE, perfil APPROVED correlacionado e fase compatível |

## Contratos dos adaptadores

- `reservePlug(input)`: `cpsId`, `plugEventId`, `identity`; `plugCycleId` é opcional. Retorna `plugEventId`, `plugCycleId`, `profileId`, `activeProfile`, `governanceStatus` e `lifecycleEffectRequired`.
- `activatePlug(input)`: quatro IDs e `lifecycleEvidence.accepted === true` com `transitionId`.
- `recordPlugFailure(input)`: quatro IDs, estágio, erro e evidência opcional.
- `approveProfile`, `rejectProfile`, `updatePolicies`: perfil/ciclo esperado e autorização injetada.
- `createGovernedAction`: perfil/ciclo aprovado e dados da ação.
- `decideGovernedAction`: `actionId`, perfil/ciclo esperado, decisão e autorização. Aprovação produz somente `effectIntent` persistida.
- `enqueueOutbox`, `markOutboxPublished`, `markOutboxFailed`, `listOutbox`: não publicam. Publicação exige `publicationId`; falha exige `attemptId`.
- `prepareUnplug`: valida quatro IDs e estado `ACTIVE` ou `FAILED`, sem escrita/efeito.
- `closeUnplug`: quatro IDs e evidência aceita vinculada ao ciclo.
- `getProfile`: projeção compatível de leitura; IDs ausentes em registros históricos não são fabricados.
- `projectPlayGate`: projeção read-only; não chama nem altera o Play-gate.

`actorType: HUMAN`, `approvedBy` ou `rejectedBy` recebidos do cliente não são credenciais. Os testes injetam `{ authenticated: true, authorized: true, trusted: true, subject }`. No cutover, esse objeto deverá ser construído exclusivamente por middleware server-side após autenticação e autorização.

## Falhas e idempotência

- Retry de Plug idêntico é NO_OP sob lock: sem revisão, timestamp, histórico ou outbox adicional.
- Identidade divergente e eventos concorrentes recebem conflito.
- A reserva confirmada sobrevive a reinício; o chamador pode registrar `FAILED` ou fornecer evidência e ativar depois.
- Falha de persistência antes do rename não confirma estado parcial.
- Repetição do mesmo `attemptId` de falha ou `publicationId` de sucesso é NO_OP.
- Evento já publicado não pode voltar a `FAILED`.
- O adaptador não tenta compensar efeito externo; efeitos só podem ocorrer fora do lock, depois do commit.

## Projeção do Play-gate

O futuro gate deve receber `cpsId`, `profileId`, `plugCycleId`, fase lifecycle observada e fase esperada. A passagem requer simultaneamente:

1. ciclo e perfil correlacionados pelos IDs;
2. ciclo e `plugCycleStatus` em `ACTIVE`;
3. perfil em `APPROVED`;
4. fase lifecycle igual à esperada.

Estado `RESERVED`, `FAILED`, `CLOSED`, perfil pendente/negado, identidade antiga ou fase incompatível bloqueiam Play.

## Cutover conjunto (não executado)

### Inventário de arquivos a alterar futuramente

- `app/api/acsm/plug/route.js` e `lib/acsm/plugPostHandler.mjs`.
- `lib/acsm/unplugLifecycle.mjs` e qualquer chamador direto de `closeGovernancePlugCycle`.
- rotas em `app/api/governance/cps/[cpsId]` para perfil, políticas, aprovação, rejeição e Play-gate.
- rotas `app/api/governance/check` e `app/api/governance/action/[actionId]`.
- worker/publicador PPU e seus writers de sucesso/falha.
- `lib/acsm/plugStore.mjs`, que lê diretamente o Store legado.
- todo import restante de `services/governance/governanceStore.js`; o arquivo deve ficar read-only ou ser retirado somente após a troca conjunta.

### Sequência segura

1. Manter Evolution desativado e impedir novos writers de Plug, Unplug, governança, ações e outbox.
2. Esperar requisições em voo terminarem e adquirir exclusivamente o lock de migração definido para o cutover.
3. Fazer backup consistente do JSON e registrar hash, tamanho, revisão lógica e permissões. Não apagar o original.
4. Validar estritamente o documento; corrupção ou ambiguidade aborta o cutover.
5. Reconciliar os três ciclos ativos individualmente contra lifecycle/AAS e evidência operacional autorizada. Criar IDs somente a partir de fonte autoritativa; nunca inventar IDs para históricos.
6. Ciclo atual inequívoco vira `ACTIVE`; transição incompleta vira `RESERVED` ou `FAILED`. Mais de um candidato por CPS é bloqueio de migração, não fechamento automático.
7. Produzir candidato em diretório isolado, validar schema, invariantes, contagens e hashes dos registros históricos.
8. Executar dry-run dos adaptadores e testes de concorrência sobre cópia sanitizada do candidato.
9. Trocar todos os writers e readers correlacionados na mesma janela. Não permitir operação mista entre escritor legado e Repository.
10. Liberar escrita somente após health check read-only, revisão monotônica e teste de lock entre processos.

### Rollback

- Interromper novamente todos os writers antes de reverter.
- Se nenhuma escrita nova foi aceita, restaurar o backup verificado.
- Se houve escrita nova, não sobrescrever: preservar os dois documentos, bloquear operação e executar reconciliação auditável.
- Reverter código de todos os writers/readers como uma unidade; nunca manter metade no legado e metade no Repository.
- Manter Evolution desativado antes, durante e após rollback.

### Locks órfãos e `FAILED`

Lock não expira por TTL. Um procedimento administrativo deve verificar PID/host, inexistência de writer, integridade do Store e backup antes de remover lock órfão. Ciclos `FAILED` permanecem bloqueantes até uma operação futura de reconciliação autenticada, com evidência e histórico; não são fechados automaticamente.

## Bloqueios restantes

- Todos os writers operacionais ainda contornam o Repository e precisam mudar juntos.
- A autenticação/autoridade server-side real ainda não foi ligada aos contextos injetados.
- A obtenção e verificação criptográfica/autoritatitiva das evidências lifecycle e Unplug pertence à integração futura.
- Falta um dispatcher externo de `effectIntent` e outbox com lease/claim multiprocesso; B4 apenas prepara e reconhece eventos.
- NFS, SMB e múltiplos hosts continuam fora da garantia do lock local.
- A reconciliação dos três ciclos ativos requer inspeção autoritativa durante janela de escrita suspensa.
