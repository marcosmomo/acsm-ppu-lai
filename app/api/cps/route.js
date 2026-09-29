import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import {
  extractCpsIdFromAas,
  getActiveAcsmConfig,
  isCpsManagedByAcsm,
} from '../../../lib/acsm/config';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const acsmId = searchParams.get('acsmId');
    const acsmConfig = getActiveAcsmConfig(acsmId);

    // pasta: <raiz do projeto>/cps-defs
    const dir = path.join(process.cwd(), 'cps-defs');

    // se a pasta não existir, dá erro
    if (!fs.existsSync(dir)) {
      throw new Error(`Pasta não encontrada: ${dir}`);
    }

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

    const cpsList = files
      .map((file) => {
        const fullPath = path.join(dir, file);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const parsed = JSON.parse(content);
        const cpsId = extractCpsIdFromAas(parsed);

        return {
          file,
          cpsId,
          parsed,
        };
      })
      .filter(({ cpsId }) => !cpsId || isCpsManagedByAcsm(acsmConfig, cpsId))
      .map(({ parsed }) => parsed);

    return NextResponse.json({
      acsm: {
        id: acsmConfig.id,
        code: acsmConfig.code,
        name: acsmConfig.name,
        managedCpsIds: acsmConfig.managedCpsIds,
      },
      cps: cpsList,
    });
  } catch (e) {
    console.error('Erro ao carregar CPS JSONs:', e);
    return NextResponse.json(
      { error: `Erro ao carregar CPS JSONs: ${e.message || e}` },
      { status: 500 }
    );
  }
}
