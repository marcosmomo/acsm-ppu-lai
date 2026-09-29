import { NextResponse } from 'next/server';
import {
  DEFAULT_MODEL,
  describeKnowledgePackage,
} from '../../../../services/ai/generativeInterpretationService';

const verifyOptionalIngestToken = (request) => {
  const expected = process.env.AI_INGEST_TOKEN;
  if (!expected) return true;

  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const explicit = request.headers.get('x-ai-ingest-token');
  return bearer === expected || explicit === expected;
};

export async function POST(request) {
  if (!verifyOptionalIngestToken(request)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Unauthorized AI ingestion request.',
      },
      { status: 401 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: 'Request body must be valid JSON.',
      },
      { status: 400 }
    );
  }

  const responsePayload = await describeKnowledgePackage(body);

  return NextResponse.json(
    {
      ok: true,
      ...responsePayload,
      analysisMode: responsePayload.fallback ? 'light' : 'full',
      analysisSource: responsePayload.fallback ? 'fallback' : 'live',
      timestamp: responsePayload.generatedAt,
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );
}

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      endpoint: '/api/ai/describe-level',
      method: 'POST',
      provider: 'gemini',
      requiredEnv: ['GEMINI_API_KEY'],
      optionalEnv: ['GEMINI_MODEL', 'AI_INGEST_TOKEN'],
      requestShape: {
        level: 'level1 | level2 | level3 | level4',
        contextType: 'operational | system | executive | strategic',
        knowledgePackage: {},
        language: 'en',
        outputType:
          'summary | diagnosis | prediction | recommendation | decision_justification | knowledge_evolution',
      },
      responseShape: {
        summary: '',
        diagnosis: '',
        prediction: '',
        recommendation: '',
        decisionJustification: '',
        riskInterpretation: '',
        confidenceInterpretation: '',
        generatedAt: new Date(0).toISOString(),
        model: DEFAULT_MODEL,
        fallback: false,
      },
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );
}
