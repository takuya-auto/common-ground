// Cloudflare Worker entry: serves the static UI (ASSETS binding) and /api/*.

import { createQlooClient } from './qloo/client.js';
import { createLLM } from './llm/workersai.js';
import { runAgent, validateRequest, OCCASION_KEYS } from './agent/agent.js';
import { OCCASIONS } from './agent/occasions.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
        return json({ error: err.message || 'Internal error', status }, status);
      }
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};

async function handleApi(request, env, url) {
  const path = url.pathname;

  if (path === '/api/health' && request.method === 'GET') {
    const llm = createLLM(env);
    const status = await llm.status();
    return json({
      ok: true,
      qloo: { mode: env.QLOO_API_KEY ? 'live' : 'mock', baseUrl: env.QLOO_BASE_URL || 'https://hackathon.api.qloo.com' },
      llm: status,
      occasions: OCCASION_KEYS.map((k) => ({ key: k, label: OCCASIONS[k].label, needsLocation: OCCASIONS[k].needsLocation, type: OCCASIONS[k].type })),
    });
  }

  if (path === '/api/plan' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
    const req = validateRequest(body);
    const qloo = createQlooClient({ apiKey: env.QLOO_API_KEY || undefined, baseUrl: env.QLOO_BASE_URL || undefined });
    const llm = createLLM(env);
    const started = Date.now();
    const result = await runAgent(req, { qloo, llm });
    result.ms = Date.now() - started;
    return json(result);
  }

  if (path === '/api/plan' || path === '/api/health') {
    return json({ error: 'Method not allowed' }, 405, { allow: path === '/api/plan' ? 'POST' : 'GET' });
  }
  return json({ error: 'Not found' }, 404);
}
