const MOJIBAKE_PATTERN =
  /Ã.|Â.|â€|â€™|â€œ|â€|â€“|â€”|â€¢|ðŸ|�|Î”|Æ’|¢â|€š|€™/;

const ASCII_FALLBACKS = [
  [/[\u2010-\u2015]/g, '-'],
  [/[\u2212]/g, '-'],
  [/[\u2022\u00B7\u2219]/g, '-'],
  [/[\u2018\u2019\u2032]/g, "'"],
  [/[\u201C\u201D\u2033]/g, '"'],
  [/[\u00A0]/g, ' '],
  [/[\u200B-\u200D\uFEFF]/g, ''],
  [/Î”/g, 'Delta'],
];

function coerceString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return String(value);
  } catch {
    return fallback;
  }
}

function hasMojibake(value) {
  return MOJIBAKE_PATTERN.test(coerceString(value));
}

function repairUtf8Mojibake(value) {
  const input = coerceString(value);
  if (!input) return input;

  try {
    const bytes = Uint8Array.from(input, (char) => char.charCodeAt(0) & 0xff);
    const repaired = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return repaired || input;
  } catch {
    return input;
  }
}

function normalizeAscii(value) {
  let output = coerceString(value);

  ASCII_FALLBACKS.forEach(([pattern, replacement]) => {
    output = output.replace(pattern, replacement);
  });

  output = output
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E\n\r\t]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return output;
}

export function sanitizeTextEncoding(value, options = {}) {
  const { fallback = '', ascii = true } = options;
  const original = coerceString(value, fallback);

  if (!original) return fallback;

  const repaired = hasMojibake(original) ? repairUtf8Mojibake(original) : original;
  const normalized = ascii ? normalizeAscii(repaired) : repaired;

  if (normalized) return normalized;
  return original || fallback;
}

export function sanitizeTextList(values, options = {}) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => sanitizeTextEncoding(item, options))
    .filter((item) => item !== '' && item !== null && item !== undefined);
}

export function sanitizeTextDeep(value, options = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTextDeep(item, options));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeTextDeep(item, options)])
    );
  }

  if (typeof value === 'string') {
    return sanitizeTextEncoding(value, options);
  }

  return value;
}

export function textOrDash(value) {
  return sanitizeTextEncoding(value, { fallback: '-' }) || '-';
}

export function textOrEmpty(value) {
  return sanitizeTextEncoding(value, { fallback: '' });
}

export function textOrNull(value) {
  if (value === undefined || value === null) return null;
  const sanitized = sanitizeTextEncoding(value, { fallback: '' });
  return sanitized || null;
}

export function hasEncodingArtifacts(value) {
  return hasMojibake(value);
}
