# B6.2.1 — Harness server-side isolado de governança

## Resultado e limite

O harness simula contratos HTTP sem iniciar servidor e sem importar rotas, `governanceStore.js`, Play-gate operacional ou serviços externos. Ele não é uma integração operacional. A readiness permanece `BLOCKED`.

## Modos

### `SHADOW_READ_ONLY`

Aceita somente `SHADOW_COMPARE`. Os documentos e projeções são fornecidos explicitamente ao comparador. O modo rejeita Repository, adaptadores, providers e qualquer operação de escrita.

### `ISOLATED_TRANSACTIONAL_TEST`

Exige adaptadores injetados e prova de caminho. O arquivo do Repository deve:

- coincidir com o `storePath` declarado;
- estar dentro de `temporaryRoot`;
- ter raiz real sob `os.tmpdir()`;
- não ser symlink nem escapar por um diretório intermediário.

Não há caminho default. O harness não inicializa nem migra Store.

## Contrato de requisição e resposta

Uma requisição simulada usa `{ operation, params, body }`. A resposta usa `{ status, headers, body }`; `body` preserva o envelope legado `{ ok, ...payload }` e adiciona correlação e a próxima revisão esperada.

| Operação | Contrato relevante |
|---|---|
| `PLUG` | `cpsId`, `plugEventId`, identidade AAS/funcional e `expectedRevision`; retorna `activeProfile`, `governanceStatus`, `plugEventId`, `plugCycleId`, `profileId` e próxima revisão |
| `ACTIVATE_PLUG` | quatro IDs, CAS e evidência `plug` obtida do provider |
| `APPROVE_PROFILE` / `REJECT_PROFILE` | CPS, ciclo e perfil esperados, CAS e autorização obtida no servidor |
| `UPDATE_POLICIES` | identidade atual, CAS, políticas e autorização server-side |
| `PLAY_GATE` | ciclo/perfil esperados e fase; retorna HTTP 409 ao bloquear e 200 ao permitir |
| `UNPLUG` | quatro IDs, CAS e evidência `unplug` correlacionada |
| `CREATE_GOVERNED_ACTION` | identidade, CAS e descrição da ação; apenas persiste ação pendente |
| `DECIDE_GOVERNED_ACTION` | identidade, CAS, decisão e autorização; aprovação produz `effectIntent`, não execução |
| `LIST_OUTBOX` | leitura; retorna `published: false` e nenhum efeito |

Campos como `approvedBy`, `rejectedBy`, `updatedBy` ou `actorType` recebidos no body não formam o principal. A identidade humana vem exclusivamente de `authorizationProvider`.

## Contratos legados inspecionados

- Plug já responde com `ok`, `cpsId`, `plugEventId`, `activeProfile`, `governanceStatus` e estado Plug. O novo contrato adiciona explicitamente ciclo, perfil e revisão.
- Aprovação/rejeição legadas selecionam somente por CPS e aceitam o nome do body. O harness exige identidade ciclo/perfil e principal server-side.
- Políticas legadas selecionam por CPS e aceitam `updatedBy` do body. O harness exige CAS e ignora esse ator não confiável.
- Play-gate legado usa 409 para bloqueio; o harness preserva esse status.
- Unplug legado pode fechar por CPS. O harness não possui essa operação: exige quatro IDs e evidência.
- A decisão legada de ação pode executar efeito no mesmo fluxo. O harness somente persiste decisão e `effectIntent`.

## Providers de teste

Providers são síncronos e explicitamente injetados. Promise é rejeitada, reduzindo o risco de esconder I/O externo no teste.

O provider de autorização deve retornar autenticação confiável, papel `GOVERNANCE_OPERATOR`, provenance server-side e identificador de autenticação. Ausência de autenticação resulta em 401; principal autenticado sem autorização ou contexto não confiável resulta em 403.

O provider lifecycle recebe a identidade esperada e a fase. Sua evidência deve vincular `cpsId`, `plugEventId`, `plugCycleId`, `profileId`, fase, aceite e `transitionId`. Um comando solicitado nunca é usado como evidência confirmada.

## Efeitos externos

O harness não contém cliente HTTP, localhost, MQTT, OPC UA, HCM, dispatcher ou servidor. `effectIntent` e outbox são dados persistidos. Publicação e execução não são operações suportadas.

## Readiness

PASS isolado:

- proteção de paths temporários;
- contratos simulados e correlação;
- retry Plug sem escrita;
- conflitos 409 e CAS;
- autenticação simulada 401/403;
- evidência simulada integral;
- Play-gate projetado;
- Unplug exato e rejeição de Unplug atrasado;
- recuperação por nova instância;
- zero publicação/efeito.

BLOCKED operacional:

- autenticação e autorização reais;
- fonte autoritativa de evidência lifecycle;
- ligação default-off às rotas reais;
- suspensão e substituição conjunta dos writers;
- dispatcher pós-commit;
- topologia de filesystem;
- backup/restauração e janela de cutover.

Não avançar para B6.3 sem avaliação e autorização explícitas.
