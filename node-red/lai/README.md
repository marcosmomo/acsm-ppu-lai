# Adaptadores Node-RED dos CPS físicos do LAI

Este diretório contém artefatos importáveis para o computador conectado aos CLPs do LAI. O `CPS-LAI-01` possui o fluxo de referência já comissionado. O `CPS-LAI-02` possui AAS, IDs, mapping preliminar e artefatos próprios de validação somente leitura; seus bindings semânticos de processo ainda aguardam confirmação física. O `CPS-LAI-03` permanece preparado, mas não comissionado. Não reutilize fluxos entre estações sem novos IDs, tópicos, NodeIds e evidências.

Para iniciar a validação da Joining Station, siga `CPS-LAI-02-PHYSICAL-VALIDATION.md`. Durante essa etapa, use apenas `flows/cps-lai-02-dynamic-tag-validation.json`; o fluxo operacional `flows/cps-lai-02-opcua-mqtt.json` continua separado e não deve ser usado para promover semântica automaticamente.

O runtime Node.js em `services/cps-lai-01` é uma alternativa **inativa**. Não o execute ao mesmo tempo que este fluxo: deve existir apenas um publicador para `cpslai1/#`.

## 1. Instalação

Requisitos recomendados para este pacote: Node.js compatível com Node-RED 5 e as versões fixadas em `package.json`.

```powershell
Set-Location node-red\lai
npm install
npx node-red --userDir .node-red-lai
```

Em um runtime Node-RED já instalado, instale somente a contribuição OPC UA no diretório de usuário desse runtime:

```powershell
Set-Location $env:USERPROFILE\.node-red
npm install node-red-contrib-opcua@0.2.355
```

O repositório não possuía versão de Node-RED nem `node-red-contrib-opcua` configurados antes deste pacote.

## 2. Variáveis e segredos

Use `.env.example` como checklist, sem inserir credenciais no repositório. O computador do LAI deve receber `MQTT_BROKER_HOST` com o IP ou DNS realmente acessível na rede do laboratório. `acsm-mosquitto` só é válido para clientes dentro da mesma rede Docker e não é o padrão deste fluxo físico.

Variáveis obrigatórias antes de habilitar a aba:

- `OPCUA_ENDPOINT` confirmado;
- `MQTT_BROKER_HOST` confirmado;
- `CPS_LAI_01_FIELD_MAPPING_FILE` apontando para uma cópia comissionada do mapping;
- segurança OPC UA conforme configuração efetiva do PLC.

Configure usuário/senha do MQTT e do endpoint OPC UA pelos campos protegidos de credenciais dos respectivos configuration nodes no editor. Não exporte credenciais junto com o fluxo.

`ALLOW_OPCUA_WRITES=false` é o padrão obrigatório. Mantenha-o assim durante instalação, deploy, leitura e validação inicial.

## 3. Importação

1. Abra o editor Node-RED.
2. Instale `node-red-contrib-opcua` pelo Palette Manager ou por npm.
3. Use **Menu → Import → Clipboard/File**.
4. Importe `flows/cps-lai-01-opcua-mqtt.json`.
5. Confirme que a aba aparece desabilitada.
6. Abra o configuration node MQTT e confirme host, porta, TLS e credenciais do laboratório.
7. Abra o configuration node OPC UA e confirme endpoint, security mode, security policy, certificado e credenciais.
8. Crie uma cópia local do mapping de exemplo fora do Git e informe seu caminho em `CPS_LAI_01_FIELD_MAPPING_FILE`.
9. Faça deploy ainda com a aba desabilitada e `ALLOW_OPCUA_WRITES=false`.
10. Somente depois da revisão de rede e mapping, habilite a aba e faça novo deploy.

## 4. Mapeamento OPC UA

Cada campo contém `browseName`, `nodeId`, namespace, tipo, acesso, unidade, escala, intervalo, obrigatoriedade e estado da evidência. O fluxo ignora qualquer entrada cujo `nodeId` ou `evidenceStatus` seja `FIELD_CONFIRMATION_REQUIRED`.

Não substitua os marcadores até que o NodeId tenha sido verificado no servidor OPC UA real. Confirme também datatype, escala, unidade, namespace e permissão. Os bindings de comandos são independentes; não reutilize um NodeId de outro comando.

## 5. Teste somente de leitura

1. Garanta `ALLOW_OPCUA_WRITES=false`.
2. Confirme que somente campos `READ` com evidência confirmada são assinados.
3. Observe `cpslai1/status` e `cpslai1/health`.
4. Desconecte o PLC ou bloqueie temporariamente a rota em uma janela aprovada: Node-RED e MQTT devem continuar ativos e o estado deve mudar para `disconnected`, `stale_data`, `degraded` ou `error`.
5. Confirme que `data`/`sensordata` contêm apenas amostras recebidas, com timestamps e statusCode.
6. Confirme que nenhuma mensagem aparece em OEE ou tópicos cognitivos.

```powershell
mosquitto_sub -h $env:MQTT_BROKER_HOST -p $env:MQTT_BROKER_PORT -t 'cpslai1/#' -v
```

## 6. Teste de comandos

Com escrita desabilitada, o teste deve produzir `OPCUA_WRITES_DISABLED` se o NodeId estiver confirmado, ou `FIELD_CONFIGURATION_REQUIRED` se não estiver:

```powershell
$commandId = [guid]::NewGuid().ToString()
$payload = @{ command = 'play'; commandId = $commandId; correlationId = $commandId } | ConvertTo-Json -Compress
mosquitto_pub -h $env:MQTT_BROKER_HOST -p $env:MQTT_BROKER_PORT -t 'cpslai1/cmd' -m $payload
```

Antes de qualquer escrita real:

1. valide permissões e intertravamentos com o responsável pelo PLC;
2. confirme um NodeId exclusivo para cada comando;
3. execute o teste em condição física segura;
4. altere `ALLOW_OPCUA_WRITES=true` somente na sessão controlada;
5. reinicie/deploy o fluxo e envie um commandId novo;
6. trate `OPCUA_WRITE_CONFIRMED` apenas como confirmação da escrita OPC UA, nunca como confirmação do movimento físico.

O adaptador deduplica `commandId`. Mensagem duplicada recebe ACK negativo e não é escrita novamente.

## 7. Desativação de emergência

1. Defina imediatamente `ALLOW_OPCUA_WRITES=false` e reinicie o runtime Node-RED, ou desabilite a aba e faça Deploy.
2. Se necessário, desabilite o configuration node OPC UA ou desconecte a sessão pelo editor.
3. Não use o adaptador para contornar parada de emergência, intertravamentos ou permissões do PLC.
4. Preserve logs e ACKs para análise.

## 8. Backup

Exporte somente a aba do CPS-LAI-01 por **Export → Selected flows**, sem credenciais. Salve separadamente:

- fluxo exportado;
- mapping comissionado sob controle de acesso apropriado;
- versão do Node-RED e dos nodes instalados (`npm list --depth=0`);
- evidências de leitura, stale/disconnect e comandos aprovados.

## 9. Replicação futura

Para uma nova estação ou para ampliar o escopo físico já validado será obrigatório:

- modelar e aprovar um novo AAS;
- registrar respectivamente `cpslai2` ou `cpslai3` na ACSM;
- copiar o fluxo com novos IDs internos de nodes/tabs;
- trocar todos os tópicos, clientId e variáveis;
- criar mapping próprio com NodeIds confirmados;
- repetir validações de segurança e comissionamento.

Não apenas substitua texto no fluxo atual e não registre `cpslai2`/`cpslai3` antes desses passos.
