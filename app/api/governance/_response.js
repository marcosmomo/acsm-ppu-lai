import { NextResponse } from 'next/server';

export const governanceCorsHeaders = {
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export const jsonOk = (payload = {}, status = 200) =>
  NextResponse.json(
    {
      ok: true,
      ...payload,
    },
    {
      status,
      headers: governanceCorsHeaders,
    }
  );

export const jsonError = (error) =>
  NextResponse.json(
    {
      ok: false,
      error: error.message || 'Unexpected governance API error.',
      details: error.details,
    },
    {
      status: error.status || 500,
      headers: governanceCorsHeaders,
    }
  );

export const readJsonBody = async (request) => {
  try {
    return await request.json();
  } catch {
    return {};
  }
};
