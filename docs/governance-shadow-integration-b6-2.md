# Etapa B6.2 — Integração shadow/read-only isolada

## Resultado

O caminho transacional completo pode ser composto explicitamente em modo shadow, mas permanece desligado por padrão e não está conectado ao runtime. O estado de prontidão continua **BLOCKED**, não PASS.

## Feature flags isoladas

- `TRANSACTIONAL_GOVERNANCE_SHADOW_ENABLED`: default `false`.
- `TRANSACTIONAL_GOVERNANCE_WRITES_ENABLED`: reconhecida apenas para bloquear; B6.2 nunca habilita escrita.
- `EVOLUTION_ENABLED`: reconhecida apenas para bloquear; B6.2 mantém Evolution desligado.

Sem shadow explícito, nenhuma factory é chamada, nenhum Repository/fachada/adaptador é construído, nenhum arquivo é criado e nenhuma comparação inicia. As flags não foram adicionadas à configuração operacional nem às rotas.

## Composition root

`createGovernanceShadowComposition` recebe explicitamente configuração, caminho absoluto candidato e factories injetáveis de Repository, fachada e adaptadores.

Modos:

- `disabled`: retorna marcadores inertes e referências nulas.
- `shadow`: compõe os três componentes, expõe somente leitor e stubs de writer que lançam `GOVERNANCE_SHADOW_WRITE_FORBIDDEN`.

O construtor do Repository não inicializa o Store. Um arquivo candidato ausente continua ausente; a primeira leitura falha fechada com `GOVERNANCE_STORE_NOT_FOUND`.

O modo de escrita não existe nesta etapa. Pedir a flag de escrita ou Evolution bloqueia a composição antes de qualquer factory.

## Snapshot observacional

`projectSnapshotForGovernance` nunca chama fechamento nem produz mutação. Um ativo observado como `unplug` ou `unplugged` recebe:

- `observationOnly: true`;
- `governanceMutation: null`;
- `closureStatus: CORRELATED_UNPLUG_REQUIRED`;
- lista dos quatro identificadores obrigatórios;
- `effects: []`.

`prepareShadowUnplugCommand` somente prepara um comando. Exige identidade completa, `expectedRevision` e evidência Unplug aceita contendo os mesmos IDs. Evidência ausente, antiga ou divergente falha; nenhuma dessas condições fecha ciclo.

O fechamento legado por CPS continua no caminho operacional, que não foi alterado. O novo caminho não reproduz esse comportamento.

## Comparação shadow

`compareGovernanceShadows` recebe documentos e projeções já fornecidos pelo chamador. Não abre arquivos, não consulta Store operacional e não escreve nos objetos.

Compara:

- perfis ativos e identidade;
- versão e aprovação;
- políticas;
- `profileVersions`;
- histórico;
- ações pendentes;
- outbox;
- `plugCycles`;
- resultado do Play-gate.

Um `plugCycles` novo, ausente no legado, é diferença `EXPECTED` somente se estiver correlacionado ao perfil candidato. Decisão, política, coleção histórica, outbox, identidade ou Play-gate divergentes são `INCOMPATIBLE`.

## Inventário runtime

O inventário classifica:

- writers e readers do Store;
- lifecycle Plug/Unplug;
- fechamento implícito;
- snapshot import/projection;
- decisões humanas e políticas;
- execução de ação;
- outbox;
- efeitos HCM;
- Play-gate;
- consumidores HTTP em `CPSContext.js`.

O auditor percorre somente fontes locais e bloqueia qualquer import de `governanceStore` não classificado. O Store operacional é classificado como unidade porque concentra leitura, escrita, HCM, execução de ações e outbox.

## Matriz atual

| Verificação | Estado | Motivo |
|---|---|---|
| Default-off | PASS | Nenhuma construção/arquivo/comparação automática |
| Snapshot sem fechamento no caminho novo | PASS | Projeção pura e sem efeitos |
| Unplug correlacionado | PASS | Quatro IDs, CAS e evidência |
| Comparador read-only | PASS | Objetos permanecem inalterados |
| Diferenças esperadas versus incompatíveis | PASS | Classificação explícita |
| Inventário dos imports | PASS | Nenhum import não classificado |
| Ausência de escrita/efeitos shadow | PASS | Writers falham fechados |
| Persistência/restart/concurrency isolados | PASS | B1–B5 e leitura após reinício |
| Substituição operacional conjunta | BLOCKED | Rotas continuam no legado por requisito |
| Suspensão de writers | BLOCKED | Requer janela operacional |
| Autenticação server-side | BLOCKED | Ainda não integrada |
| Autoridade lifecycle/Unplug | BLOCKED | Ainda não integrada |
| Dispatcher pós-commit | BLOCKED | Ainda não implementado operacionalmente |
| Topologia de filesystem | BLOCKED | Ainda não verificada no deployment |
| Backup/restauração operacional | BLOCKED | Ainda não executado |

## Antes da B6.3

Uma etapa intermediária deverá conectar composition root e comparador atrás de flag default-off, com testes de rota inteiramente injetados, sem ler o Store real. Depois serão necessários autenticação real, provedor de evidência, dispatcher pós-commit, suspensão coordenada, backup e janela formal. Nenhuma flag de escrita deve ser habilitada antes desses gates.
