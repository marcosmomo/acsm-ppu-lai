# Etapa B6.1 — Preparação segura do cutover

## Estado desta etapa

B6.1 prepara contratos e verificações. Não migra dados, não altera rotas e não autoriza automaticamente B6.2 ou B6.3.

O relatório `audit-active-cycles.mjs` agora mostra `cycle.governanceProfileId`. Sua conclusão foi reclassificada como **pré-validação documental**. Migração simulada e autorização operacional são gates distintos.

## Matriz de integração

| ID | Módulos atuais | Contrato futuro | Estado B6.1 |
|---|---|---|---|
| Plug | rota Plug e `plugPostHandler.mjs` | `reservePlug` → efeito lifecycle → `activatePlug`/`recordPlugFailure` | BLOCKED: não conectado |
| Unplug | rota/handler Plug e `unplugLifecycle.mjs` | `prepareUnplug` → evidência correlacionada → `closeUnplug` | BLOCKED: não conectado |
| Snapshot close | `plugPostHandler.mjs` | remover fechamento apenas por CPS | FAIL: bypass ainda existe |
| Aprovação/rejeição | rotas CPS approve/reject | CAS de perfil/ciclo/revisão + autorização server-side | BLOCKED |
| Políticas | rota CPS | `updatePolicies` com CAS | BLOCKED |
| Ações | check e rotas de decisão | decisão persistida + `effectIntent`; efeito após commit | BLOCKED |
| PPU outbox | rota/handler Plug e writers do Store | Repository + `publicationId`/`attemptId` | BLOCKED |
| Consultas | rotas CPS/profile e `plugStore.mjs` | `getProfile` e projeção correlacionada | BLOCKED |
| Play-gate | rota Play-gate | `ACTIVE` + `APPROVED` + fase compatível | BLOCKED |
| UI | `CPSContext.js` | preservar contrato HTTP, sem Store direto | análise concluída; nenhuma alteração nesta etapa |

O inventário B5 permanece a fonte detalhada de writers/readers. A matriz B6.1 testa que todos os caminhos de writer inventariados aparecem no plano.

## Contratos preparados

### Identidade

Operações de ciclo exigem `cpsId`, `plugEventId`, `plugCycleId` e `profileId`. Decisões sobre perfil podem omitir o evento, mas nunca ciclo ou perfil.

### Compare-and-set

Decisões e commits lifecycle exigem `expectedRevision` inteiro e não negativo. A ausência do valor é erro, não fallback.

### Autorização humana

O contrato aceita somente contexto com autenticação/autorização/trust server-side, proveniência `SERVER_AUTHENTICATION`, papel `GOVERNANCE_OPERATOR`, `authenticationId`, sujeito e timestamp. Campos do frontend não satisfazem o contrato.

### Evidência lifecycle

A evidência deve ser aceita, possuir `transitionId`, fase esperada e repetir exatamente os quatro identificadores do ciclo. Uma evidência válida para outro ciclo é conflito.

### Efeitos externos

O contrato cria somente intenção `PENDING`, com identidade de perfil/ciclo. Não executa REST, HCM, MQTT ou comando físico.

### Evolution

`EVOLUTION` é rejeitado explicitamente como principal escritor. Pode observar por fluxo separado, permanecendo desativado durante cutover.

## Semântica PASS / FAIL / BLOCKED

- `PASS`: evidência verificável existe e a condição foi satisfeita.
- `FAIL`: condição objetiva foi violada, como identidade divergente, módulo ausente ou fechamento apenas por CPS.
- `BLOCKED`: implementação pode estar correta isoladamente, mas falta dependência operacional ou evidência aceita para autorizar cutover.

O resultado global é `FAIL` se houver qualquer FAIL; caso contrário é `BLOCKED` enquanto houver bloqueios; somente todas as verificações em PASS produzem PASS.

## Resultado atual esperado

- PASS: inventário de módulos; correlação dos três perfis; preservação histórica; retry; concorrência; corrupção; rollback; simulação de migração; cobertura conhecida de writers.
- FAIL: fechamento legado durante importação de snapshot chama `closeGovernancePlugCycle(cpsId)`.
- BLOCKED: suspensão real de writers; autenticação server-side; autoridade das evidências lifecycle; dispatcher pós-commit; topologia local verificada; backup/restauração operacional.

Logo, B6.1 não autoriza cutover.

## Gates futuros

### B6.2 — Integração ainda desativada

- Remover o bypass de fechamento por CPS no novo caminho.
- Criar composition root server-side com Repository, fachada e adaptadores injetados.
- Adaptar todos os writers/readers atrás de flag server-side default-off.
- Implementar autenticação real e origem autoritativa de evidência.
- Preparar dispatcher pós-commit, ainda desativado.
- Executar testes sombra/diferenciais sem escrita operacional.

### B6.3 — Janela de cutover

- Aprovação formal e janela.
- Suspensão e drenagem comprovadas de todos os writers.
- Backup com hash e restauração ensaiada.
- Migração dos três ciclos com evidências revisadas.
- Troca conjunta, nunca operação mista.
- Validação pós-cutover antes de habilitar efeitos.
- Rollback sem sobrescrever novas escritas.
