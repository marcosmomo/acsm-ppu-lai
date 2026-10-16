import { readFile } from 'node:fs/promises';
import mysql from '../cps-lai-01-persistence/node_modules/mysql2/promise.js';
import { CognitiveAnalysis } from './cognitiveAnalysis.js';

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    return match ? [[match[1].trim(), match[2].trim().replace(/^['"]|['"]$/g, '')]] : [];
  }));
}

const asObject = (value) => typeof value === 'string' ? JSON.parse(value) : value;
const iso = (value) => value ? new Date(value).toISOString() : null;
const unique = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined))];

export async function runOfflineExperiment({ envPath = '../cps-lai-01-persistence/.env.cpslai1.reader.local' } = {}) {
  const env = parseEnv(await readFile(new URL(envPath, import.meta.url), 'utf8'));
  const connection = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT), database: env.MYSQL_DATABASE,
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD,
  });
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [oeeRows] = await connection.execute(
      "SELECT calculated_at, calculation_state, availability, performance, quality_value, oee_value, payload_json FROM oee_snapshots WHERE cps_id='cpslai1' ORDER BY calculated_at ASC, oee_id ASC",
    );
    const [stateRows] = await connection.execute(
      "SELECT recorded_at, operational_state, operation_mode, evidence_status, evidence_json, mode_evidence_json FROM operational_state_events WHERE cps_id='cpslai1' ORDER BY recorded_at ASC, state_event_id ASC",
    );
    const [ppuRows] = await connection.execute(
      "SELECT occurred_at, payload_json FROM ppu_events WHERE cps_id='cpslai1' ORDER BY occurred_at ASC, ppu_event_id ASC",
    );
    await connection.commit();

    const events = [
      ...oeeRows.map((row) => { const payload = asObject(row.payload_json); return { kind: 'oee', at: Date.parse(payload.timestamp || payload.ts || row.calculated_at), payload, row }; }),
      ...stateRows.map((row) => ({ kind: 'status', at: new Date(row.recorded_at).getTime(), payload: {
        cpsId: 'cpslai1', timestamp: iso(row.recorded_at), operationalState: row.operational_state,
        operationMode: row.operation_mode, evidenceStatus: row.evidence_status,
        operationalStateEvidence: asObject(row.evidence_json), operationModeEvidence: asObject(row.mode_evidence_json),
      } })),
      ...ppuRows.map((row) => ({ kind: 'ppu', at: new Date(row.occurred_at).getTime(), payload: asObject(row.payload_json) })),
    ].sort((a, b) => a.at - b.at);

    const analysis = new CognitiveAnalysis();
    const outputs = [];
    for (const event of events) {
      if (event.kind === 'ppu') analysis.ingestPpuEvent(event.payload);
      else {
        const output = analysis.ingest(event.kind === 'oee' ? 'cpslai1/oee' : 'cpslai1/status', event.payload);
        if (event.kind === 'oee') outputs.push({ ...output, _record: event.row });
      }
    }
    const final = outputs.at(-1) ?? analysis.analyze();
    const latestComplete = outputs.findLast((output) => output._record?.calculation_state !== 'PARTIAL' && output._record?.availability !== null);
    const generated = outputs.filter((output) => output.prediction.state === 'generated');
    const partialOutputs = outputs.filter((output) => output.learning.state === 'data_unavailable');
    const recommendations = outputs.filter((output) => output.recommendation.state === 'generated' && output.learning.ready);
    const recommendationCategories = recommendations.map((output) => output.recommendation.category);
    const recommendationTransitions = recommendationCategories.filter((category, index) => index === 0 || category !== recommendationCategories[index - 1]);
    const stateDistribution = Object.fromEntries([...new Set(stateRows.map((row) => row.operational_state))].map((state) => [state, stateRows.filter((row) => row.operational_state === state).length]));
    const coverageIntervals = [
      ...final.evidence.partialAvailability.validSegments.map((segment) => ({ start: segment.startedAt, end: segment.endedAt })),
      ...final.evidence.partialAvailability.periods.map((period) => ({ start: period.startedAt, end: period.endedAt || period.lastAt })),
    ].filter((item) => item.start && item.end).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const uncoveredGaps = coverageIntervals.slice(1).flatMap((item, index) => {
      const previous = coverageIntervals[index]; const durationMs = Date.parse(item.start) - Date.parse(previous.end);
      return durationMs > 0 ? [{ from: previous.end, to: item.start, durationMs }] : [];
    });
    const observed = oeeRows;
    const range = (key) => {
      const column = { availability: 'availability', performance: 'performance', quality: 'quality_value', oee: 'oee_value' }[key];
      const values = observed.map((item) => item[column]).filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value))).map(Number);
      return values.length ? { min: Math.min(...values), max: Math.max(...values) } : null;
    };
    return {
      source: { kind: 'mysql_read_only_snapshot', database: env.MYSQL_DATABASE, syntheticDataUsed: false },
      records: {
        oee: oeeRows.length,
        complete: oeeRows.filter((row) => row.calculation_state !== 'PARTIAL' && [row.availability, row.performance, row.quality_value, row.oee_value].every((value) => value !== null && value !== undefined)).length,
        partial: oeeRows.filter((row) => row.calculation_state === 'PARTIAL').length,
        states: stateRows.length, ppu: ppuRows.length, totalReplayed: events.length,
      },
      interval: { from: events.length ? new Date(events[0].at).toISOString() : null, to: events.length ? new Date(events.at(-1).at).toISOString() : null },
      indicators: { availability: range('availability'), performance: range('performance'), quality: range('quality'), oee: range('oee') },
      learning: {
        patterns: unique(outputs.flatMap((output) => output.learning.patterns || [])),
        maximumAnomalyScore: outputs.length ? Math.max(...outputs.map((output) => output.learning.anomalyScore || 0)) : null,
        finalState: final.learning.state,
        latestCompleteSegment: latestComplete ? { state: latestComplete.learning.state, patterns: latestComplete.learning.patterns, metrics: latestComplete.learning.metrics, confidence: latestComplete.learning.confidence } : null,
      },
      reasoning: {
        dominantLosses: unique(outputs.map((output) => output.reasoning.dominantLoss)),
        riskLevels: unique(outputs.map((output) => output.reasoning.riskLevel)),
        final: final.reasoning,
        latestComplete: latestComplete?.reasoning ?? null,
      },
      operationalStates: { distribution: stateDistribution, latest: stateRows.at(-1)?.operational_state ?? null },
      prediction: {
        generatedCount: generated.length,
        blockedCount: outputs.length - generated.length,
        blockedDuringPartialCount: partialOutputs.length,
        confidenceRange: generated.length ? { min: Math.min(...generated.map((output) => output.prediction.confidence)), max: Math.max(...generated.map((output) => output.prediction.confidence)) } : null,
        final: final.prediction,
        latestComplete: latestComplete?.prediction ?? null,
      },
      recommendation: {
        categories: unique(recommendationCategories),
        generatedRecordCount: recommendations.length,
        categoryTransitions: recommendationTransitions,
        partialRecommendationCount: partialOutputs.filter((output) => output.recommendation.state === 'generated' && output.recommendation.requiresGovernance).length,
        insufficientEvidenceViolations: outputs.filter((output) => !output.learning.ready && output.recommendation.requiresGovernance).length,
        final: final.recommendation,
        latestComplete: latestComplete?.recommendation ?? null,
      },
      temporalQuality: {
        finalWindow: final.evidenceWindow,
        validSegmentCount: final.evidence.partialAvailability.validSegmentCount,
        validSegments: final.evidence.partialAvailability.validSegments,
        partialRecordCount: final.evidence.partialAvailability.recordCount,
        partialPeriods: final.evidence.partialAvailability.periods,
        partialUnavailableGaps: final.evidence.partialAvailability.unavailableGaps,
        uncoveredGaps,
        resetEvents: unique(outputs.flatMap((output) => (output.evidence.resetEvents || []).map((event) => `${event.timestamp}|${event.reason}`))),
        outputsWithGaps: outputs.filter((output) => output.evidenceWindow.gapCount > 0).length,
        inconsistentOutputs: outputs.filter((output) => !output.evidenceWindow.consistent).length,
      },
      review: {
        anomalyCandidates: outputs.filter((output) => (output.learning.anomalyScore || 0) >= 0.75).length,
        governedRecommendationCandidateRecords: recommendations.filter((output) => output.recommendation.requiresGovernance).length,
        governedRecommendationCategoryTransitions: recommendations.filter((output, index) => output.recommendation.requiresGovernance && (index === 0 || recommendations[index - 1].recommendation.category !== output.recommendation.category)).length,
      },
    };
  } catch (error) {
    try { await connection.rollback(); } catch { /* read-only connection may already be closed */ }
    throw error;
  } finally {
    await connection.end();
  }
}

if (process.argv[1] && new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).pathname === new URL(import.meta.url).pathname) {
  console.log(JSON.stringify(await runOfflineExperiment(), null, 2));
}
