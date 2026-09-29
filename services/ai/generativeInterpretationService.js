const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_PROMPT_CHARS = 14000;
const MAX_TEXT_CHARS = 520;
const CACHE_TTL_MS = 30000;

const responseCache = new Map();

export const GENERATIVE_INTERPRETATION_SCHEMA_VERSION = '1.0';

const allowedLevels = new Set(['level1', 'level2', 'level3', 'level4']);
const allowedContextTypes = new Set(['operational', 'system', 'executive', 'strategic']);
const allowedOutputTypes = new Set([
  'summary',
  'diagnosis',
  'prediction',
  'recommendation',
  'decision_justification',
  'knowledge_evolution',
]);

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    diagnosis: { type: 'string' },
    prediction: { type: 'string' },
    recommendation: { type: 'string' },
    decisionJustification: { type: 'string' },
    riskInterpretation: { type: 'string' },
    confidenceInterpretation: { type: 'string' },
  },
  required: [
    'summary',
    'diagnosis',
    'prediction',
    'recommendation',
    'decisionJustification',
    'riskInterpretation',
    'confidenceInterpretation',
  ],
};

const emptyInterpretation = () => ({
  summary: 'Evidence is insufficient for a generative interpretation.',
  diagnosis: 'Evidence is insufficient.',
  prediction: 'Evidence is insufficient.',
  recommendation: 'Use the recommendation already present in the knowledge package.',
  decisionJustification: 'No new decision was generated; this text only explains existing knowledge.',
  riskInterpretation: 'Evidence is insufficient.',
  confidenceInterpretation: 'Confidence is limited because evidence is incomplete.',
  generatedAt: new Date().toISOString(),
  model: 'gemini',
  fallback: true,
});

const toPlainObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const text = (value, fallback = '') => {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
};

const truncate = (value, max = MAX_TEXT_CHARS) => {
  const normalized = text(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3).trim()}...`;
};

const numberText = (value, digits = 2) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : '';
};

const pctText = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}%` : '';
};

const firstPresent = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

const normalizeLevel = (value) => {
  const normalized = text(value, 'level1').toLowerCase();
  return allowedLevels.has(normalized) ? normalized : 'level1';
};

const normalizeContextType = (value, level) => {
  const normalized = text(value).toLowerCase();
  if (allowedContextTypes.has(normalized)) return normalized;
  if (level === 'level4') return 'strategic';
  if (level === 'level3') return 'executive';
  if (level === 'level2') return 'system';
  return 'operational';
};

const normalizeOutputType = (value) => {
  const normalized = text(value, 'summary').toLowerCase();
  return allowedOutputTypes.has(normalized) ? normalized : 'summary';
};

export const normalizeGenerativeInterpretationRequest = (body = {}) => {
  const source = toPlainObject(body);
  const legacyKnowledgePackage = {
    cpsId: source.cpsId || source.targetCps || source.sourceCps,
    blockName: source.blockName || source.name,
    blockFunction: source.blockFunction || source.function || source.description,
    metrics: toPlainObject(source.metrics),
    states: toPlainObject(source.states),
    timeline: Array.isArray(source.timeline) ? source.timeline.slice(-8) : [],
    notes: Array.isArray(source.notes) ? source.notes.slice(-6) : [],
    oee: source.oee,
    availability: source.availability,
    performance: source.performance,
    quality: source.quality,
    riskLevel: source.riskLevel,
    confidence: source.confidence,
    dominantLoss: source.dominantLoss,
    criticalCPS: source.criticalCPS || source.criticalCps,
    learningPattern: source.learningPattern,
    evidence: source.evidence,
    causality: source.causality,
    forecast: source.forecast,
    recommendation: source.recommendation,
    feedback: source.feedback,
  };

  const level = normalizeLevel(source.level);

  return {
    level,
    contextType: normalizeContextType(source.contextType, level),
    knowledgePackage:
      source.knowledgePackage && typeof source.knowledgePackage === 'object'
        ? source.knowledgePackage
        : legacyKnowledgePackage,
    language: text(source.language, 'en'),
    outputType: normalizeOutputType(source.outputType),
  };
};

const extractKnowledgeSignals = (knowledgePackage = {}) => {
  const kp = toPlainObject(knowledgePackage);
  const metrics = toPlainObject(kp.metrics);
  const states = toPlainObject(kp.states);
  const oeeObject = toPlainObject(kp.oee || kp.globalOEE || kp.globalOee);
  const learning = toPlainObject(kp.learning || kp.systemLearningModel || kp.derivedLearning);
  const reasoning = toPlainObject(kp.reasoning || kp.systemReasoning);
  const forecast = toPlainObject(kp.forecast || kp.systemForecast || kp.predictedRisk);

  return {
    oee: firstPresent(kp.oee, kp.globalOEE, metrics.oee, metrics.globalOee, oeeObject.oee, oeeObject.current),
    availability: firstPresent(kp.availability, metrics.availability, oeeObject.availability),
    performance: firstPresent(kp.performance, metrics.performance, oeeObject.performance),
    quality: firstPresent(kp.quality, metrics.quality, oeeObject.quality),
    riskLevel: firstPresent(kp.riskLevel, states.riskLevel, states.predictedRisk, forecast.risk, forecast.level),
    confidence: firstPresent(kp.confidence, metrics.confidence, learning.confidence, forecast.confidence),
    dominantLoss: firstPresent(kp.dominantLoss, reasoning.dominantLoss, learning.dominantLoss),
    criticalCPS: firstPresent(kp.criticalCPS, kp.criticalCps, learning.criticalCps),
    learningPattern: firstPresent(kp.learningPattern, kp.learnedPattern, learning.pattern),
    evidence: firstPresent(kp.evidence, kp.systemEvidence, kp.systemEvidenceList, learning.evidence),
    causality: firstPresent(kp.causality, kp.systemCausality, reasoning.probableCause),
    forecast: firstPresent(kp.forecast, kp.systemForecast, kp.predictedRisk),
    recommendation: firstPresent(kp.recommendation, reasoning.recommendation, kp.actionPlan?.recommendation),
    feedback: firstPresent(kp.feedback, kp.operationalFeedback),
  };
};

const compactKnowledgePackage = (request) => {
  const packageJson = JSON.stringify(request.knowledgePackage || {});
  const clippedPackage =
    packageJson.length > MAX_PROMPT_CHARS
      ? `${packageJson.slice(0, MAX_PROMPT_CHARS)}... [truncated]`
      : packageJson;

  return {
    ...request,
    knowledgePackage: JSON.parse(clippedPackage.endsWith('... [truncated]') ? '{}' : clippedPackage),
    clippedKnowledgePackage: clippedPackage,
  };
};

const buildPrompt = (request) => {
  const compact = compactKnowledgePackage(request);

  return [
    'You are a Generative AI Interpretation layer for an industrial ACSM architecture.',
    'Return ONLY raw JSON matching the requested schema.',
    'Use concise English unless the request language explicitly asks otherwise.',
    'Interpret only the structured knowledge supplied in the input.',
    'You may transform OEE, availability, performance, quality, riskLevel, confidence, dominantLoss, criticalCPS, learningPattern, evidence, causality, forecast, recommendation, feedback, effectiveness, and experience learned into natural language.',
    'Do not recalculate metrics.',
    'Do not change or improve recommendations.',
    'Do not replace reasoning.',
    'Do not create a new operational decision.',
    'Do not infer missing measurements, causes, timestamps, forecasts, actions, or risks.',
    'If a field lacks evidence, say "Evidence is insufficient."',
    'Required JSON shape:',
    '{"summary":"","diagnosis":"","prediction":"","recommendation":"","decisionJustification":"","riskInterpretation":"","confidenceInterpretation":""}',
    `Request metadata: ${JSON.stringify({
      level: compact.level,
      contextType: compact.contextType,
      language: compact.language,
      outputType: compact.outputType,
    })}`,
    `Knowledge package JSON: ${compact.clippedKnowledgePackage}`,
  ].join('\n');
};

const cleanJsonText = (value) =>
  String(value || '')
    .trim()
    .replace(/^\uFEFF/, '')
    .replace(/^Here is the JSON requested:\s*/i, '')
    .replace(/^Here is the JSON:\s*/i, '')
    .replace(/^Here is the requested JSON:\s*/i, '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

const parseGeminiText = (payload) => {
  const rawText =
    payload?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text)
      .filter(Boolean)
      .join('') || '';

  if (!rawText) return null;
  const cleaned = cleanJsonText(rawText);

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/) || rawText.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
};

const parseRetryDelayMs = (payload) => {
  const retryInfo = payload?.error?.details?.find?.((detail) =>
    String(detail?.['@type'] || '').includes('RetryInfo')
  );
  const retryDelay = retryInfo?.retryDelay || payload?.retryDelay || '';
  const match = String(retryDelay).match(/^(\d+(?:\.\d+)?)s$/);
  if (!match) return null;
  return Math.max(0, Math.ceil(Number(match[1]) * 1000));
};

const normalizeInterpretation = (value, model, fallback = false) => {
  const source = { ...emptyInterpretation(), ...toPlainObject(value) };

  return {
    summary: truncate(source.summary),
    diagnosis: truncate(source.diagnosis),
    prediction: truncate(source.prediction),
    recommendation: truncate(source.recommendation),
    decisionJustification: truncate(source.decisionJustification),
    riskInterpretation: truncate(source.riskInterpretation),
    confidenceInterpretation: truncate(source.confidenceInterpretation),
    generatedAt: text(source.generatedAt, new Date().toISOString()),
    model: model || 'gemini',
    fallback: Boolean(fallback),
  };
};

export const buildFallbackInterpretation = (request, model = 'gemini', reason = 'fallback') => {
  const signals = extractKnowledgeSignals(request?.knowledgePackage);
  const oeeParts = [
    pctText(signals.oee) && `OEE ${pctText(signals.oee)}`,
    pctText(signals.availability) && `availability ${pctText(signals.availability)}`,
    pctText(signals.performance) && `performance ${pctText(signals.performance)}`,
    pctText(signals.quality) && `quality ${pctText(signals.quality)}`,
  ].filter(Boolean);
  const risk = text(signals.riskLevel);
  const confidence = numberText(signals.confidence);
  const dominantLoss = text(signals.dominantLoss);
  const criticalCPS = text(
    typeof signals.criticalCPS === 'object'
      ? signals.criticalCPS?.cpsId || signals.criticalCPS?.name
      : signals.criticalCPS
  );
  const learningPattern = text(signals.learningPattern);
  const recommendation = text(signals.recommendation, 'No recommendation was provided in the knowledge package.');

  return normalizeInterpretation(
    {
      summary: oeeParts.length
        ? `Fallback interpretation: ${oeeParts.join(', ')}.`
        : 'Fallback interpretation generated from the available knowledge package.',
      diagnosis: [
        dominantLoss && `Dominant loss is ${dominantLoss}`,
        criticalCPS && `critical CPS is ${criticalCPS}`,
        learningPattern && `learning pattern is ${learningPattern}`,
      ].filter(Boolean).join('; ') || 'Evidence is insufficient.',
      prediction: signals.forecast
        ? `Forecast evidence is present in the package and should be read as an existing prediction, not a new AI prediction.`
        : 'Evidence is insufficient.',
      recommendation,
      decisionJustification:
        'This text explains existing knowledge only; no operational decision was created or modified.',
      riskInterpretation: risk ? `Existing risk level is ${risk}.` : 'Evidence is insufficient.',
      confidenceInterpretation: confidence
        ? `Existing confidence score is ${confidence}.`
        : `Fallback confidence is limited because Gemini was unavailable (${reason}).`,
    },
    model,
    true
  );
};

export const toLegacyAnalysis = (interpretation = {}) => ({
  summary: interpretation.summary,
  indicatorInterpretation: interpretation.diagnosis,
  temporalDynamics: interpretation.prediction,
  riskAssessment: interpretation.riskInterpretation,
  operationalImplication: interpretation.decisionJustification,
  recommendation: interpretation.recommendation,
  confidenceNote: interpretation.confidenceInterpretation,
});

const getCachedResponse = (key) => {
  const cached = responseCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    responseCache.delete(key);
    return null;
  }
  return cached.value;
};

const setCachedResponse = (key, value) => {
  responseCache.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value,
  });
};

export async function describeKnowledgePackage(body = {}, options = {}) {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const model = options.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const request = normalizeGenerativeInterpretationRequest(body);
  const cacheKey = JSON.stringify({ model, request });
  const cached = getCachedResponse(cacheKey);

  if (cached) {
    return {
      ...cached,
      cacheHit: true,
    };
  }

  if (!apiKey) {
    const fallback = buildFallbackInterpretation(request, model, 'missing_api_key');
    return {
      ...fallback,
      schemaVersion: GENERATIVE_INTERPRETATION_SCHEMA_VERSION,
      level: request.level,
      contextType: request.contextType,
      outputType: request.outputType,
      provider: 'gemini',
      enrichedAnalysis: toLegacyAnalysis(fallback),
      cacheHit: false,
      fallbackReason: 'missing_api_key',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 18000);

  try {
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: buildPrompt(request) }],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 900,
            responseMimeType: 'application/json',
            responseJsonSchema: responseSchema,
            thinkingConfig: {
              thinkingBudget: 0,
            },
          },
        }),
        signal: controller.signal,
      }
    );

    const geminiPayload = await geminiResponse.json().catch(() => ({}));

    if (!geminiResponse.ok) {
      const fallback = buildFallbackInterpretation(request, model, `http_${geminiResponse.status}`);
      return {
        ...fallback,
        schemaVersion: GENERATIVE_INTERPRETATION_SCHEMA_VERSION,
        level: request.level,
        contextType: request.contextType,
        outputType: request.outputType,
        provider: 'gemini',
        enrichedAnalysis: toLegacyAnalysis(fallback),
        cacheHit: false,
        fallbackReason: geminiResponse.status === 429 ? 'quota_exceeded' : 'provider_error',
        status: geminiResponse.status,
        quotaExceeded: geminiResponse.status === 429,
        retryDelayMs: parseRetryDelayMs(geminiPayload),
        providerDetails: truncate(geminiPayload?.error?.message || geminiPayload?.message, 360),
      };
    }

    const parsed = parseGeminiText(geminiPayload);
    const interpretation = parsed
      ? normalizeInterpretation(parsed, model, false)
      : buildFallbackInterpretation(request, model, 'invalid_provider_json');
    const response = {
      ...interpretation,
      schemaVersion: GENERATIVE_INTERPRETATION_SCHEMA_VERSION,
      level: request.level,
      contextType: request.contextType,
      outputType: request.outputType,
      provider: 'gemini',
      enrichedAnalysis: toLegacyAnalysis(interpretation),
      cacheHit: false,
      fallbackReason: interpretation.fallback ? 'invalid_provider_json' : null,
    };

    setCachedResponse(cacheKey, response);
    return response;
  } catch (error) {
    const fallback = buildFallbackInterpretation(
      request,
      model,
      error?.name === 'AbortError' ? 'timeout' : 'request_error'
    );

    return {
      ...fallback,
      schemaVersion: GENERATIVE_INTERPRETATION_SCHEMA_VERSION,
      level: request.level,
      contextType: request.contextType,
      outputType: request.outputType,
      provider: 'gemini',
      enrichedAnalysis: toLegacyAnalysis(fallback),
      cacheHit: false,
      fallbackReason: error?.name === 'AbortError' ? 'timeout' : 'request_error',
      details: truncate(error?.message || String(error), 360),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export { DEFAULT_MODEL };
