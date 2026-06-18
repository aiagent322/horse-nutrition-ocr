/**
 * HorseNutritionGuide.com — Cloudflare Worker
 * Proxies vision OCR requests to Anthropic API
 * Keeps the API key server-side and adds image resizing
 *
 * Deploy: wrangler deploy
 * Set secret: wrangler secret put ANTHROPIC_API_KEY
 */

export default {
  async fetch(request, env) {

    // ── CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    // ── Only accept POST to /ocr
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/ocr') {
      return new Response('Not found', { status: 404 });
    }

    // ── Parse incoming body: { image: base64string, mediaType: 'image/jpeg' }
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError('Invalid JSON body', 400);
    }

    if (!body.image || !body.mediaType) {
      return jsonError('Missing image or mediaType', 400);
    }

    // ── Basic size guard (base64 string — 4MB base64 ≈ 3MB image)
    if (body.image.length > 5_500_000) {
      return jsonError('Image too large. Please use a photo under 4MB.', 413);
    }

    // ── Forward to Anthropic
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
                  data:       body.image
                }
              },
              {
                type: 'text',
                text: `This is a photo of a horse feed label. Extract ALL text from this label as accurately as possible.

Return ONLY the extracted text, structured exactly as it appears on the label. Preserve section headers (GUARANTEED ANALYSIS, INGREDIENTS, FEEDING DIRECTIONS) and their formatting.

For GUARANTEED ANALYSIS: extract every row with its value and unit (%, ppm, IU/lb, mg/lb, etc.).
For INGREDIENTS: list them in the exact order shown, comma-separated.
For FEEDING DIRECTIONS: extract the full text.

Do not add commentary or any text not on the label. If the image is too blurry or the label is not visible, respond with exactly: UNREADABLE`
              }
            ]
          }]
        })
      });
    } catch (err) {
      return jsonError('Failed to reach Anthropic API: ' + err.message, 502);
    }

    // ── Pass Anthropic response back to client
    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      const msg = data?.error?.message || 'Anthropic API error ' + anthropicRes.status;
      return jsonError(msg, anthropicRes.status);
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type':                 'application/json',
        'Access-Control-Allow-Origin':  '*',
      }
    });
  }
};

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    }
  });
}
