'use strict';
const fs = require('node:fs');

function elements(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.submodelElements) ? node.submodelElements.flatMap(elements) : []), ...(Array.isArray(node.value) ? node.value.flatMap(elements) : [])];
}
function property(model, idShort) { return elements(model).find((item) => item.idShort === idShort && item.value !== undefined)?.value; }

class Aas {
  constructor(file, config) { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); this.shell = this.data.assetAdministrationShells?.[0] || {}; this.config = config; }
  get(model, key) { return property(this.data.submodels?.find((item) => item.idShort === model), key); }
  specific(name) { return this.shell.assetInformation?.specificAssetIds?.find((item) => item.name === name)?.value || ''; }
  description() {
    return {
      cpsId: this.get('DigitalNameplate', 'CPSId') || this.specific('cpsId') || this.config.cpsId,
      assetName: this.get('DigitalNameplate', 'ManufacturerProductDesignation') || this.specific('assetName') || this.config.cpsName,
      aasId: this.shell.id || '', aasIdShort: this.shell.idShort || '', description: this.shell.description?.[0]?.text || '',
      manufacturer: this.get('DigitalNameplate', 'ManufacturerName') || this.specific('manufacturer') || '',
      assetType: this.specific('assetType') || 'VisionInspectionSystem', serialNumber: this.get('DigitalNameplate', 'SerialNumber') || this.specific('serialNumber') || '',
      globalAssetId: this.shell.assetInformation?.globalAssetId || '', dashboardUrl: this.get('Documents', 'DashboardURL') || '',
      thumbnailUrl: this.get('Documents', 'ThumbnailURL') || '', scientificReportUrl: this.get('Documents', 'ScientificReportPDF') || '',
      datasheetUrl: this.get('Documents', 'DatasheetPDF') || '/api/cps/datasheet/pdf'
    };
  }
  interfaces() { return { primaryProtocol: 'MQTT', brokerHost: this.get('AssetInterfacesDescription', 'BrokerHost') || 'localhost', brokerPort: Number(this.get('AssetInterfacesDescription', 'BrokerPort') || 1883), baseTopic: this.config.baseTopic, topics: { command: `${this.config.baseTopic}/cmd`, status: `${this.config.baseTopic}/status`, health: `${this.config.baseTopic}/health`, oee: `${this.config.baseTopic}/oee`, data: `${this.config.baseTopic}/data`, ack: `${this.config.baseTopic}/ack`, learning: `acsm/${this.config.baseTopic}/learning` } }; }
  lifecycle() { return { currentPhase: this.get('LifecycleIntegration', 'CurrentPhase') || 'play', supportedPhases: this.get('LifecycleIntegration', 'SupportedPhases') || 'plug, play, stop, maintenance, return, unplug' }; }
}
module.exports = Aas;
