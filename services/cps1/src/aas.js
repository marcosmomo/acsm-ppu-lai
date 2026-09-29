'use strict';

const fs = require('node:fs');

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function elements(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.submodelElements) ? node.submodelElements.flatMap(elements) : []), ...(Array.isArray(node.value) ? node.value.flatMap(elements) : [])];
}
function property(model, idShort) {
  return elements(model).find((item) => item.idShort === idShort && item.value !== undefined)?.value;
}
function submodel(aas, idShort) { return aas.submodels?.find((item) => item.idShort === idShort); }

class Aas {
  constructor(file) { this.document = read(file); this.shell = this.document.assetAdministrationShells?.[0] || {}; }
  get(model, key) { return property(submodel(this.document, model), key); }
  specificAssetId(name) { return this.shell.assetInformation?.specificAssetIds?.find((item) => item.name === name)?.value || ''; }
  description() {
    return {
      cpsId: this.get('DigitalNameplate', 'CPSId') || this.specificAssetId('cpsId') || 'CPS-001',
      assetName: this.get('DigitalNameplate', 'AssetName') || this.get('DigitalNameplate', 'ManufacturerProductDesignation') || this.specificAssetId('assetName') || 'RoboSoldagemAlfa',
      aasId: this.shell.id || '',
      aasIdShort: this.shell.idShort || '',
      description: this.get('DigitalNameplate', 'Description') || '',
      manufacturer: this.get('DigitalNameplate', 'ManufacturerName') || this.specificAssetId('manufacturer') || '',
      assetType: this.get('DigitalNameplate', 'AssetType') || this.specificAssetId('assetType') || '',
      serialNumber: this.get('DigitalNameplate', 'SerialNumber') || this.specificAssetId('serialNumber') || '',
      globalAssetId: this.shell.assetInformation?.globalAssetId || '',
      dashboardUrl: this.get('Documents', 'DashboardURL') || '',
      thumbnailUrl: this.get('Documents', 'ThumbnailURL') || '',
      datasheetUrl: this.get('Documents', 'DatasheetPDF') || '/api/cps/datasheet/pdf',
      scientificReportUrl: this.get('Documents', 'ScientificReportPDF') || ''
    };
  }
  interfaces() { return { primaryProtocol: this.get('AssetInterfacesDescription', 'PrimaryProtocol') || 'MQTT', brokerHost: this.get('AssetInterfacesDescription', 'BrokerHost') || '', brokerPort: this.get('AssetInterfacesDescription', 'BrokerPort') || '', baseTopic: this.get('AssetInterfacesDescription', 'BaseTopic') || 'cps1' }; }
  lifecycle() { return { currentPhase: this.get('LifecycleIntegration', 'CurrentPhase') || 'play', supportedPhases: this.get('LifecycleIntegration', 'SupportedPhases') || 'plug, play, stop, maintenance, return, unplug' }; }
}

module.exports = Aas;
