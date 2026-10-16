# B6.2.8 — Reconciliação do baseline lifecycle (preparação isolada)

## Auditoria das fontes documentadas

Esta auditoria foi limitada ao código e à documentação; não leu `governance-store.json`, AAS operacional, snapshot em memória ou qualquer fonte live.

| Dado | Fonte documentada/código | O que pode afirmar | Limitação para baseline |
|---|---|---|---|
| Lifecycle lógico do backend | `lib/acsm/plugStore.mjs::transitionPlugAssetLifecycle` atualiza `cps.lifecyclePhase` e `cps.lifecycle.currentPhase` no snapshot `globalThis`; retorno contém CPS/fase/estado | A aplicação alterou sua projeção lógica em memória | Sem persistência durável multiprocesso, `transitionId` ou IDs de ciclo/perfil |
| Estado operacional projetado | `plugStore.mjs` também ajusta `operationalState`, `status`, `globalState` e `playEnabled` em alguns caminhos; `plugService.mjs` expõe o snapshot | Projeção para runtime/UI | Não é observação física; snapshot pode ser reiniciado e não é autoridade histórica |
| Estado AAS | Plug handler resolve `asset.cps`/`asset.aas`; o código lê fases lifecycle e `asset.aas.id` | Pode fornecer candidatos de `aasId`, `assetId` ou identidade funcional quando o AAS está carregado | O código não estabelece assinatura, versão do snapshot, autoridade de origem ou ligação estável entre toda observação AAS e o ciclo ativo |
| Ciclo e perfil ativos | `services/governance/governanceStore.js` usa `profileId`, `profileVersion`, `plugEventId`, `plugCycleId`, `plugCycleStatus`, `plugStartedAt`, `plugClosedAt`, `approvedAt/By` e `status`; `getActiveGovernanceProfile` projeta o perfil ativo | Identidade e aprovação do registro de governança | Não prova fase lifecycle nem execução física; escrita legada pode fechar por CPS |
| Último timestamp | Snapshot guarda `timestamp`; handlers passam timestamp da solicitação; perfil guarda início/fechamento | Timestamp de snapshot ou operação de aplicação | Não é, por si, timestamp durável de transição aceita. Não existe registro lifecycle atual com `transitionId` e `occurredAt` correlacionados |
| Confirmação física | Nenhuma fonte confiável correlacionada demonstrada na auditoria B6.2.3/B6.2.6 | Nada sobre estado físico atual | `BACKEND_ACCEPTED`, retorno HTTP ou snapshot não devem ser promovidos a confirmação física |

As correlações legadas reportadas em auditoria anterior foram: cpslai1 `GOV-CPSLAI1-215` / `cpslai1-plug-v215`; cpslai2 `GOV-CPSLAI2-103` / `cpslai2-plug-v103`; cpslai3 `GOV-CPSLAI3-113` / `cpslai3-plug-v113`. São referências de auditoria anterior, não foram revalidadas contra o Store nesta etapa e não estabelecem o estado lifecycle.

## Contrato v1.0 proposto

O validador `lib/governance/lifecycleBaseline.mjs` espera um objeto sem mutação com:

```json
{
  "schemaVersion": "1.0",
  "cpsId": "...",
  "plugEventId": "...",
  "plugCycleId": "...",
  "profileId": "...",
  "lifecycleState": "plug | play",
  "governanceStatus": "PENDING_APPROVAL | APPROVED | DENIED",
  "source": { "system": "...", "component": "...", "recordId": "...", "domain": "BACKEND_LOGICAL | COMMUNICATION | PHYSICAL" },
  "observedAt": "ISO-8601 UTC",
  "verifiedAt": "ISO-8601 UTC",
  "provenance": { "kind": "...", "issuer": "...", "verificationId": "..." },
  "evidenceReference": { "recordId": "...", "sha256": "..." },
  "confirmationLevel": "BACKEND_ACCEPTED | COMMUNICATION_ACK | PHYSICAL_STATE_CONFIRMED"
}
```

`governance` é uma projeção injetada separadamente, com os mesmos quatro identificadores, `cycleState`, `profilePlugCycleStatus` e `governanceStatus`. A política de fontes confiáveis, `maxAgeMs` e `verifyProvenance` também são injetados. O verificador é síncrono e deve validar o recibo da origem contra fonte, `verificationId` e hash do conteúdo; ausência ou falha do verificador resulta em BLOCKED. `source.domain` determina o único nível de confirmação compatível; o validador nunca converte um nível em outro. A referência/hash passam por verificação estrutural neste módulo; o verificador confiável deve autenticar o hash contra o artefato referenciado.

Resultados: `PASS` significa consistente **sob a política injetada**, não autorização operacional; `FAIL` indica identidade/estado/hash estrutural incompatível; `BLOCKED` indica ausência, obsolescência, fonte não confiável ou política necessária ausente. Não existe fallback por CPS, valor default de lifecycle ou aprovação inferida.

## Readiness por CPS

| CPS | Correlação legado reportada anteriormente | Baseline lifecycle confiável | Readiness |
|---|---|---|---|
| cpslai1 — Distribution/Conveyor Station | Reportada: `GOV-CPSLAI1-215`, `cpslai1-plug-v215`; não revalidada nesta etapa | Não há evidência de transição durável, fonte autorizada/assinada nem timestamp de transição correlacionado | **BLOCKED** |
| cpslai2 — Joining Station | Reportada: `GOV-CPSLAI2-103`, `cpslai2-plug-v103`; não revalidada nesta etapa | Mesma lacuna | **BLOCKED** |
| cpslai3 — Sorting Station | Reportada: `GOV-CPSLAI3-113`, `cpslai3-plug-v113`; não revalidada nesta etapa | Mesma lacuna | **BLOCKED** |

Nenhum ciclo foi criado, alterado, fechado ou migrado. Não se conclui que qualquer CPS esteja fisicamente em `plug` ou `play`.

## Testes isolados

`test/lifecycle-baseline.test.mjs` testa baseline válido com allowlist simulada; baseline ausente; falta de proveniência/hash/política; divergência de identidade/estado; ciclo não ativo; estado obsoleto; fonte não confiável; confirmação incompatível; timestamps; ciclos/eventos duplicados; CPS faltante; revalidação após serialização/reinício lógico; e separação do nível físico. Usa objetos de fixture e um único arquivo temporário sanitizado. Resultado: 8 testes aprovados. O mock de confiança é apenas teste, não identidade ou fonte de produção.

## Provisionamento supervisionado futuro (não executado)

1. Nomear o proprietário server-side de cada fonte e aprovar uma allowlist por domínio de estado. A extração deve ser somente leitura, identificada, assinada ou autenticável, e fornecer conteúdo/hashes verificáveis. Não usar formulário de frontend como evidência.
2. Suspender e drenar todos os escritores legados durante a janela autorizada; obter backup consistente e hash antes de qualquer candidato de migração. Sem suspensão/backup/topologia verificados, abortar.
3. Extrair por CPS o estado lógico do backend, a fase observacional AAS se disponível e o registro de governança. Preservar os quatro IDs do ciclo existente, perfil/versão/decisão e fonte/timestamps originais. Divergência entre lifecycle, AAS, perfil ou ciclo resulta em `BLOCKED` para revisão humana; não escolher uma fonte silenciosamente.
4. Exigir um registro autoritativo da última transição, com `transitionId`, estado anterior/resultante, `occurredAt`, referência/hash e os quatro IDs. Se não existir, a equipe autorizada deve tomar uma nova observação verificável e registrá-la como observação feita agora — nunca como evento histórico retroativo. Se não houver fonte adequada, permanecer bloqueado.
5. Para baseline apenas lógico, exigir no mínimo prova backend autorizada; para declarar comunicação ou físico, exigir fonte correspondente independente. Um snapshot de AAS/HTTP não prova físico.
6. Pré-validar as três linhas em fixtures/cópia sanitizada; exigir exatamente um ciclo ativo e um perfil por CPS, nenhuma ID duplicada ou ausente, decisão preservada e resultado PASS sob políticas assinadas. Qualquer BLOCKED/FAIL aborta o lote inteiro.
7. Só numa etapa futura formalmente autorizada, migrar os registros de baseline para o agregado transacional junto aos mesmos ciclos já existentes, sem nova reserva/perfil e sem alterar estado de aprovação. Revisar diff e hashes antes de permitir escrita. Fazer rollback apenas se nenhuma escrita transacional nova tiver ocorrido; caso contrário parar e reconciliar sem sobrescrever dados novos.

O protocolo não constitui autorização de cutover. B6.3 depende de autoridade operacional de evidência, autenticação/autorização real, topologia, backup/restauração ensaiados, suspensão comprovada de escritores e aprovação formal da janela.
