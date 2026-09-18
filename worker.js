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

    if (!body.image || !body.mediaType) {
      return jsonError('Missing image or mediaType', 400, headers);
    }

    // base64 length guard — 5.5M base64 chars ≈ 4MB image
    if (body.image.length > 5_500_000) {
      return jsonError('Image too large. Please use a photo under 4MB.', 413, headers);
    }

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
                text: `This is a photo of a horse feed label. Extract ALL text from this label as accurately as possible.

Return ONLY the extracted text, structured exactly as it appears on the label. Preserve section headers (GUARANTEED ANALYSIS, INGREDIENTS, FEEDING DIRECTIONS) and their formatting.

For GUARANTEED ANALYSIS: extract every row with its value and unit (%, ppm, IU/lb, mg/lb, etc.).
For INGREDIENTS: list them in the exact order shown, comma-separated.
For FEEDING DIRECTIONS: extract the full text.

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
