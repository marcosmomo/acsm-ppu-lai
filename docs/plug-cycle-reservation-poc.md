# PoC isolada de reserva de ciclos Plug

## Escopo e decisão

`PlugCycleReservationStore` não é importado por `POST /api/acsm/plug`, pelo store de
governança, Play-gate ou Evolution. A PoC usa um journal JSON próprio somente quando
um chamador fornece explicitamente `filePath`; os testes usam `os.tmpdir()`. Portanto,
ela não cria nem altera dados operacionais.

O lock é adquirido por criação atômica de um diretório ao lado do journal. Todo ciclo
de leitura–validação–persistência ocorre sob esse lock. O rename é apenas a etapa final
da persistência e não é usado como mecanismo de concorrência. O arquivo temporário é
sincronizado (`fsync`) antes do rename. Um lock remanescente de crash nunca expira nem é
removido automaticamente; a API exige verificação externa explícita para liberá-lo.

Garantia real: exclusão mútua entre processos que usam este componente, no mesmo host e
em filesystem local que ofereça `mkdir`/`rename` atômicos. Não há garantia para NFS,
SMB não configurado para essas semânticas, writers legados que ignorem o lock, perda de
energia sem garantia de flush do diretório ou replicação entre hosts.

## Estados e invariantes

- `RESERVED`: identidade e `plugCycleId` foram persistidos antes de efeitos externos.
- `ACTIVE`: o perfil associado foi criado e sua versão pode ser registrada.
- `FAILED`: houve efeito parcial; continua bloqueando novo Plug até reconciliação segura.
- `CLOSED`: Unplug verificado fechou exatamente o trio CPS/evento/ciclo.

O mesmo `plugEventId` recupera o registro existente. Reuso por outro CPS ou por outra
identidade gera conflito. Estados `RESERVED`, `ACTIVE` e `FAILED` bloqueiam outro evento
para o CPS. Não existe transição de aprovação, aprovação implícita, TTL ou limpeza por
idade. Metadados de versão de governança são preservados e não são reescritos no close.

## Análise do fluxo atual e pontos de falha

O `governanceStore.js` lê o JSON inteiro, modifica em memória e grava por arquivo
temporário + rename, sem lock compartilhado. Processos podem ler a mesma revisão e o
último rename perde a escrita anterior. `createGovernanceProfileForPlug()` é idempotente
apenas quando encontra o mesmo evento; para evento novo ele fecha o perfil `ACTIVE` e
cria outra versão. O lock `globalThis` do handler só é habilitado com Evolution e não
coordena processos.

Depois da criação do perfil ainda podem falhar: transição do snapshot de lifecycle,
preparação/gravação do outbox PPU, captura/registro do observer Evolution e a própria
resposta. Atualmente o outbox/observer degradam para erro observacional, mas perfil e
snapshot não constituem uma transação. O Unplug fecha por CPS (`closeGovernancePlugCycle`)
sem exigir `plugCycleId`; assim uma mensagem atrasada pode fechar o ciclo que estiver
ativo naquele momento. Retries dependem da busca por `plugEventId` no JSON e estão
sujeitos ao mesmo race de read–modify–write.

## Integração mínima proposta (não executada)

1. No início do Plug, antes de perfil/snapshot/outbox, chamar `reserve` com CPS, evento e
   identidade AAS. Conflito retorna HTTP 409; retry usa o mesmo `plugCycleId`.
2. Criar o perfil de governança referenciando esse `plugCycleId`, sem permitir que a
   função feche um ciclo ativo. Após persistência confirmada, chamar `activate` com ID e
   versão do perfil. Qualquer falha posterior chama `recordFailure` e não libera o ciclo.
3. Propagar `plugEventId` e `plugCycleId` até o Unplug. Somente após verificar que a
   transição real corresponde ao ciclo, chamar `close` com evidência auditável.
4. Um reconciliador lê `RESERVED`/`FAILED`, consulta estado real e decide explicitamente
   entre ativar, fechar ou manter bloqueado. Nunca decidir apenas por idade.

Para produção distribuída, a alternativa preferível é uma transação no armazenamento
operacional existente: tabela/coleção de ciclos com unicidade global de `plugEventId`,
unicidade/índice parcial de um estado bloqueante por CPS, compare-and-set de estado e
outbox na mesma transação. Isso exige escolha do banco autoritativo, migração, constraints,
backfill dos ciclos atuais, política de isolamento, credenciais, backup/rollback e mudança
coordenada de Plug e Unplug. Por restrição desta etapa, nenhuma dessas alterações foi feita.
