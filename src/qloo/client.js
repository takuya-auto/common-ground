// Qloo API client. Live when an API key is configured, otherwise the mock.
// Every call is appended to a trace so the UI can show exactly what the
// agent asked Qloo and what came back (counts and ids only, never the full
// payload, to keep responses small).

import { mockRequest } from './mock.js';
import { buildInsightsParams, buildSearchParams, buildTagSearchParams, toQueryString } from './params.js';

export class QlooError extends Error {
  constructor(message, { status, body, path } = {}) {
    super(message);
    this.name = 'QlooError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.apiKey]  when missing, the client runs in mock mode
 * @param {string} [opts.baseUrl]
 * @param {Function} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 */
export function createQlooClient({ apiKey, baseUrl = 'https://hackathon.api.qloo.com', fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  const mode = apiKey ? 'live' : 'mock';
  const trace = [];
  let seq = 0;

  async function request(path, params, { purpose } = {}) {
    const started = Date.now();
    const entry = { id: ++seq, path, params, purpose, mode };
    trace.push(entry);
    try {
      let data;
      if (mode === 'mock') {
        data = mockRequest(path, params);
        if (!data.success) throw new QlooError(data.error?.message || 'mock error', { status: data.error?.code || 400, body: data, path });
      } else {
        const url = `${baseUrl}${path}?${toQueryString(params)}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        let res;
        try {
          res = await fetchImpl(url, { headers: { 'X-Api-Key': apiKey, accept: 'application/json' }, signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
        if (!res.ok) {
          throw new QlooError(`Qloo ${path} returned ${res.status}`, { status: res.status, body, path });
        }
        data = body;
      }
      entry.ms = Date.now() - started;
      entry.ok = true;
      entry.summary = summarize(path, data);
      return data;
    } catch (err) {
      entry.ms = Date.now() - started;
      entry.ok = false;
      entry.error = err.message;
      entry.status = err.status;
      throw err;
    }
  }

  return {
    mode,
    trace,

    /** GET /search */
    async search(query, opts = {}) {
      const params = buildSearchParams(query, opts);
      const data = await request('/search', params, { purpose: opts.purpose || `resolve "${query}"` });
      return normalizeEntities(data.results || []);
    },

    /** GET /v2/tags */
    async searchTags(query, opts = {}) {
      const params = buildTagSearchParams(query, opts);
      const data = await request('/v2/tags', params, { purpose: opts.purpose || `find tag for "${query}"` });
      const list = Array.isArray(data.results) ? data.results : (data.results?.tags || []);
      return list.map((t) => ({ id: t.id || t.tag_id, name: t.name, type: t.type, parents: t.parents || [] }));
    },

    /** GET /v2/insights (params validated against the entity-type guide) */
    async insights(type, opts = {}) {
      const params = buildInsightsParams(type, opts);
      const data = await request('/v2/insights', params, { purpose: opts.purpose || `insights ${type}` });
      const entities = normalizeEntities(data.results?.entities || []);
      return { entities, locality: data.query?.locality?.signal || null, explainability: data.query?.explainability || null };
    },
  };
}

function summarize(path, data) {
  if (path === '/search') {
    const r = data.results || [];
    return { count: r.length, top: r.slice(0, 3).map((e) => ({ name: e.name, id: e.entity_id, type: (e.types && e.types[0]) || e.type })) };
  }
  if (path === '/v2/tags') {
    const r = Array.isArray(data.results) ? data.results : (data.results?.tags || []);
    return { count: r.length, top: r.slice(0, 3).map((t) => ({ id: t.id || t.tag_id, name: t.name })) };
  }
  if (path === '/v2/insights') {
    const r = data.results?.entities || [];
    return {
      count: r.length,
      locality: data.query?.locality?.signal?.name || null,
      top: r.slice(0, 3).map((e) => ({ name: e.name, id: e.entity_id, affinity: e.query?.affinity })),
    };
  }
  return {};
}

/** Normalize Qloo entity objects (search and insights have slightly different shapes). */
export function normalizeEntities(list) {
  return list.map((e) => {
    const type = e.type || (Array.isArray(e.types) ? e.types[0] : undefined);
    const tags = (e.tags || []).map((t) => (typeof t === 'string' ? { id: t, name: t.split(':').pop() } : { id: t.id || t.tag_id, name: t.name || '', type: t.type }));
    return {
      id: e.entity_id || e.id,
      name: e.name,
      type,
      subtype: e.subtype,
      popularity: e.popularity,
      disambiguation: e.disambiguation,
      properties: e.properties || {},
      tags,
      affinity: e.query?.affinity,
      explainability: e.query?.explainability || null,
    };
  });
}
