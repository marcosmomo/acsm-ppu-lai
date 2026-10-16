# Experimento E1 — Evolution offline do CPS-LAI-01

Execução: 2026-10-14T18:00:00.000Z

AAS V1: urn:ufsc:lai:ppu:cps-lai-01:aas / urn:ufsc:lai:asset:cps-lai-01:distribution-conveyor; SHA-256 b5ca586f90662dbebf5d829d92c2e53d342301b1378fb4ed0223641091ade692; escopo STATIC_DOCUMENT_DECLARATION. Documento de referência somente leitura; cópia experimental em temporary root.

## Extração real da AAS V1

Capacidades (5):
- MaterialTransport — Capabilities/PrimaryCapability; TECHNICAL_PATH; evidência DECLARED_ONLY
- ConveyorForward — Capabilities/ConveyorForward; TECHNICAL_PATH; evidência DECLARED_ONLY
- ConveyorReverse — Capabilities/ConveyorReverse; TECHNICAL_PATH; evidência DECLARED_ONLY
- PieceSeparation — Capabilities/PieceSeparation; TECHNICAL_PATH; evidência DECLARED_ONLY
- SlideActuation — Capabilities/SlideActuation; TECHNICAL_PATH; evidência DECLARED_ONLY

Serviços (13):
- plug — Services/LifecycleServices/Service_1; evidência DECLARED_ONLY
- play — Services/LifecycleServices/Service_2; evidência DECLARED_ONLY
- stop — Services/LifecycleServices/Service_3; evidência DECLARED_ONLY
- maintenance — Services/LifecycleServices/Service_4; evidência DECLARED_ONLY
- return — Services/LifecycleServices/Service_5; evidência DECLARED_ONLY
- unplug — Services/LifecycleServices/Service_6; evidência DECLARED_ONLY
- getAAS — Services/LifecycleServices/Service_7; evidência DECLARED_ONLY
- getStatus — Services/LifecycleServices/Service_8; evidência DECLARED_ONLY
- getHealth — Services/LifecycleServices/Service_9; evidência DECLARED_ONLY
- getOEE — Services/LifecycleServices/Service_10; evidência DECLARED_ONLY
- transportMaterial — Services/ProcessServices/Service_1; evidência DECLARED_ONLY
- separatePiece — Services/ProcessServices/Service_2; evidência DECLARED_ONLY
- actuateSlide — Services/ProcessServices/Service_3; evidência DECLARED_ONLY

A extração é COMPLETE_WITH_WARNINGS; nenhuma declaração foi considerada fisicamente validada. Declarações sem semanticId foram identificadas por caminho técnico; não foram criados IRDIs ECLASS.

## Matriz E1

| ID | Cenário | Resultado | Diferenças | Avaliação |
|---|---|---|---|---|
| E1.1 | Primeira AAS registrada | BASELINE | — | PASS |
| E1.2 | Replug inalterado; controle descritivo irrelevante em store independente | NO_CHANGE | — | PASS |
| E1.3 | Replug com capacidade sintética adicionada | CHANGED | ADDED | PASS |
| E1.4 | Replug com capacidade removida | CHANGED | REMOVED | PASS |
| E1.5 | Replug com atributo funcional alterado, identidade técnica mantida | CHANGED | CHANGED | PASS |
| E1.6-incomplete | AAS funcional incompleta | INDETERMINATE | — | PASS |
| E1.6-ambiguous | Identidade técnica renomeada sem identidade semântica estável | INDETERMINATE | — | PASS |
| E1.7 | Retry do mesmo plugEventId | NO_OP | — | PASS |
| E1.8 | Unplug → Replug com perfil pendente e Play bloqueado | PENDING_APPROVAL / BLOCKED | — | PASS |

## Governança E1.8

{
  "oldVersionsBefore": 1,
  "firstCycle": {
    "state": "CLOSED",
    "profileId": "GOV-CPSLAI1-003",
    "statusAtPlug": "PENDING_APPROVAL",
    "statusAfterUnplug": "PENDING_APPROVAL"
  },
  "secondCycle": {
    "state": "ACTIVE",
    "profileId": "GOV-CPSLAI1-004",
    "status": "PENDING_APPROVAL",
    "plugCycleStatus": "ACTIVE"
  },
  "newProfileCreated": true,
  "approvalNotInherited": true,
  "gateBeforeApproval": "GOVERNANCE_APPROVAL_REQUIRED",
  "gateAfterReplug": "GOVERNANCE_APPROVAL_REQUIRED",
  "playBlocked": true,
  "evolution": {
    "v1": "BASELINE",
    "v2": "CHANGED",
    "governanceUnchangedV1": true,
    "governanceUnchangedV2": true,
    "physicalValidationInferred": false
  },
  "cycles": [
    {
      "plugEventId": "E1.8-plug-initial",
      "plugCycleId": "cpslai1-cycle-86250fcf44cac3cdd4262432854b1509",
      "profileId": "GOV-CPSLAI1-003",
      "state": "CLOSED",
      "authoritativeLifecycleState": "unplugged"
    },
    {
      "plugEventId": "E1.8-plug-replug",
      "plugCycleId": "cpslai1-cycle-aa4f84bfdca2a216c09ee439516158ab",
      "profileId": "GOV-CPSLAI1-004",
      "state": "ACTIVE",
      "authoritativeLifecycleState": "plug"
    }
  ],
  "profiles": [
    {
      "profileId": "gov-cpslai1-v2",
      "profileVersion": 2,
      "plugEventId": null,
      "plugCycleId": null,
      "status": "APPROVED",
      "plugCycleStatus": "CLOSED"
    },
    {
      "profileId": "GOV-CPSLAI1-003",
      "profileVersion": 3,
      "plugEventId": "E1.8-plug-initial",
      "plugCycleId": "cpslai1-cycle-86250fcf44cac3cdd4262432854b1509",
      "status": "PENDING_APPROVAL",
      "plugCycleStatus": "CLOSED"
    },
    {
      "profileId": "GOV-CPSLAI1-004",
      "profileVersion": 4,
      "plugEventId": "E1.8-plug-replug",
      "plugCycleId": "cpslai1-cycle-aa4f84bfdca2a216c09ee439516158ab",
      "status": "PENDING_APPROVAL",
      "plugCycleStatus": "ACTIVE"
    }
  ],
  "governanceRevision": 8
}

## Limitações

Somente fixtures e simulação local em arquivos temporários. O aceite Plug/evidência lifecycle, AAS V2 e estados de governança são simulados. Evolution compara declarações funcionais; não valida operação física, autenticação real, autoridade lifecycle operacional ou Play-gate em runtime. A AAS oficial não foi alterada. Os stores de Evolution e Governance usados no experimento são temporários e independentes dos operacionais.

Arquivos temporários: consulte manifest.json neste diretório.
