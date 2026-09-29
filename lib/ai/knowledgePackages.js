const asObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const firstPresent = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== '');

const hasContent = (value) => {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== '';
};

const compactObject = (source) =>
  Object.fromEntries(Object.entries(source).filter(([, value]) => hasContent(value)));

export const buildLevel1KnowledgePackage = ({ cpsId, analytics = {}, adaptiveIntelligence = {} } = {}) => {
  const oee = asObject(analytics.oee);
  const learning = asObject(analytics.learning);
  const reasoning = asObject(analytics.reasoning);
  const evidence =
    analytics.evidence ||
    learning.basis ||
    analytics.basis ||
    analytics.timeSeriesFeatures?.quickSignals;

  return compactObject({
    cpsId,
    oee: firstPresent(oee.oee, oee.value, analytics.statistics?.oee_mean),
    availability: oee.availability,
    performance: oee.performance,
    quality: oee.quality,
    riskLevel: firstPresent(analytics.riskLevel, learning.riskLevel, reasoning.riskLevel),
    confidence: firstPresent(learning.confidence, analytics.confidence),
    dominantLoss: reasoning.dominantLoss,
    learningPattern: firstPresent(learning.type, learning.learned, analytics.learningPattern),
    evidence,
    reasoning,
    recommendation: firstPresent(learning.recommendation, reasoning.recommendation),
    forecastOEE: firstPresent(analytics.forecastOEE, analytics.predictedOEE, learning.forecastOEE),
    adaptiveIntelligence,
  });
};

export const buildLevel2KnowledgePackage = ({ analytics = {} } = {}) => {
  const globalOEE = analytics.globalOEE || analytics.oee || analytics.globalSummary || {};
  const derivedSystemLearning = compactObject({
    pattern: firstPresent(analytics.learningPattern, analytics.learnedPattern, analytics.systemPattern),
    dominantLoss: firstPresent(analytics.dominantChronicLoss, analytics.dominantLoss),
    confidence: firstPresent(analytics.confidence, analytics.riskSummary?.confidence),
  });

  return compactObject({
    globalOEE,
    criticalCPS: firstPresent(analytics.criticalCPS, analytics.criticalCps),
    criticalityRanking: firstPresent(analytics.criticalityRanking, analytics.criticality),
    systemLearningModel: firstPresent(
      analytics.systemLearningModel,
      analytics.derivedLearning,
      hasContent(derivedSystemLearning) ? derivedSystemLearning : null
    ),
    systemEvidence: firstPresent(analytics.systemEvidence, analytics.systemEvidenceList),
    systemCausality: analytics.systemCausality,
    systemForecast: firstPresent(analytics.systemForecast, analytics.predictedRisk),
    systemReasoning: firstPresent(analytics.systemReasoning, analytics.reasoning),
    recommendation: firstPresent(analytics.recommendation, analytics.actionPlan?.recommendation),
    executiveSummary: firstPresent(
      analytics.executiveSummary,
      analytics.explanation,
      analytics.systemReasoning?.executiveInterpretation
    ),
  });
};

export const buildLevel3KnowledgePackageForAI = (level3Package = {}) =>
  compactObject({
    multiAcsmInputs: level3Package.multiAcsmInputs,
    level3LearningModel: firstPresent(
      level3Package.level3LearningModel,
      level3Package.systemLearningModel
    ),
    globalSystemEvidence: firstPresent(
      level3Package.globalSystemEvidence,
      level3Package.systemEvidence
    ),
    globalSystemCausality: firstPresent(
      level3Package.globalSystemCausality,
      level3Package.systemCausality
    ),
    globalCriticalityRanking: firstPresent(
      level3Package.globalCriticalityRanking,
      level3Package.criticalityRanking
    ),
    acsmCriticalityRanking: level3Package.acsmCriticalityRanking,
    globalSystemForecast: firstPresent(
      level3Package.globalSystemForecast,
      level3Package.systemForecast
    ),
    globalExecutiveReasoning: firstPresent(
      level3Package.globalExecutiveReasoning,
      level3Package.systemReasoning,
      level3Package.reasoning
    ),
    recommendation: level3Package.recommendation,
    executiveSummary: level3Package.executiveSummary,
    globalOEE: level3Package.globalOEE,
    riskLevel: level3Package.riskLevel,
    confidence: level3Package.confidence,
    criticalCPS: level3Package.criticalCPS,
  });

export const buildLevel4KnowledgePackage = ({ decision = {}, knowledge = {}, context = {} } = {}) =>
  compactObject({
    corporateOptimizer: firstPresent(
      decision.corporateOptimizer,
      knowledge.corporateOptimizer,
      context.corporateOptimizer
    ),
    strategicFeedback: firstPresent(
      decision.strategicFeedback,
      knowledge.strategicFeedback,
      context.strategicFeedback,
      context.supplyChainFeedback
    ),
    decision,
    knowledge,
    risk: firstPresent(decision.riskLevel, knowledge.riskLevel, context.riskLevel),
    priority: firstPresent(
      decision.priority,
      decision.summary?.highPriorityCount,
      context.priority
    ),
    targetedFeedback: firstPresent(
      decision.targetedFeedback,
      knowledge.targetedFeedback,
      context.targetedFeedback
    ),
    recommendation: firstPresent(
      decision.recommendation,
      decision.coordinationMessage,
      knowledge.recommendation,
      context.recommendation
    ),
    alerts: firstPresent(decision.alerts, knowledge.alerts, context.alerts),
    expectedImpact: firstPresent(
      decision.expectedImpact,
      decision.actionPlan?.expectedImpact,
      context.expectedImpact
    ),
  });
