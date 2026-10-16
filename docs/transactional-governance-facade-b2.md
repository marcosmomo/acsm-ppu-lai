# Etapa B2 — Fachada de governança transacional isolada

`TransactionalGovernanceFacade` recebe um repository injetado e persiste exclusivamente
por `repository.transact()`. Não conhece caminhos, não importa o store operacional e não
faz I/O de filesystem, HCM, REST, MQTT, Evolution, OPC UA ou execução física.

## Operações reproduzidas

- criação idempotente de perfil Plug pendente, com IDs explícitos de evento e ciclo;
- fechamento exato de perfil/ciclo com evidência;
- edição validada de políticas pendentes;
- aprovação e rejeição humanas de perfil pendente;
- histórico limitado às 500 entradas mais recentes;
- criação e decisão de ações pendentes;
- enqueue e atualização de outbox PPU.

Uma decisão aprovada de ação governada persiste somente `effectIntent` e retorna esse
efeito preparado depois do commit. Nenhum comando é executado. Aprovação/rejeição do
perfil CPS-LAI-01 prepara o envelope PPU e o grava na outbox dentro da mesma transação,
mas não o publica.

## Divergências intencionais do store antigo

- um Plug diferente nunca fecha automaticamente o perfil ativo;
- fechamento, edição e decisão exigem `profileId` e `plugCycleId` exatos;
- aprovação e rejeição exigem ator explícito com `type: HUMAN`;
- rejeição, assim como aprovação, aceita somente perfil `PENDING_APPROVAL` e ativo;
- ações já decididas não podem receber decisão contraditória;
- nenhuma ação governada é executada dentro ou depois da transação pela fachada;
- erros não são convertidos em store vazio.

Dados legados são preservados, inclusive versões sem IDs. Eles podem ser lidos, mas não
podem ser escolhidos implicitamente como alvo de uma nova mutação identificada.

## Limite de B2

A fachada apenas valida uma entrada já existente em `plugCycles`, quando houver; ela não
cria nem transiciona reservas. O fechamento do perfil também não fecha o registro de
ciclo. Essa atomicidade pertence à B3. Identidade humana ainda é um valor de domínio
injetado; autenticação e autorização reais continuam responsabilidade da futura borda.

## Mapa resumido do legado

O store atual possui writers separados para perfil Plug, fechamento, políticas,
aprovação/rejeição, checks e actions, histórico e outbox. HCM e execução REST ocorrem
misturados ao fluxo de persistência. A fachada separa estado confirmado, evento/outbox
persistido e `effectIntent`, deixando todo efeito externo fora do lock.
