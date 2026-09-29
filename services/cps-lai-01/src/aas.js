'use strict';

const fs = require('node:fs');

class AasRepository {
  constructor(file) {
    this.file = file;
  }

  read() {
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }

  description(config) {
    const aas = this.read();
    const shell = aas.assetAdministrationShells?.[0] || {};
    return {
      cpsId: config.cpsId,
      formalId: config.formalId,
      assetName: config.cpsName,
      displayName: shell.displayName?.[0]?.text || config.cpsName,
      assetType: shell.assetInformation?.assetType || 'Distribution/Conveyor Station',
      description: shell.description?.[0]?.text || '',
      aasId: shell.id || null,
    };
  }
}

module.exports = AasRepository;
