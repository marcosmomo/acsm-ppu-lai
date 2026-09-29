import { NextResponse } from 'next/server';

export const hcmCorsHeaders = {
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
      headers: hcmCorsHeaders,
    }
  );

export const jsonError = (error) =>
  NextResponse.json(
    {
      ok: false,
      error: error.message || 'Unexpected HCM API error.',
      details: error.details,
    },
    {
      status: error.status || 500,
      headers: hcmCorsHeaders,
    }
  );

export const readJsonBody = async (request) => {
  try {
    return await request.json();
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.status = 400;
    throw error;
  }
};
