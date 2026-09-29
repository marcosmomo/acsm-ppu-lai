const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

const FLOW_PATHS = [
  "node-red/cps7-flow.json",
  "ACSM-2/node-red/cps2-flow.json",
  "ACSM-2/node-red/cps4-flow.json",
  "ACSM-2/node-red/cps6-flow.json",
  "ACSM-3/node-red/cps3-flow.json",
  "ACSM-3/node-red/cps8-flow.json",
  "ACSM-3/node-red/cps9-flow.json",
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function localIntelligenceBlock() {
  return [
    "// --------------------------------------------------",
    "// 7) Inteligencia local explicita: learning, baseline, anomaly, causality e forecast",
    "// --------------------------------------------------",
    "function metricStats(key, currentValue, defaultStd = 0.0001) {",
    "    const stats = timeSeriesFeatures?.[key] || {};",
    "    const mean = num(stats.mean ?? stats.median ?? currentValue, currentValue);",
    "    const std = Math.max(Math.abs(num(stats.std, 0)), defaultStd);",
    "    return { mean: round(mean), std: round(std) };",
    "}",
    "",
    "function signedDeviation(currentValue, stats) {",
    "    const value = num(currentValue, stats.mean);",
    "    const std = Math.max(num(stats.std, 0), 0.0001);",
    "    return (value - num(stats.mean, value)) / std;",
    "}",
    "",
    "function describePattern(pattern, dominantVariable, stability) {",
    "    if (pattern === \"chronic_availability_loss\") return \"availability has been the dominant local loss over consecutive windows\";",
    "    if (pattern === \"chronic_performance_loss\") return \"performance has been the dominant local loss over consecutive windows\";",
    "    if (pattern === \"degrading_system\") return \"local OEE trend is degrading against the recent baseline\";",
    "    if (pattern === \"recovering_system\") return \"local OEE trend is recovering against the recent baseline\";",
    "    if (pattern === \"unstable_oscillation\") return \"local signals are oscillating above the expected stability band\";",
    "    if (pattern === \"insufficient_history\") return \"local temporal window is still warming up\";",
    "    return dominantVariable + \" is the current dominant local signal with \" + stability + \" stability\";",
    "}",
    "",
    "const availabilityValue = num(oeeBlock.availability, 0);",
    "const performanceValue = num(oeeBlock.performanceAccumulated ?? oeeBlock.performance, 0);",
    "const qualityValue = num(oeeBlock.quality, 1);",
    "const currentOeeValue = num(oeeBlock.current, 0);",
    "",
    "const losses = reasoning.losses || {",
    "    availability: round(Math.max(0, 1 - availabilityValue)),",
    "    performance: round(Math.max(0, 1 - performanceValue)),",
    "    quality: round(Math.max(0, 1 - qualityValue))",
    "};",
    "",
    "const dominantLoss =",
    "    reasoning.dominantLossNow ||",
    "    reasoning.dominantLoss ||",
    "    Object.entries(losses).sort((a, b) => num(b[1], 0) - num(a[1], 0))[0]?.[0] ||",
    "    null;",
    "",
    "const learningPattern = learning.pattern || learning.learned || features.learningPattern || \"unknown_pattern\";",
    "const learningConfidence = round(num(learning.confidence ?? reasoning.confidence, 0.5));",
    "const windowSize = num(timeSeriesFeatures?.historySize, 0) || 5;",
    "",
    "let stability = \"persistent\";",
    "if (learningPattern === \"unstable_oscillation\") stability = \"unstable\";",
    "else if (learningPattern === \"recovering_system\") stability = \"improving\";",
    "else if (learningPattern === \"degrading_system\") stability = \"degrading\";",
    "else if (learning.state === \"warming_up\") stability = \"unstable\";",
    "",
    "const learningModel = {",
    "    model: learning.model || \"local_temporal_learning\",",
    "    pattern: learningPattern,",
    "    windowSize,",
    "    dominantVariable: dominantLoss,",
    "    stability,",
    "    confidence: learningConfidence,",
    "    description: describePattern(learningPattern, dominantLoss || \"oee\", stability)",
    "};",
    "",
    "const baseline = {",
    "    temperature: metricStats(\"temperature\", telemetryBlock.temperature, 0.1),",
    "    cycleTimeMs: metricStats(\"cycleTimeMs\", telemetryBlock.cycleTimeMs, 1),",
    "    rpm: metricStats(\"rpm\", telemetryBlock.rpm, 1),",
    "    torque: metricStats(\"torque\", telemetryBlock.torque, 0.1),",
    "    availability: metricStats(\"availability\", availabilityValue, 0.0001),",
    "    performance: metricStats(\"performance\", performanceValue, 0.0001),",
    "    quality: metricStats(\"quality\", qualityValue, 0.0001),",
    "    oee: metricStats(\"oee\", currentOeeValue, 0.0001)",
    "};",
    "",
    "const deviations = {",
    "    temperature: signedDeviation(telemetryBlock.temperature, baseline.temperature),",
    "    cycleTimeMs: signedDeviation(telemetryBlock.cycleTimeMs, baseline.cycleTimeMs),",
    "    rpm: signedDeviation(telemetryBlock.rpm, baseline.rpm),",
    "    torque: signedDeviation(telemetryBlock.torque, baseline.torque),",
    "    availability: signedDeviation(availabilityValue, baseline.availability),",
    "    performance: signedDeviation(performanceValue, baseline.performance),",
    "    quality: signedDeviation(qualityValue, baseline.quality)",
    "};",
    "",
    "const affectedVariables = Object.entries(deviations)",
    "    .filter(([, value]) => Math.abs(value) >= 2)",
    "    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))",
    "    .map(([key]) => key);",
    "",
    "const maxDeviation = Object.values(deviations).reduce((max, value) => Math.max(max, Math.abs(num(value, 0))), 0);",
    "const anomalyScore = round(Math.max(num(learning.anomalyScore, 0), Math.min(1, maxDeviation / 4)));",
    "let anomalyStatus = \"normal\";",
    "if (learningPattern === \"unstable_oscillation\" || affectedVariables.length >= 2) anomalyStatus = \"unstable\";",
    "else if (affectedVariables.some((key) => num(deviations[key], 0) > 0)) anomalyStatus = \"above_normal\";",
    "else if (affectedVariables.some((key) => num(deviations[key], 0) < 0)) anomalyStatus = \"below_normal\";",
    "",
    "const anomaly = {",
    "    score: anomalyScore,",
    "    status: anomalyStatus,",
    "    affectedVariables",
    "};",
    "",
    "const derivedEvidence = [];",
    "if (availabilityValue < 0.7) derivedEvidence.push(\"availability below 70% in the current local window\");",
    "if (availabilityValue < num(baseline.availability.mean, availabilityValue) - Math.max(0.05, num(baseline.availability.std, 0))) derivedEvidence.push(\"availability below local baseline\");",
    "if (performanceValue < 0.75) derivedEvidence.push(\"performance below 75% in the current local window\");",
    "if (qualityValue < 0.95) derivedEvidence.push(\"quality below 95% in the current local window\");",
    "if (num(telemetryBlock.cycleTimeMs, 0) > num(baseline.cycleTimeMs.mean, 0) + Math.max(num(baseline.cycleTimeMs.std, 0) * 2, 1)) derivedEvidence.push(\"cycle time above local baseline\");",
    "if (num(deviations.temperature, 0) >= 2) derivedEvidence.push(\"temperature above local baseline\");",
    "if (Math.abs(num(deviations.torque, 0)) >= 2) derivedEvidence.push(\"torque outside local baseline band\");",
    "if (Math.abs(num(deviations.rpm, 0)) >= 2) derivedEvidence.push(\"rpm outside local baseline band\");",
    "if (num(timeBlock.downtimeMs, 0) > 0) derivedEvidence.push(\"downtime accumulated in the local OEE window\");",
    "if ([\"awaiting_replacement\", \"maintenance\", \"failure\"].includes(featureStatus)) derivedEvidence.push(\"local feature status is \" + featureStatus);",
    "if (num(productionBlock.rejectDelta, 0) > 0) derivedEvidence.push(\"reject pieces detected in the last interval\");",
    "",
    "const localEvidence = uniq([...evidence, ...derivedEvidence]);",
    "",
    "let probableCause = reasoning.probableCause || \"normal operation\";",
    "let causeType = dominantLoss ? dominantLoss + \"_loss\" : \"normal\";",
    "let relatedSignals = [];",
    "let causalConfidence = round(num(reasoning.confidence ?? learning.confidence, 0.5));",
    "",
    "if (availabilityValue < 0.7 && (num(timeBlock.downtimeMs, 0) > 0 || [\"awaiting_replacement\", \"maintenance\", \"failure\"].includes(featureStatus))) {",
    "    probableCause = \"recurrent stoppage\";",
    "    causeType = \"availability_loss\";",
    "    relatedSignals = [\"downtime\", \"feature_status\", \"availability_drop\"];",
    "} else if (performanceValue < 0.75 && num(telemetryBlock.cycleTimeMs, 0) > num(baseline.cycleTimeMs.mean, 0) + Math.max(num(baseline.cycleTimeMs.std, 0), 1)) {",
    "    probableCause = \"execution slowdown\";",
    "    causeType = \"performance_loss\";",
    "    relatedSignals = [\"cycle_time_increase\", \"performance_drop\"];",
    "} else if (qualityValue < 0.95 && num(productionBlock.rejectDelta, 0) > 0) {",
    "    probableCause = \"process instability\";",
    "    causeType = \"quality_loss\";",
    "    relatedSignals = [\"reject_delta\", \"quality_drop\"];",
    "} else if (affectedVariables.some((key) => [\"temperature\", \"torque\", \"rpm\"].includes(key))) {",
    "    probableCause = \"abnormal operating condition\";",
    "    causeType = \"operating_condition_anomaly\";",
    "    relatedSignals = affectedVariables.filter((key) => [\"temperature\", \"torque\", \"rpm\"].includes(key));",
    "}",
    "",
    "if (anomaly.score >= 0.7) causalConfidence = round(Math.max(causalConfidence, 0.78));",
    "else if (localEvidence.length >= 3) causalConfidence = round(Math.max(causalConfidence, 0.68));",
    "",
    "const causality = {",
    "    probableCause,",
    "    causeType,",
    "    relatedSignals,",
    "    causalConfidence",
    "};",
    "",
    "let trend = \"stable\";",
    "if (learningPattern === \"degrading_system\" || stability === \"degrading\") trend = \"negative\";",
    "else if (learningPattern === \"recovering_system\" || stability === \"improving\") trend = \"positive\";",
    "else if (learningPattern === \"unstable_oscillation\") trend = \"unstable\";",
    "",
    "let nextState = \"stable_operation\";",
    "if (learningPattern === \"degrading_system\" && stability === \"degrading\") nextState = anomaly.score >= 0.7 ? \"failure_risk\" : \"maintenance_required\";",
    "else if (learningPattern === \"recovering_system\") nextState = \"stabilizing\";",
    "else if (learningPattern === \"unstable_oscillation\") nextState = \"unstable\";",
    "else if (causality.causeType === \"availability_loss\" && anomaly.score >= 0.6) nextState = \"maintenance_required\";",
    "",
    "const forecastOee = Array.isArray(learning.forecastOEE) && learning.forecastOEE.length",
    "    ? num(learning.forecastOEE[0], currentOeeValue)",
    "    : currentOeeValue + (trend === \"negative\" ? -0.05 : trend === \"positive\" ? 0.03 : 0);",
    "const forecastRisk = reasoning.riskLevel || (nextState === \"failure_risk\" ? \"high\" : nextState === \"maintenance_required\" || nextState === \"unstable\" ? \"medium\" : \"low\");",
    "",
    "const forecast = {",
    "    nextState,",
    "    timeHorizon: \"short_term\",",
    "    risk: forecastRisk,",
    "    confidence: round(Math.max(num(learning.confidence, 0.5), num(reasoning.confidence, 0.5))),",
    "    expectedOEE: round(Math.max(0, Math.min(1, forecastOee)))",
    "};",
    "",
    "const primaryIssue = dominantLoss",
    "    ? dominantLoss + \" loss due to \" + causality.probableCause",
    "    : \"no dominant local loss detected\";",
    "const operationalState = trend === \"negative\" ? \"degrading\" : trend === \"positive\" ? \"recovering\" : trend === \"unstable\" ? \"unstable\" : \"stable\";",
    "const executiveInterpretation = operationalState === \"stable\"",
    "    ? \"local operation remains stable with no dominant loss escalation\"",
    "    : \"local \" + operationalState + \" behavior driven by \" + (dominantLoss || \"oee\") + \" signal\";",
    "",
    "const enrichedReasoning = {",
    "    operationalState,",
    "    dominantLoss,",
    "    primaryIssue,",
    "    probableCause: causality.probableCause,",
    "    trend,",
    "    confidence: round(num(reasoning.confidence ?? learning.confidence, 0.5)),",
    "    executiveInterpretation,",
    "    recommendation: reasoning.recommendation || learning.recommendation || \"Maintain monitoring of local CPS signals.\",",
    "    causality,",
    "    supportingEvidence: localEvidence,",
    "    learningModel",
    "};",
    "",
  ].join("\n");
}

function enrichBuildFunction(func) {
  let next = func;
  const hasLocalIntelligence = func.includes("const learningModel = {") && func.includes("const causality = {");

  if (!hasLocalIntelligence) {
    const block = localIntelligenceBlock();

    next = next.replace(
      "// --------------------------------------------------\n// 7) Payload final para ACSM\n// --------------------------------------------------\nconst acsmPayload = {",
      `${block}// --------------------------------------------------\n// 8) Payload final para ACSM\n// --------------------------------------------------\nconst acsmPayload = {`
    );

    next = next.replace(
      "    timeSeriesFeatures,\n\n    learning: {",
      "    timeSeriesFeatures,\n\n    learningModel,\n    causality,\n    baseline,\n    anomaly,\n    forecast,\n\n    learningPattern,\n    learningConsensus: learning.consensus || learning.learningConsensus || learningPattern,\n    recommendation: enrichedReasoning.recommendation,\n    availability: oeeBlock.availability,\n    performance: oeeBlock.performance,\n    quality: oeeBlock.quality,\n    oee: oeeBlock.current,\n    confidence: enrichedReasoning.confidence,\n    riskLevel: forecast.risk,\n    trend,\n\n    learning: {"
    );
  }

  next = next.replace(
    "        evidence: Array.isArray(learning.evidence) ? learning.evidence : [],",
    "        evidence: localEvidence,"
  );

  next = next.replace(
    "    reasoning: {\n        model: reasoning.model || null,",
    "    reasoning: {\n        ...enrichedReasoning,\n\n        model: reasoning.model || null,"
  );

  next = next.replace(
    "        probableCause: reasoning.probableCause || null,",
    "        probableCause: causality.probableCause || reasoning.probableCause || null,"
  );

  next = next.replace(
    "        confidence: reasoning.confidence ?? null,\n        explanation: reasoning.explanation || null,\n        recommendation: reasoning.recommendation || null,\n        evidence: Array.isArray(reasoning.evidence) ? reasoning.evidence : [],",
    "        confidence: enrichedReasoning.confidence,\n        explanation: reasoning.explanation || enrichedReasoning.executiveInterpretation,\n        recommendation: enrichedReasoning.recommendation,\n        evidence: localEvidence,"
  );

  next = next.replace(
    "        dominantLoss: reasoning.dominantLossNow || reasoning.dominantLoss || null,",
    "        dominantLoss,"
  );

  next = next.replace(
    "        riskLevel: reasoning.riskLevel || null,",
    "        riskLevel: reasoning.riskLevel || forecast.risk,"
  );

  next = next.replace(
    "        losses: reasoning.losses || {\n            availability: Math.max(0, 1 - num(p.availability, 1)),\n            performance: Math.max(0, 1 - num(p.performanceAccumulated ?? p.performance, 1)),\n            quality: Math.max(0, 1 - num(p.quality, 1))\n        }",
    "        losses"
  );

  next = next.replace("    evidence,\n", "    evidence: localEvidence,\n");

  next = next.replace("// 8) Persist", "// 9) Persist");
  next = next.replace("// 9) Sa", "// 10) Sa");

  return next;
}

function main() {
  const changed = [];

  for (const relativePath of FLOW_PATHS) {
    const filePath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(filePath)) continue;

    const flow = readJson(filePath);
    let fileChanged = false;

    for (const node of flow) {
      if (node.type !== "function" || !/^Build CPS\d+ Payload for ACSM$/.test(node.name || "")) continue;
      const updated = enrichBuildFunction(node.func || "");
      if (updated !== node.func) {
        node.func = updated;
        fileChanged = true;
      }
    }

    if (fileChanged) {
      writeJson(filePath, flow);
      changed.push(relativePath);
    }
  }

  process.stdout.write(changed.length ? `${changed.join("\n")}\n` : "No flow changes needed.\n");
}

main();
