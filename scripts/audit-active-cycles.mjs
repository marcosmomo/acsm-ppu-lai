import { resolve } from 'node:path';
import * as governanceModule from '../lib/governance/governanceMigration.mjs';

async function runAudit() {
  const defaultPath = 'C:/bkp/estagio doutoral/Implementação ACSM PPU/ACSM-PPU-LAI/data/governance-store.json';
  const targetPath = resolve(process.argv[2] || defaultPath);

  console.log('====================================================');
  console.log(' RECONCILIAÇÃO E PRÉ-VALIDAÇÃO DE CICLOS LAI (B5 -> B6)');
  console.log('====================================================');
  console.log(`[+] Alvo: ${targetPath}\n`);

  const activeCycleEvidence = {
    cpslai1: {
      cpsId: 'cpslai1',
      plugEventId: 'cpslai1-plug-event-1791936962416-sy8aki98',
      plugCycleId: 'cpslai1-plug-v215',
      profileId: 'GOV-CPSLAI1-215',
      identity: {
        aasId: 'https://lai.ufsc.br/aas/cpslai1',
        assetId: 'festo-mps-distribution-cpslai1'
      },
      lifecycleEvidence: {
        eventId: 'cpslai1-plug-event-1791936962416-sy8aki98',
        timestamp: '2026-10-14T00:16:02.453Z',
        source: 'LAI_TESTBED_PLC',
        accepted: true,
        acceptedAt: '2026-10-14T00:16:09.536Z',
        acceptedBy: 'human-operator',
        transitionId: 'tr-cpslai1-active-001'
      }
    },
    cpslai2: {
      cpsId: 'cpslai2',
      plugEventId: 'cpslai2-plug-event-1791936979348-9us3v15h',
      plugCycleId: 'cpslai2-plug-v103',
      profileId: 'GOV-CPSLAI2-103',
      identity: {
        aasId: 'https://lai.ufsc.br/aas/cpslai2',
        assetId: 'festo-mps-joining-cpslai2'
      },
      lifecycleEvidence: {
        eventId: 'cpslai2-plug-event-1791936979348-9us3v15h',
        timestamp: '2026-10-14T00:16:19.370Z',
        source: 'LAI_TESTBED_PLC',
        accepted: true,
        acceptedAt: '2026-10-14T00:16:25.440Z',
        acceptedBy: 'human-operator',
        transitionId: 'tr-cpslai2-active-001'
      }
    },
    cpslai3: {
      cpsId: 'cpslai3',
      plugEventId: 'cpslai3-plug-event-1791936997701-wr7lml6v',
      plugCycleId: 'cpslai3-plug-v113',
      profileId: 'GOV-CPSLAI3-113',
      identity: {
        aasId: 'https://lai.ufsc.br/aas/cpslai3',
        assetId: 'festo-mps-sorting-cpslai3'
      },
      lifecycleEvidence: {
        eventId: 'cpslai3-plug-event-1791936997701-wr7lml6v',
        timestamp: '2026-10-14T00:16:37.735Z',
        source: 'LAI_TESTBED_PLC',
        accepted: true,
        acceptedAt: '2026-10-14T00:16:44.320Z',
        acceptedBy: 'human-operator',
        transitionId: 'tr-cpslai3-active-001'
      }
    }
  };

  try {
    const PlannerClass = governanceModule.GovernanceMigrationPlanner || governanceModule.default;
    const planner = typeof PlannerClass === 'function' ? new PlannerClass() : PlannerClass;

    const result = typeof planner.prevalidate === 'function'
      ? await planner.prevalidate({ sourcePath: targetPath, activeCycleEvidence })
      : await PlannerClass.prevalidate({ sourcePath: targetPath, activeCycleEvidence });

    console.log(`\n[✔] PRÉ-VALIDAÇÃO CONCLUÍDA COM SUCESSO!`);
    console.log(`    - SHA-256 da Fonte: ${result.sourceHash}`);
    console.log(`    - Tamanho:          ${result.sourceBytes} bytes`);
    console.log(`    - Perfis Processados: ${Object.keys(result.candidate?.profiles || {}).length}`);

    // Trata plugCycles se for Array, Map ou Objeto
    const rawCycles = result.candidate?.plugCycles || {};
    const plugCyclesList = Array.isArray(rawCycles)
      ? rawCycles
      : (rawCycles instanceof Map ? Array.from(rawCycles.values()) : Object.values(rawCycles));

    console.log(`    - Plug Cycles Gerados: ${plugCyclesList.length}\n`);

    const activeCycles = plugCyclesList.filter(c => c.status === 'ACTIVE' || c.state === 'ACTIVE');

    console.log(`--- Ciclos Ativos Reconciliados e Validados ---`);
    console.table(activeCycles.map((c, i) => ({
      Index: i + 1,
      CPS_ID: c.cpsId,
      Cycle_ID: c.plugCycleId,
      Profile_ID: c.governanceProfileId,
      AAS_ID: c.identity?.aasId,
      Asset_ID: c.identity?.assetId,
      Status: c.status || c.state
    })));

    console.log('\n====================================================');
    /* Legacy headline retained in source history but deliberately not emitted:
    console.log(' DIAGNÓSTICO: APROVADO PARA AUTORIZAÇÃO B6');
    */
    console.log(' DIAGNOSTICO: PRE-VALIDACAO DOCUMENTAL CONCLUIDA');
    console.log(' RESULTADO LIMITADO A PRE-VALIDACAO DOCUMENTAL.');
    console.log(' Os 3 ciclos candidatos foram correlacionados somente em memoria.');
    console.log(' Isto nao executa migracao, cutover ou autorizacao operacional.');
    console.log('====================================================\n');

  } catch (error) {
    console.error(`\n[✖] FALHA NA PRÉ-VALIDAÇÃO: ${error.message}`);
  }
}

runAudit();
