import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourcePath = path.join(projectRoot, 'cps-defs', 'cps-lai-01-aas-acsm-compatible-revised.json');
const outputDirectory = path.join(projectRoot, 'cps-defs', 'evolution-experiments', 'cpslai1');

const clone = (value) => structuredClone(value);
const capabilities = (aas) => aas.submodels.find((item) => item.idShort === 'Capabilities').submodelElements;

const pieceDetection = {
  modelType: 'SubmodelElementCollection',
  idShort: 'PieceDetection',
  description: [
    {
      language: 'en',
      text: 'Experimental functional declaration of supported piece-detection points. Boolean values declare functional support and are not instantaneous sensor states.',
    },
    {
      language: 'pt-BR',
      text: 'Declaração funcional experimental dos pontos de detecção de peça suportados. Os valores booleanos declaram suporte funcional e não são estados instantâneos dos sensores.',
    },
  ],
  semanticId: {
    type: 'ExternalReference',
    keys: [{ type: 'GlobalReference', value: 'urn:ufsc:lai:experimental:capability:piece-detection:1' }],
  },
  qualifiers: [
    { type: 'ExperimentalModel', valueType: 'xs:boolean', value: 'true' },
    { type: 'EvidenceScope', valueType: 'xs:string', value: 'DECLARED_FUNCTIONAL_SUPPORT' },
  ],
  value: ['PieceAtEntry', 'PieceAtMiddle', 'PieceAtExit'].map((idShort) => ({
    modelType: 'Property', idShort, valueType: 'xs:boolean', value: 'true',
  })),
};

const experimentalCapability = {
  modelType: 'Property',
  idShort: 'ExperimentalAdaptivePieceDetection',
  valueType: 'xs:boolean',
  value: 'true',
  description: [
    {
      language: 'en',
      text: 'Synthetic AVM-1B capability for Evolution testing only; it is not physically validated on CPS-LAI-01.',
    },
    {
      language: 'pt-BR',
      text: 'Capacidade sintética AVM-1B apenas para teste do Evolution; não foi validada fisicamente no CPS-LAI-01.',
    },
  ],
  semanticId: {
    type: 'ExternalReference',
    keys: [{ type: 'GlobalReference', value: 'urn:ufsc:lai:experimental:capability:adaptive-piece-detection:1' }],
  },
  qualifiers: [
    { type: 'ExperimentalModel', valueType: 'xs:boolean', value: 'true' },
    { type: 'EvidenceScope', valueType: 'xs:string', value: 'DECLARED_ONLY_NO_PHYSICAL_EVIDENCE' },
  ],
};

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const v1 = clone(source);
capabilities(v1).push(pieceDetection);

const v2 = clone(v1);
const middle = capabilities(v2)
  .find((item) => item.idShort === 'PieceDetection').value
  .find((item) => item.idShort === 'PieceAtMiddle');
middle.value = 'false';

const v3 = clone(v2);
capabilities(v3).push(experimentalCapability);

fs.mkdirSync(outputDirectory, { recursive: true });
for (const [name, document] of Object.entries({ 'aas-v1.json': v1, 'aas-v2.json': v2, 'aas-v3.json': v3 })) {
  fs.writeFileSync(path.join(outputDirectory, name), `${JSON.stringify(document, null, 2)}\n`);
}
