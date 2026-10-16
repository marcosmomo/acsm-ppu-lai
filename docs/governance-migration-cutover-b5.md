# Etapa B5 — Migração e cutover simulados

## Escopo e componentes

- `GovernanceMigrationPlanner`: lê uma fonte absoluta de forma estrita e produz relatório e candidato em memória. Nunca escreve na fonte.
- `GovernanceCutoverSimulator`: aceita somente fonte e destino filhos de um workspace temporário explícito. Simula suspensão, backup, publicação, verificação e rollback.
- `LEGACY_GOVERNANCE_ACCESS_INVENTORY`: inventário versionado de writers, readers e consumidores do contrato HTTP legado.

Nenhum componente importa `services/governance/governanceStore.js`, Evolution ou transporte externo.

## Regras de migração

1. JSON inválido, truncado ou estruturalmente inconsistente aborta.
2. `profiles`, `profileVersions`, `pendingActions`, `history`, `ppuOutbox` e campos desconhecidos são clonados sem reinterpretação.
3. Perfis históricos sem `profileId` são preservados e geram aviso; IDs não são fabricados.
4. Versões ou `profileId` duplicados no mesmo CPS abortam.
5. Mais de um perfil com ciclo `ACTIVE`, `RESERVED` ou `FAILED` no mesmo CPS aborta.
6. Um perfil não fechado exige evidência injetada com `cpsId`, `plugEventId`, `plugCycleId`, `profileId` e identidade contendo `aasId` mais `assetId` ou `functionalId`.
7. IDs presentes no perfil precisam coincidir exatamente com a evidência.
8. Migração como `ACTIVE` exige evidência lifecycle aceita com `transitionId`.
9. `RESERVED` e `FAILED` permanecem bloqueantes; nenhum estado é promovido ou fechado por tempo.
10. Status `PENDING_APPROVAL`, `APPROVED` ou `DENIED` é preservado. Não existe aprovação automática.
11. `plugCycles` já existentes são preservados e validados. Um ciclo novo só é criado para o perfil não fechado inequivocamente correlacionado.
12. O candidato recebe somente metadados estruturais ausentes (`repositorySchemaVersion`, `revision`, `plugCycles`).

## Simulação

O executor exige `writerSuspended: true`, mas isso é apenas uma asserção lógica de teste. Na execução real B6 será necessário suspender e provar a suspensão dos writers.

Sequência simulada:

1. Adquirir lock exclusivo de cutover, sem TTL.
2. Calcular SHA-256 da fonte.
3. Criar backup exclusivo, executar `fsync` e comparar SHA-256.
4. Pré-validar e produzir candidato.
5. Recalcular hash da fonte imediatamente antes da publicação.
6. Inicializar o Repository no destino novo, sob seu próprio lock e escrita atômica.
7. Reabrir e validar o documento confirmado.
8. Executar adaptadores somente contra o candidato.
9. Verificar novamente fonte, backup, destino, schema e revisão.

Um writer concorrente altera o hash e aborta antes da publicação. Dois processos não conseguem inicializar o mesmo destino: o lock de cutover ou a existência do destino bloqueia o segundo.

## Rollback

Rollback automático é permitido somente se:

- a revisão atual é igual à revisão inicial do candidato; e
- o hash atual do destino é igual ao hash confirmado imediatamente após a publicação.

Nesse caso o candidato é arquivado, não apagado, e o backup é restaurado para um novo caminho de simulação. Se qualquer escrita ocorreu, o rollback destrutivo é bloqueado. B6 deverá preservar os dois lados e executar reconciliação auditável.

## Inventário de acesso legado

| Concern | Caminhos | Substituição futura |
|---|---|---|
| Plug, perfil e histórico | `app/api/acsm/plug/route.js`, `lib/acsm/plugPostHandler.mjs` | `reservePlug`, efeito externo, `activatePlug`/`recordPlugFailure` |
| Unplug | rota/handler Plug e `lib/acsm/unplugLifecycle.mjs` | `prepareUnplug`, evidência externa, `closeUnplug` |
| Snapshot que fecha perfil | loop de snapshot em `plugPostHandler.mjs` | proibir close por CPS; exigir transição correlacionada |
| Aprovação/rejeição | rotas `governance/cps/[cpsId]/approve` e `reject` | adaptadores com autorização server-side e CAS |
| Políticas | rota `governance/cps/[cpsId]` | `updatePolicies` |
| Check/histórico/ação | `governance/check` | avaliador puro + `createGovernedAction` |
| Decisão/execução de ação | rotas de approve/reject da ação | `decideGovernedAction`; dispatcher somente pós-commit |
| Enqueue PPU | Plug route/handler | operação atômica da fachada ou `enqueueOutbox` |
| Published/failed PPU | exports de `governanceStore.js`; atualmente sem caller operacional encontrado | adaptadores com `publicationId`/`attemptId` |
| Perfil/versões | rotas de perfil e CPS | `getProfile` |
| Play-gate | rota Play-gate | `projectPlayGate` |
| Perfil ativo em snapshot | rota/handler Plug e `plugStore.mjs` | projeção correlacionada do Repository |
| Consumidores UI | `context/CPSContext.js` | manter contrato HTTP; não acessar Store diretamente |

`ensureGovernanceProfile` é atualmente uma leitura compatível, apesar do nome. O writer adicional perigoso encontrado é o fechamento implícito durante importação de snapshot Unplug.

## Critérios objetivos de aborto B6

- Não foi possível suspender todos os writers e jobs em voo.
- Topologia usa múltiplos hosts, NFS ou SMB sem coordenação transacional apropriada.
- Backup não possui hash idêntico ou não pode ser restaurado em ensaio.
- JSON inválido ou schema incompatível.
- Duas versões/ciclos não fechados no mesmo CPS.
- Um dos três ciclos existentes não possui quatro IDs e identidade AAS verificável.
- Estado `ACTIVE` sem evidência lifecycle aceita.
- Contagens ou hashes lógicos de histórico, ações ou outbox divergem.
- Lock existente sem verificação administrativa segura.
- Evolution não está comprovadamente desativado.
- Autenticação server-side e origem das evidências não estão disponíveis.
- Algum import/escritor legado permanece habilitado na topologia de cutover.

## Checklist de autorização B6

- [ ] Aprovação formal da janela e responsáveis por go/no-go e rollback.
- [ ] Inventário de processos, réplicas, jobs e hosts confirmado.
- [ ] Filesystem local compartilhado no mesmo host, ou substituição por coordenação transacional.
- [ ] Evolution desativado e verificado.
- [ ] Todos os writers identificados suspensos; requisições em voo drenadas.
- [ ] Backup consistente criado, `fsync` concluído e SHA-256 registrado fora do diretório de trabalho.
- [ ] Restauração do backup ensaiada em cópia isolada.
- [ ] Evidências autoritativas dos três ciclos atuais revisadas por operador autorizado.
- [ ] Documento candidato validado sem avisos bloqueantes.
- [ ] Contagens de perfis, versões, histórico, ações e outbox comparadas.
- [ ] Nenhuma aprovação, rejeição, fechamento ou ID histórico fabricado.
- [ ] Todos os writers e readers preparados para substituição conjunta.
- [ ] Middleware real de autenticação e autorização pronto; nenhum `actorType` de frontend confiado.
- [ ] Evidências lifecycle/Unplug originadas e verificadas server-side.
- [ ] Dispatcher pós-commit definido, mas mantido desativado até validação do Store.
- [ ] Teste de lock entre todos os processos participantes aprovado.
- [ ] Plano para locks órfãos exige PID/host, backup e confirmação de ausência de writer; sem TTL.
- [ ] Procedimento de reconciliação de `RESERVED`/`FAILED` aprovado; sem fechamento automático.
- [ ] Critérios pós-cutover: revisão monotônica, schema válido, hashes/contagens preservados, Play bloqueado quando apropriado e nenhuma decisão automática.
- [ ] Rollback distingue “sem novas escritas” de “com novas escritas”; o segundo nunca sobrescreve dados.
- [ ] Observabilidade e trilha de auditoria da janela disponíveis.

## Lacunas restantes

- A suspensão do simulador é uma precondição declarativa, não controla processos reais.
- Autenticação, evidência lifecycle e dispatcher externo não foram implementados.
- O lock continua limitado a processos participantes no mesmo filesystem local.
- A identidade real dos três ciclos ativos não foi lida nem inferida nesta etapa.
- Não existe reconciliação automática de estados `FAILED` ou locks órfãos.
