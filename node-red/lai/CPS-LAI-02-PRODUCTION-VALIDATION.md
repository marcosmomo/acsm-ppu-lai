# CPS-LAI-02 — Production Tag Validation

## Artefato

Importe `flows/cps-lai-02-production-validation.json` como um novo fluxo no Node-RED da bancada, disponível em `http://localhost:1881`.

A aba importada chama-se `CPS-LAI-02 | Production Tag Validation` e vem com `disabled=true`. Não a habilite ou faça Deploy sem autorização do operador/técnico.

## Sessão OPC UA

O `node-red-contrib-opcua` 0.2.355 cria um `OPCUAClient` e uma sessão dentro de cada nó `OpcUa-Client`. Compartilhar o mesmo nó `OpcUa-Endpoint` não compartilha a sessão. Portanto, este monitor não pode reutilizar a sessão do adapter `CPS-LAI-02 Physical Telemetry (READ ONLY)`.

Ao habilitar e fazer Deploy desta aba, o único nó `OpcUa-Client` diagnóstico criará uma sessão adicional com `opc.tcp://192.168.1.20:4840`, SecurityPolicy `None` e SecurityMode `None`. A aba desabilitada não cria essa conexão.

Antes e depois da ativação, compare:

```powershell
netstat -ano | Select-String "192.168.1.20:4840"
```

Deve surgir no máximo uma nova conexão atribuível ao monitor. Se surgirem várias, se o adapter existente perder conexão ou se o servidor ficar lento, desabilite apenas esta aba e faça Deploy.

## Estratégia de aquisição

O fluxo contém um único cliente com ação `readmultiple`, suportada pela versão instalada. A cada 2000 ms, enquanto a coleta estiver ativa, ele envia uma única requisição com estes oito NodeIds:

- `ns=3;s="xMProcessBusy"`
- `ns=3;s="xMStartProcess"`
- `ns=3;s="xMontar"`
- `ns=3;s="iStep"`
- `ns=3;s="iStep_seq"`
- `ns=3;s="inBusy"`
- `ns=3;s="G2BG4_A"`
- `ns=3;s="evt_blk"`

Todos permanecem `CANDIDATE_UNVALIDATED`. O fluxo não atribui significado físico, não deriva estado, não publica MQTT e não contém Write, Call ou comando para o CLP.

Somente uma requisição pode ficar pendente. Se ela não terminar em oito segundos, o monitor registra `READ_FAILURE`, interrompe a coleta e exige novo Start manual. Isso evita reconexões ou leituras agressivas.

Na versão 0.2.355, a saída 2 do `OpcUa-Client` transporta tanto erros quanto mensagens normais de estado (`error: null`, por exemplo `session active` e `active multiple reading`). O nó `Separate OPC UA status from real errors` filtra essas mensagens: estados normais seguem apenas para o Debug de sessão; somente erros explícitos interrompem a coleta. O registro de falha preserva, quando fornecidos pelo cliente, mensagem, status, endpoint, código, StatusCode, origem do Catch e stack.

## Caminho JSONL

O caminho padrão é relativo ao diretório de usuário do Node-RED:

`diagnostics/cpslai2-production-validation.jsonl`

Na instalação atual, normalmente resulta em:

`C:\Users\marco\.node-red\diagnostics\cpslai2-production-validation.jsonl`

Para escolher outro caminho antes de iniciar o Node-RED, defina a variável de ambiente `CPSLAI2_PRODUCTION_VALIDATION_JSONL` com o caminho completo. O arquivo node usa `msg.filename`, e `createDir=true` cria apenas o diretório diagnóstico solicitado.

## Execução de um ensaio

1. Faça backup do fluxo Node-RED atual sem credenciais.
2. Importe o JSON como nova aba e confirme que ela permanece desabilitada.
3. Confirme que não existem nós MQTT, Write ou Call na aba.
4. Com autorização, habilite somente a nova aba e faça Deploy. Isso cria a sessão adicional, mas não inicia leituras porque `once=false` e o gate começa fechado.
5. Edite o payload de `1. Set experiment ID` para um identificador inequívoco, por exemplo `AUTO_CYCLE_2026_10_10_RUN_01`, e acione o inject.
6. Acione `2. Start collection`.
7. Acione `Record next complete baseline` antes do ciclo. O próximo lote completo gera um evento `BASELINE_SNAPSHOT` com as oito amostras.
8. O operador autorizado executa o ciclo físico. O monitor somente observa.
9. Acione `Stop collection` ao fim da repetição.
10. Repita com novos experiment IDs para pelo menos três ciclos, incluindo um baseline AUTOMATIC parado.
11. Use `Clear comparison memory` entre ensaios quando quiser que a próxima amostra válida de cada NodeId seja registrada como `FIRST_VALID_READ`. Esse comando também para a coleta.

## Eventos registrados

- `FIRST_VALID_READ`: primeira leitura válida após limpar a memória;
- `VALUE_CHANGE`: mudança real do valor primitivo;
- `QUALITY_CHANGE`: mudança de StatusCode sem mudança entre disponível/indisponível;
- `READ_FAILURE`: qualidade ruim, resposta incompleta, erro ou timeout;
- `READ_RECOVERY`: primeira leitura Good após falha;
- `BASELINE_SNAPSHOT`: snapshot manual completo;
- `DIAGNOSTIC_CONTROL`: comandos internos do monitor e rejeições de controle.

Amostras idênticas não geram eventos de transição. Cada registro preserva `cpsId`, experimento, BrowseName, NodeId, valor, tipo JavaScript, datatype OPC UA quando devolvido pelo nó, StatusCode, timestamps OPC UA, `collectedAt`, lote e número da amostra. O `collectedAt` local permanece independente dos timestamps OPC UA antigos observados no servidor.

## Três ciclos físicos

Use um identificador diferente para cada ciclo. Em cada repetição:

1. registre baseline completo;
2. anote externamente a hora em que o operador iniciou o ciclo;
3. aguarde o retorno físico ao estado de repouso;
4. pare a coleta;
5. confira Debug e JSONL;
6. compare as transições repetíveis, incluindo teste negativo com AUTOMATIC selecionado e máquina parada.

Um nome sugestivo ou uma transição isolada não valida semântica. A promoção exige correlação repetível, teste negativo e revisão humana.

## Restauração

1. Acione `Stop collection`.
2. Desabilite somente `CPS-LAI-02 | Production Tag Validation`.
3. Faça Deploy.
4. Confirme pelo `netstat` que a conexão adicional desapareceu e que as conexões do adapter físico continuam presentes.
5. Não remova, edite ou redesenhe `CPS-LAI-02 Physical Telemetry (READ ONLY)`.
