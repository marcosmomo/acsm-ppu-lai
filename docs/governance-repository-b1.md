# Etapa B1 — Governance Repository transacional isolado

O `GovernanceRepository` é uma infraestrutura isolada. Ele não é importado pelo
`governanceStore.js`, pelas rotas, pelo Plug, Unplug, Play-gate ou Evolution. Não há
caminho default: o chamador precisa fornecer um `filePath` absoluto.

## Protocolo

Cada transação adquire um diretório de lock por `mkdir` atômico, lê e valida o JSON,
confere `expectedRevision`, entrega uma cópia ao mutator síncrono, valida novamente,
incrementa `revision`, grava um temporário exclusivo, executa `fsync` no arquivo e faz
rename atômico. O `fsync` do diretório é tentado quando suportado pelo sistema.

O lock não possui TTL e nunca é removido por idade. Um lock órfão causa falha fechada;
a remoção exige `verified: true` e uma justificativa, depois de verificação externa do
processo e do estado persistido.

Mutators assíncronos são rejeitados. O repository não chama HCM, REST, MQTT, Evolution,
PPU nem qualquer serviço externo. Efeitos externos devem ser representados no documento
(por exemplo, outbox), confirmados, e executados somente depois que `transact` retornar e
o lock tiver sido liberado.

## Compatibilidade

São obrigatórios e preservados: `profiles`, `profileVersions`, `pendingActions`, `history`
e `ppuOutbox`. Campos desconhecidos também são preservados. Stores legados sem `revision`,
`repositorySchemaVersion` ou `plugCycles` são aceitos sem alteração durante `read`; esses
campos são materializados somente por inicialização ou commit explícito. IDs históricos
ausentes nunca são fabricados.

`plugCycles` é um mapa por `plugCycleId`. Os estados de ciclo permitidos são `RESERVED`,
`ACTIVE`, `FAILED` e `CLOSED`; eles são independentes dos estados de perfil
`PENDING_APPROVAL`, `APPROVED` e `DENIED`. A B1 valida ciclos fornecidos, mas não cria
ciclos nem muda aprovação.

## Garantias e limites

Entre processos participantes no mesmo host e filesystem local, a seção crítica cobre
leitura–validação–mutação–persistência, impedindo lost update. `expectedRevision` oferece
controle otimista adicional. JSON inválido, store ausente e estrutura inconsistente não
são tratados como store vazio.

A garantia não cobre writers antigos que ignorem o lock, múltiplos hosts, NFS ou SMB sem
semântica equivalente de `mkdir` e rename atômicos. Em plataformas que não permitem
`fsync` de diretório, o arquivo é sincronizado antes do rename, mas a durabilidade do
nome após perda abrupta de energia depende do filesystem.

## Integração gradual futura

1. Introduzir o repository por trás de uma interface, ainda usando fixtures/cópias.
2. Migrar todos os writers locais do governance store para uma única função transacional.
3. Tornar perfil, ciclo, histórico e outbox do Plug um único commit.
4. Adicionar compare-and-set por perfil/ciclo às decisões humanas.
5. Exigir IDs exatos no Unplug e remover fechamento apenas por CPS.
6. Somente após testes de compatibilidade, executar migração explícita e auditável do
   arquivo operacional, com backup, quiescência de writers e rollback.
