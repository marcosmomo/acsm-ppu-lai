# Validação física do CPS-LAI-02 — Joining Station

Este roteiro inicia o comissionamento físico do `CPS-LAI-02` com a mesma estratégia aplicada ao `CPS-LAI-01`: descoberta explícita, leitura somente, correlação controlada com eventos físicos e promoção manual da evidência. Nenhuma observação de browse ou variação de valor confirma, isoladamente, a semântica de um sinal.

## Estado inicial confirmado

- endpoint observado: `opc.tcp://192.168.1.20:4840`;
- raiz da estação: `ns=3;s=PLC` (`02_Joining_1512C`);
- diretórios estruturais observados: `Inputs`, `Outputs`, `Memory`, `Counters`, `Timers`, `DataBlocksGlobal` e `DataBlocksInstance`;
- variável legível: `ns=3;s=OperatingMode`, datatype `Int32`;
- significado dos valores de `OperatingMode`: pendente de correlação física;
- bindings de processo, OEE e comandos: não confirmados.

## Limites obrigatórios da sessão

1. Manter `ALLOW_OPCUA_WRITES=false`.
2. Não importar ou habilitar nenhum node OPC UA de escrita.
3. Não publicar OEE, Health, lifecycle, Governance, HCM ou comandos a partir desta validação.
4. Não promover automaticamente um NodeId descoberto para `VALIDATED`.
5. Operar a estação somente sob autorização e procedimentos de segurança do LAI; PLC, intertravamentos e parada de emergência permanecem soberanos.

## Artefatos

- `flows/cps-lai-02-dynamic-tag-validation.json`: fluxo experimental somente leitura;
- `flows/cps-lai-02-validation-tags.json`: inventário versionado de candidatos e estados de evidência;
- `config/cps-lai-02-field-mapping.json`: mapping operacional, que só deve ser atualizado depois da aprovação das evidências;
- `cpslai2-dynamic-validation.jsonl`: log produzido no diretório de usuário do Node-RED durante o ensaio.

## Evidência incorporada em 2026-10-09

Dois experimentos somente leitura monitoraram 352 tags e registraram, respectivamente, 311 e 106 transições. As seis variáveis abaixo apresentaram leituras `Good`, valores booleanos e transições nos dois experimentos:

- `sys_man` → `ns=3;s="sys_man"`;
- `sys_man2` → `ns=3;s="sys_man2"`;
- `sys_sup` → `ns=3;s="sys_sup"`;
- `sys_menu` → `ns=3;s="sys_menu"`;
- `man_step_0` → `ns=3;s="man_step_0"`;
- `man_step_1` → `ns=3;s="man_step_1"`.

Essas evidências confirmam NodeId, legibilidade, qualidade observada e datatype booleano. Não confirmam qual variável ou combinação representa Manual, Automático ou Step-by-Step.

## Contrato MQTT da primeira integração

O fluxo `flows/cps-lai-02-opcua-mqtt.json` publica exclusivamente em `cpslai2/data`, com QoS 1 e sem retenção. Cada mensagem representa uma amostra OPC UA recebida e contém identificação do CPS, endpoint, horário de coleta, timestamps OPC UA, StatusCode/qualidade e um único campo em `data` com NodeId e valor real.

Não são publicados nesta etapa: `cpslai2/status`, `cpslai2/oee`, `cpslai2/health`, lifecycle, estados PPU, contadores, comandos ou inferências dos três modos físicos.

## Importação e ativação exatas na bancada

1. No Node-RED já existente, use **Menu → Import → File** e selecione apenas `flows/cps-lai-02-opcua-mqtt.json`. Não inicie outra instância do Node-RED.
2. Escolha importar como novo fluxo. Confirme a aba independente `CPS-LAI-02 Physical Telemetry (READ ONLY)` e mantenha-a desabilitada.
3. Confirme que não há conflito de IDs na tela de importação. Se o fluxo anterior do CPS-LAI-02 já estiver importado, remova/substitua somente essa aba após exportar um backup; não altere a aba do CPS-LAI-01.
4. Abra o endpoint OPC UA e confira `opc.tcp://192.168.1.20:4840`, `SecurityPolicy=None`, `SecurityMode=None` e ausência de escrita.
5. Abra o broker MQTT e ajuste host, porta, TLS e credenciais para o broker acessível pela bancada. Não exporte credenciais.
6. Faça Deploy com a aba ainda desabilitada.
7. Em um terminal de observação, execute `mosquitto_sub -h <BROKER> -p <PORTA> -t 'cpslai2/#' -v`.
8. Habilite somente a aba do CPS-LAI-02 e faça Deploy. O inject inicial cria as seis assinaturas após dois segundos.
9. Confirme mensagens apenas em `cpslai2/data`. Verifique `cpsId`, `collectedAt`, `nodeId`, `statusCode`, `quality`, `sourceTimestamp`, `serverTimestamp` e `semanticMappingStatus=PRELIMINARY_UNVALIDATED`.
10. Alterne os modos físicos somente conforme o procedimento e autorização do LAI. Correlacione as mudanças sem renomear ou classificar semanticamente os campos.
11. Confirme que não surgem mensagens em `cpslai2/status`, `cpslai2/oee`, `cpslai2/health`, `cpslai2/cmd` ou tópicos cognitivos.
12. Ao terminar, desabilite a aba, faça Deploy e preserve a captura MQTT e os logs do Node-RED.

Antes da bancada, execute `npm run validate:cpslai2:flow` e `npm test` na raiz do projeto.

## Sequência da primeira sessão

1. Faça backup do fluxo Node-RED atual sem credenciais.
2. Importe `cps-lai-02-dynamic-tag-validation.json` e confirme que a aba está desabilitada.
3. Revise o endpoint e mantenha política/modo de segurança exatamente como configurados no servidor real.
4. Habilite apenas a aba de validação e faça deploy.
5. Defina `testStep` como `BASELINE_IDLE` e acione `Start confirmed-tag subscription`.
6. Registre por pelo menos 30 segundos o valor estável de `OperatingMode` e o evento `DATA_FRESH`.
7. Com o operador do LAI, altere um único modo físico por vez. Antes de cada ação, defina um `testStep` inequívoco, por exemplo `SELECT_MANUAL`, `SELECT_AUTO` ou `RETURN_IDLE`.
8. Repita cada transição pelo menos três vezes e registre horário, ação observada e retorno ao estado anterior.
9. Use o browse manual para aprofundar uma raiz por vez. O browse apenas registra candidatos; não assina nem promove os resultados.
10. Em janela aprovada, teste perda e retorno da comunicação e confirme `OPCUA_DISCONNECTED`, `DATA_STALE`, `OPCUA_CONNECTED` e novo `DATA_FRESH`.
11. Desabilite a aba ao fim da sessão e preserve o JSONL junto com a versão do fluxo e o inventário de tags.

## Critério para promover uma semântica

Um sinal só pode ser promovido no catálogo e no mapping quando houver:

- NodeId, datatype e acesso confirmados no servidor real;
- mudança temporal repetível e alinhada a uma única ação física documentada;
- teste negativo ou retorno ao baseline que descarte coincidência;
- ausência de contradições em pelo menos três repetições;
- revisão humana do responsável pelo ensaio.

Até essa decisão, use `NODEID_AND_DATATYPE_CONFIRMED`, `TO_DISCOVER` ou `TO_VALIDATE`; não use `VALIDATED` nem derive estado operacional.

## Critérios de aceite da etapa 1

- conexão OPC UA e assinatura somente leitura estáveis;
- amostras com timestamp, statusCode e metadados do sinal;
- transições de `OperatingMode` registradas sem atribuição semântica prematura;
- stale/desconexão/recuperação observáveis no log;
- zero escritas OPC UA e zero publicação de dados sintéticos;
- evidência preservada com identificação do passo de teste.

## Encerramento e decisão

Ao terminar, registre os valores observados de `OperatingMode` por passo de teste. Se a correlação for inequívoca, atualize primeiro `cps-lai-02-validation-tags.json`; depois revise o mapping, o AAS e o adaptador operacional em uma alteração separada. Se a evidência for insuficiente, mantenha `operationMode: UNKNOWN` e `operationModeSemanticStatus: PENDING`.
