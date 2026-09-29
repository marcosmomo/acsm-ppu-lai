/* Generate the CPS-1 prototype technical datasheet from the current AAS. */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const root = path.resolve(__dirname, '..');
const aasPath = path.join(root, 'cps-defs', 'roboSoldagem.json');
const outputPath = path.join(root, 'resources', 'cps1', 'datasheet.pdf');
const aas = JSON.parse(fs.readFileSync(aasPath, 'utf8'));
const shell = aas.assetAdministrationShells[0];
const assetInfo = shell.assetInformation;

function repairText(value) {
  if (typeof value !== 'string') return String(value ?? '');
  try {
    const repaired = Buffer.from(value, 'latin1').toString('utf8');
    return repaired.includes('\uFFFD') || repaired.includes('Ã') ? value : repaired;
  } catch (_) {
    return value;
  }
}

function submodel(idShort) {
  return aas.submodels.find((item) => item.idShort === idShort);
}

function valueOf(item) {
  return repairText(item?.value ?? '');
}

function property(items, idShort) {
  return items.find((item) => item.idShort === idShort);
}

function collectionValues(collection) {
  return Object.fromEntries((collection.value || []).map((item) => [item.idShort, valueOf(item)]));
}

function specificId(name) {
  return repairText(assetInfo.specificAssetIds.find((item) => item.name === name).value);
}

function tableRows(items) {
  return items.map(([field, value, source]) => [repairText(field), repairText(value), repairText(source)]);
}

const technicalData = submodel('TechnicalData');
const functions = submodel('Functions');
const interfaces = submodel('AssetInterfacesDescription');
const lifecycle = submodel('LifecycleIntegration');
const acsm = submodel('ACSMIntegration');
const documents = submodel('Documents');
const functionCollection = functions.submodelElements[0];
const functionData = collectionValues(functionCollection);

const identification = tableRows([
  ['CPS ID', specificId('cpsId'), 'assetInformation'],
  ['Asset Name', specificId('assetName'), 'assetInformation'],
  ['Asset Type', specificId('assetType'), 'assetInformation'],
  ['Manufacturer', specificId('manufacturer'), 'assetInformation'],
  ['Serial Number', specificId('serialNumber'), 'assetInformation'],
  ['Global Asset ID', assetInfo.globalAssetId, 'assetInformation'],
  ['AAS ID', shell.id, 'AssetAdministrationShell'],
  ['AAS idShort', shell.idShort, 'AssetAdministrationShell'],
  ['Asset Kind', assetInfo.assetKind, 'assetInformation'],
]);

const technicalRows = tableRows(technicalData.submodelElements.map((item) => [
  item.idShort,
  valueOf(item),
  'TechnicalData',
]));

const functionRows = tableRows([
  ['Identifier', functionCollection.idShort, 'Functions'],
  ['Name', functionData.Name, 'Functions.execute_welding_cycle'],
  ['Description', functionData.Description, 'Functions.execute_welding_cycle'],
  ['Allowed statuses', functionData.AllowedStatuses, 'Functions.execute_welding_cycle'],
]);

const interfaceRows = [];
for (const item of interfaces.submodelElements) {
  if (item.modelType === 'Property') {
    interfaceRows.push([item.idShort, valueOf(item), 'AssetInterfacesDescription']);
  } else {
    const values = collectionValues(item);
    for (const [key, value] of Object.entries(values)) {
      interfaceRows.push([`${item.idShort}.${key}`, value, item.idShort]);
    }
  }
}

const lifecycleRows = tableRows(lifecycle.submodelElements.map((item) => [
  item.idShort,
  valueOf(item),
  'LifecycleIntegration',
]));

const acsmRows = tableRows(acsm.submodelElements.map((item) => [
  item.idShort,
  valueOf(item),
  'ACSMIntegration',
]));

const documentEndpoint = valueOf(property(documents.submodelElements, 'DatasheetPDF'));
const canonicalEndpoint = '/api/cps1/datasheet/pdf';
if (documentEndpoint !== canonicalEndpoint) {
  throw new Error(`AAS Documents.DatasheetPDF must be ${canonicalEndpoint}`);
}
const digitalRows = tableRows([
  ['Representation', 'Asset Administration Shell', 'AssetAdministrationShell'],
  ['Global Asset ID', assetInfo.globalAssetId, 'assetInformation'],
  ['AAS instance ID', shell.id, 'AssetAdministrationShell'],
  ['Document endpoint', documentEndpoint, 'Documents.DatasheetPDF'],
]);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const doc = new PDFDocument({
  size: 'A4',
  compress: false,
  margins: { top: 66, bottom: 54, left: 43, right: 43 },
  info: {
    Title: 'CPS-001 - RoboSoldagemAlfa Technical Datasheet',
    Author: 'PPU Prototype',
  },
});
doc.pipe(fs.createWriteStream(outputPath));

const pageWidth = 595.28;
const contentWidth = pageWidth - 86;
const navy = '#12355b';
const blueGray = '#40566f';
const ink = '#263746';
const line = '#cbd5df';
const pale = '#f5f8fb';
let pageNumber = 0;

function headerFooter() {
  pageNumber += 1;
  doc.save();
  doc.strokeColor('#d8e0e8').lineWidth(0.5).moveTo(43, 48).lineTo(pageWidth - 43, 48).stroke();
  doc.fillColor(navy).font('Helvetica-Bold').fontSize(8).text('CPS-001 | RoboSoldagemAlfa', 43, 34);
  doc.fillColor('#6b7d8f').font('Helvetica').fontSize(7).text(`Prototype technical datasheet | Page ${pageNumber}`, 43, 766, { width: contentWidth, align: 'right' });
  doc.restore();
}

function section(title) {
  doc.fillColor(navy).font('Helvetica-Bold').fontSize(13).text(title, 43, doc.y, { width: contentWidth });
  doc.moveDown(0.55);
}

function paragraph(text, size = 8.5, color = ink) {
  doc.fillColor(color).font('Helvetica').fontSize(size).text(repairText(text), 43, doc.y, { width: contentWidth, lineGap: 1.5 });
  doc.moveDown(0.45);
}

function wrapCell(value, maxChars) {
  const words = String(value).split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if ((current + ' ' + word).length <= maxChars) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function table(rows, widths = [122, 258, 112]) {
  const x = 43;
  const header = ['Attribute', 'Value', 'AAS source'];
  const allRows = [header, ...rows];
  const fontSize = 7.7;
  const padding = 5;
  const charLimits = widths.map((width) => Math.max(12, Math.floor(width / 4.1)));
  for (let rowIndex = 0; rowIndex < allRows.length; rowIndex += 1) {
    const row = allRows[rowIndex];
    const rowY = doc.y;
    const wrapped = row.map((value, colIndex) => wrapCell(value, charLimits[colIndex]));
    const height = Math.max(19, ...wrapped.map((lines) => lines.length * 10 + padding * 2));
    let cursorX = x;
    for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
      doc.save();
      doc.fillColor(rowIndex === 0 ? navy : (rowIndex % 2 === 0 ? pale : '#ffffff'))
        .strokeColor(line)
        .lineWidth(0.35)
        .rect(cursorX, rowY, widths[colIndex], height)
        .fillAndStroke();
      doc.fillColor(rowIndex === 0 ? '#ffffff' : ink)
        .font(rowIndex === 0 ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(fontSize);
      wrapped[colIndex].forEach((lineText, lineIndex) => {
        doc.text(lineText, cursorX + padding, rowY + padding + lineIndex * 10, { lineBreak: false });
      });
      doc.restore();
      cursorX += widths[colIndex];
    }
    doc.y = rowY + height;
  }
  doc.moveDown(0.55);
}

headerFooter();
doc.y = 70;
doc.fillColor(navy).font('Helvetica-Bold').fontSize(22).text('TECHNICAL DATASHEET', 43, doc.y);
doc.moveDown(0.18);
doc.fillColor(blueGray).font('Helvetica').fontSize(10.5).text('CPS-001 - RoboSoldagemAlfa', 43, doc.y);
doc.moveDown(0.18);
doc.fillColor(blueGray).fontSize(9.5).text('Cyber-Physical System Technical Datasheet', 43, doc.y);
doc.moveDown(0.75);
paragraph('Prototype technical datasheet generated from the CPS Asset Administration Shell (AAS). It is not an official manufacturer datasheet.', 8, blueGray);
section('1. CPS Identification');
table(identification);
section('2. Technical Data');
table(technicalRows);
doc.addPage();
headerFooter();
doc.y = 70;
section('3. Functional Capability');
table(functionRows);
section('4. Communication Interfaces');
table(interfaceRows, [150, 230, 112]);

doc.addPage();
headerFooter();
doc.y = 70;
section('5. Lifecycle Integration');
paragraph('Lifecycle phases are distinct from operational conditions. Plug, Play-Evolution, and Unplug are lifecycle phases; running, stopped, and maintenance are operational conditions and are not treated as lifecycle phases in this document.');
table(lifecycleRows);
section('6. ACSM Integration');
table(acsmRows);

doc.addPage();
headerFooter();
doc.y = 70;
section('7. Digital Representation');
table(digitalRows);
section('8. Document Information');
table(tableRows([
  ['Document type', 'Prototype Technical Datasheet', 'Generated document'],
  ['Source', 'CPS-001 Asset Administration Shell', 'Source definition'],
  ['Generated for', 'PPU Prototype', 'Requested document scope'],
  ['Date generated', new Date().toISOString().slice(0, 10), 'Generation date'],
]));
section('Excluded runtime data');
paragraph('Current OEE, health, temperature, arc current, gas pressure, counters, Learning, Reasoning, Prediction, and Recommendation are runtime data or intelligence outputs. They are deliberately excluded from this static technical specification.');

doc.end();
console.log(`Generated ${outputPath}`);
