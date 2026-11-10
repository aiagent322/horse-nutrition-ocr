/**
 * HorseNutritionGuide.com — Cloudflare Worker
 * Proxies vision OCR requests to the Anthropic API.
 * Keeps the API key server-side; rate limiting via Cloudflare Rate Limiter.
 *
 * Deploy:     wrangler deploy
 * Set secret: wrangler secret put ANTHROPIC_API_KEY
 *
 * Bindings (configured in Cloudflare, must not be dropped on deploy):
 *   ANTHROPIC_API_KEY  secret_text
 *   OCR_RATE_LIMITER   ratelimit — 5 requests / 60s, keyed on client IP
 *   TURNSTILE_SECRET_KEY  secret_text — Cloudflare Turnstile (invisible) secret
 */

const ALLOWED_ORIGINS = new Set([
  'https://horsenutritionguide.com',
  'https://www.horsenutritionguide.com',
  'https://horsenutritionguide.pages.dev',
]);

// Cloudflare Pages issues per-deployment preview URLs of the form
// <hash>.horsenutritionguide.pages.dev — allow those too.
function isAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.has(origin)
    || (origin && origin.endsWith('.horsenutritionguide.pages.dev'));
}

// CORS constrains browsers only — a scripted client bypasses it by omitting
// the Origin header. Abuse protection is the rate limiter, not this.
function corsHeaders(origin) {
  if (!isAllowedOrigin(origin)) {
    return { 'Vary': 'Origin' };
  }
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary':                         'Origin',
  };
}

async function checkRateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.OCR_RATE_LIMITER.limit({ key: ip });
  return success;
}

const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Check the decoded leading bytes match the claimed type. Returns false for
// anything that is not a real JPEG / PNG / WebP.
function magicMatches(mediaType, b64) {
  let bytes;
  try {
    bytes = atob(b64.slice(0, 24));
  } catch {
    return false;
  }
  if (mediaType === 'image/jpeg') return bytes.startsWith('\xFF\xD8\xFF');
  if (mediaType === 'image/png')  return bytes.startsWith('\x89PNG\r\n\x1A\n');
  if (mediaType === 'image/webp') return bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP';
  return false;
}

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Verify the single-use Turnstile token. Fails CLOSED: if the secret is
// missing or siteverify is unreachable, the scan is refused.
// Returns null when OK, otherwise a Response to send back.
async function verifyTurnstile(token, request, env, headers) {
  if (!env.TURNSTILE_SECRET_KEY) {
    return jsonError('Verification is not configured. Please try again later.', 503, headers);
  }
  if (typeof token !== 'string' || token.length < 10 || token.length > 2048) {
    return jsonError('Verification failed. Please reload the page and try again.', 403, headers);
  }
  let result;
  try {
    const form = new FormData();
    form.append('secret', env.TURNSTILE_SECRET_KEY);
    form.append('response', token);
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) form.append('remoteip', ip);
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body: form });
    if (!res.ok) throw new Error('siteverify ' + res.status);
    result = await res.json();
  } catch (err) {
    return jsonError('Verification is temporarily unavailable. Please try again in a moment.', 503, headers);
  }
  if (!result.success) {
    return jsonError('Verification failed. Please reload the page and try again.', 403, headers);
  }
  return null;
}

function jsonError(message, status, headers) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const origin  = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/ocr') {
      return new Response('Not found', { status: 404, headers });
    }

    const allowedRequest = await checkRateLimit(request, env);
    if (!allowedRequest) {
      return jsonError('Too many requests. Please wait a bit and try again.', 429, headers);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError('Invalid JSON body', 400, headers);
    }

    if (!body || typeof body.image !== 'string' || typeof body.mediaType !== 'string' || !body.image || !body.mediaType) {
      return jsonError('Missing image or mediaType', 400, headers);
    }

    if (!ALLOWED_MEDIA_TYPES.has(body.mediaType)) {
      return jsonError('Unsupported image type. Please use a JPEG, PNG or WebP photo.', 415, headers);
    }

    // base64 length guard — 5.5M base64 chars ≈ 4MB image
    if (body.image.length > 5_500_000) {
      return jsonError('Image too large. Please use a photo under 4MB.', 413, headers);
    }

    if (!magicMatches(body.mediaType, body.image)) {
      return jsonError('That file is not a valid image of the type declared.', 400, headers);
    }

    const turnstileFailure = await verifyTurnstile(body.turnstileToken, request, env, headers);
    if (turnstileFailure) return turnstileFailure;

    let anthropicRes;
    try {
      anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: 2000,
          messages: [{
            role: 'user',
            content: [
              {
                type:   'image',
                source: {
                  type:       'base64',
                  media_type: body.mediaType,
                  data:       body.image,
                },
              },
              {
                type: 'text',
                text: `This is a photo of a horse feed label. Extract ALL printed text from this label as accurately as possible.

Return ONLY the extracted text, as plain text. Do NOT use markdown: no asterisks, no pound signs, no horizontal rules, no tables, no bullet symbols, no dot leaders. Put each section header (GUARANTEED ANALYSIS, INGREDIENTS, FEEDING DIRECTIONS) on its own line, with its content on the lines below.

For GUARANTEED ANALYSIS: one row per line: the nutrient name, then min or max if shown, then the value and unit exactly as printed (%, ppm, IU/lb, mg/lb, etc.). Keep leading decimals as printed (for example .25%, not 0.25% or 25%).
For INGREDIENTS: write "INGREDIENTS:" on its own line, then the list in the exact order shown, comma-separated.
For FEEDING DIRECTIONS: extract the full text.

Transcribe numbers, dates and lot codes exactly as printed. If a character is hard to read, write [?] in its place instead of guessing; never infer or correct a digit or a year. If part of the label is covered by a redaction bar or cannot be read, write [unreadable] at that spot.

Do not add commentary or any text not on the label. If the image is too blurry or the label is not visible, respond with exactly: UNREADABLE`,
              },
            ],
          }],
        }),
      });
    } catch (err) {
      return jsonError('Failed to reach Anthropic API: ' + err.message, 502, headers);
    }

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      const msg = data?.error?.message || 'Anthropic API error ' + anthropicRes.status;
      return jsonError(msg, anthropicRes.status, headers);
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  },
};
