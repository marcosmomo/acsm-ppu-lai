export const FUNCTIONAL_EXTRACTION_VERSION = 'aas-functional-extractor/1.0.0';

const PLACEHOLDER = /(?:FIELD_CONFIRMATION_REQUIRED|CONFIRMATION_REQUIRED|VALIDATION_PENDING|PENDING_FIELD_CONFIRMATION|UNBOUND|UNKNOWN|NOT_CONFIRMED)/i;
const PHYSICAL = /(?:PHYSICALLY_VALIDATED|PHYSICAL_VALIDATED|EXPERIMENTALLY_VALIDATED)/i;
const BINDING = /(?:OPCUA|PLC|BINDING|ACCESSMODE)/i;
const VOLATILE = /^(?:timestamp|last.*(?:at|timestamp|update)|currentphase|operationalstate|health|availability)$/i;

const array = (value) => Array.isArray(value) ? value : [];
const text = (value) => value == null ? '' : String(value).trim();

function semanticReferences(element) {
  const references = [];
  for (const reference of [element?.semanticId, ...array(element?.supplementalSemanticIds)]) {
    for (const key of array(reference?.keys)) {
      if (text(key?.value)) references.push({ type: text(key?.type) || null, value: text(key.value) });
    }
  }
  return references.sort((a, b) => `${a.type}:${a.value}`.localeCompare(`${b.type}:${b.value}`));
}
function qualifiers(element) {
  return array(element?.qualifiers)
    .filter((item) => text(item?.type))
    .map((item) => ({ type: text(item.type), valueType: text(item.valueType) || null, value: item.value ?? null }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

function scalarProperties(elements) {
  const result = {};
  for (const element of array(elements)) {
    if (element?.modelType !== 'Property' || !text(element?.idShort) || VOLATILE.test(element.idShort)) continue;
    result[element.idShort] = {
      valueType: text(element.valueType) || null,
      value: element.value ?? null,
      semanticReferences: semanticReferences(element),
      qualifiers: qualifiers(element),
    };
  }
  return result;
}

function evidenceFor(element, attributes) {
  const evidenceText = JSON.stringify({ attributes, qualifiers: qualifiers(element) });
  const incompleteFields = [];
  for (const [name, attribute] of Object.entries(attributes)) {
    if (PLACEHOLDER.test(text(attribute?.value))) incompleteFields.push(name);
  }
  const pendingBinding = BINDING.test(evidenceText) && PLACEHOLDER.test(evidenceText);
  const bindingConfirmed = BINDING.test(evidenceText) && !pendingBinding;
  const physicallyValidated = PHYSICAL.test(evidenceText);
  return {
    level: physicallyValidated ? 'PHYSICALLY_VALIDATED' : bindingConfirmed ? 'BINDING_CONFIRMED' : 'DECLARED_ONLY',
    bindingStatus: pendingBinding ? 'PENDING' : bindingConfirmed ? 'CONFIRMED' : 'NOT_DECLARED',
    physicallyValidated,
    incompleteFields: incompleteFields.sort(),
  };
}

function declaration({ kind, submodel, element, path, name, enabled, attributes = {} }) {
  const semantics = semanticReferences(element);
  return {
    kind,
    source: {
      submodelId: text(submodel?.id) || null,
      submodelIdShort: text(submodel?.idShort),
      path,
      modelType: text(element?.modelType) || null,
      idShort: text(element?.idShort) || null,
    },
    name: text(name || element?.idShort),
    enabled: enabled == null ? null : enabled,
    semanticReferences: semantics,
    qualifiers: qualifiers(element),
    attributes,
    evidence: evidenceFor(element, attributes),
  };
}

function capabilityDeclarations(submodel, issues) {
  const declarations = [];
  for (const element of array(submodel?.submodelElements)) {
    const idShort = text(element?.idShort);
    if (!idShort) {
      issues.push({ severity: 'ERROR', code: 'REQUIRED_IDSHORT_MISSING', location: 'Capabilities' });
      continue;
    }
    const path = `${submodel.idShort}/${idShort}`;
    if (element.modelType === 'Property') {
      const booleanValue = /^(?:true|false)$/i.test(text(element.value))
        ? text(element.value).toLowerCase() === 'true'
        : null;
      declarations.push(declaration({
        kind: 'CAPABILITY', submodel, element, path,
        name: idShort === 'PrimaryCapability' ? element.value : idShort,
        enabled: booleanValue,
        attributes: {
          declarationValue: { valueType: text(element.valueType) || null, value: element.value ?? null },
        },
      }));
      continue;
    }
    if (element.modelType === 'SubmodelElementCollection') {
      const attributes = scalarProperties(element.value);
      declarations.push(declaration({
        kind: 'CAPABILITY', submodel, element, path,
        name: attributes.Name?.value || idShort,
        enabled: null,
        attributes,
      }));
      continue;
    }
    issues.push({ severity: 'ERROR', code: 'UNSUPPORTED_CAPABILITY_ELEMENT', location: path, modelType: element.modelType ?? null });
  }
  return declarations;
}

function serviceDeclarations(submodel, issues) {
  const declarations = [];
  for (const group of array(submodel?.submodelElements)) {
    const groupName = text(group?.idShort);
    if (!groupName) {
      issues.push({ severity: 'ERROR', code: 'REQUIRED_IDSHORT_MISSING', location: 'Services' });
      continue;
    }
    if (group.modelType === 'Property') {
      declarations.push(declaration({
        kind: 'SERVICE', submodel, element: group, path: `${submodel.idShort}/${groupName}`,
        name: groupName,
        enabled: /^(?:true|available)$/i.test(text(group.value)) ? true : null,
        attributes: { declarationValue: { valueType: text(group.valueType) || null, value: group.value ?? null } },
      }));
      continue;
    }
    if (group.modelType !== 'SubmodelElementCollection') {
      issues.push({ severity: 'ERROR', code: 'UNSUPPORTED_SERVICE_ELEMENT', location: `${submodel.idShort}/${groupName}` });
      continue;
    }
    for (const service of array(group.value)) {
      const serviceId = text(service?.idShort);
      if (!serviceId || service?.modelType !== 'Property') {
        issues.push({ severity: 'ERROR', code: 'INVALID_SERVICE_DECLARATION', location: `${submodel.idShort}/${groupName}` });
        continue;
      }
      const value = service.value;
      const booleanDeclaration = /^(?:true|false)$/i.test(text(value));
      declarations.push(declaration({
        kind: 'SERVICE', submodel, element: service,
        path: `${submodel.idShort}/${groupName}/${serviceId}`,
        name: booleanDeclaration ? serviceId : value,
        enabled: booleanDeclaration ? text(value).toLowerCase() === 'true' : null,
        attributes: {
          serviceGroup: { valueType: 'xs:string', value: groupName },
          declarationValue: { valueType: text(service.valueType) || null, value: value ?? null },
        },
      }));
    }
  }
  return declarations;
}

export function extractFunctionalDeclarations(aasEnvironment) {
  const issues = [];
  const shell = array(aasEnvironment?.assetAdministrationShells)[0] || null;
  if (!shell) issues.push({ severity: 'ERROR', code: 'AAS_SHELL_MISSING', location: 'assetAdministrationShells[0]' });
  const submodels = array(aasEnvironment?.submodels);
  const capabilities = submodels.find((item) => item?.idShort === 'Capabilities');
  const services = submodels.find((item) => item?.idShort === 'Services');
  if (!capabilities) issues.push({ severity: 'ERROR', code: 'CAPABILITIES_SUBMODEL_MISSING', location: 'submodels' });
  if (!services) issues.push({ severity: 'WARNING', code: 'SERVICES_SUBMODEL_MISSING', location: 'submodels' });

  const declarations = [
    ...(capabilities ? capabilityDeclarations(capabilities, issues) : []),
    ...(services ? serviceDeclarations(services, issues) : []),
  ];
  if (!declarations.some((item) => item.kind === 'CAPABILITY')) {
    issues.push({ severity: 'ERROR', code: 'CAPABILITY_DECLARATION_MISSING', location: 'Capabilities' });
  }
  for (const item of declarations) {
    if (!item.semanticReferences.length) {
      issues.push({ severity: 'WARNING', code: 'OPTIONAL_SEMANTIC_ID_MISSING', location: item.source.path });
    }
    if (item.evidence.incompleteFields.length) {
      issues.push({ severity: 'WARNING', code: 'UNCONFIRMED_FIELDS', location: item.source.path, fields: item.evidence.incompleteFields });
    }
  }

  return {
    extractionVersion: FUNCTIONAL_EXTRACTION_VERSION,
    source: {
      aasId: text(shell?.id) || null,
      aasIdShort: text(shell?.idShort) || null,
      assetId: text(shell?.assetInformation?.globalAssetId) || null,
      administration: shell?.administration ? {
        version: text(shell.administration.version) || null,
        revision: text(shell.administration.revision) || null,
      } : null,
    },
    declarations,
    issues,
    completeness: issues.some((item) => item.severity === 'ERROR') ? 'INCOMPLETE' : issues.length ? 'COMPLETE_WITH_WARNINGS' : 'COMPLETE',
  };
}
