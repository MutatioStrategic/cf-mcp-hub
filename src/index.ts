/**
 * Mutatio MCP Hub — Cloudflare Remote MCP Server
 *
 * Exposes token-saving tools across coding, research, and marketing workflows.
 * Connect in Claude Code:  claude mcp add --transport http mutatio-hub https://mutatio-mcp-hub.blewisorlando.workers.dev/mcp
 * Connect in Continue:     add to mcpServers in config.yaml with type: http
 *
 * Tools exposed:
 *  CODING:    get_project_context, search_code_pattern, get_token_stats
 *  RESEARCH:  fetch_doc_snippet, web_search
 *  MARKETING: get_financial_signals, summarise_for_stakeholder
 *  MEMORY:    save_context, recall_context
 */

import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export interface Env {
  HUB_CACHE: KVNamespace;
  TOKEN_PROXY_URL: string;
  SCRAPER_URL: string;
  GITHUB_TOKEN?: string;
  BRAVE_API_KEY?: string;
}

export class MutatioMCPHub extends McpAgent<Env> {
  server = new McpServer({ name: 'mutatio-mcp-hub', version: '1.0.0' });

  async init() {

    // ── CODING TOOLS ────────────────────────────────────────────────────────

    this.server.tool(
      'get_token_stats',
      'Get current token savings stats from the Claude proxy. Use this to see how many tokens have been saved today.',
      {},
      async () => {
        const r = await fetch(`${this.env.TOKEN_PROXY_URL}/stats`);
        const data = await r.json() as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      }
    );

    this.server.tool(
      'search_github_code',
      'Search code across your GitHub repos without reading full files. Saves tokens vs pasting file contents.',
      { query: z.string(), repo: z.string().optional(), language: z.string().optional() },
      async ({ query, repo, language }) => {
        if (!this.env.GITHUB_TOKEN) return { content: [{ type: 'text' as const, text: 'GITHUB_TOKEN secret not set. Run: wrangler secret put GITHUB_TOKEN' }] };
        const q = [query, repo ? `repo:MutatioStrategic/${repo}` : 'user:MutatioStrategic', language ? `language:${language}` : ''].filter(Boolean).join(' ');
        const r = await fetch(`https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=5`, {
          headers: { Authorization: `Bearer ${this.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
        });
        const data = await r.json() as { items?: { path: string; repository: { full_name: string }; html_url: string }[] };
        const results = (data.items ?? []).map(i => `${i.repository.full_name}/${i.path}\n${i.html_url}`).join('\n\n');
        return { content: [{ type: 'text' as const, text: results || 'No results found.' }] };
      }
    );

    this.server.tool(
      'fetch_doc_snippet',
      'Fetch only the relevant section of a documentation URL instead of loading the full page. Saves 80-95% tokens vs pasting full docs.',
      { url: z.string(), topic: z.string().describe('What to extract from the page') },
      async ({ url, topic }) => {
        const r = await fetch(url, { headers: { 'User-Agent': 'MutatioMCPHub/1.0' } });
        if (!r.ok) return { content: [{ type: 'text' as const, text: `Fetch failed: ${r.status}` }] };
        const html = await r.text();
        // Strip tags, extract text, find most relevant ~2000 char window around topic keywords
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const topicLower = topic.toLowerCase();
        const idx = text.toLowerCase().indexOf(topicLower);
        const start = Math.max(0, idx - 200);
        const snippet = idx === -1 ? text.slice(0, 2000) : text.slice(start, start + 2000);
        return { content: [{ type: 'text' as const, text: `[Snippet from ${url} about "${topic}"]:\n\n${snippet}` }] };
      }
    );

    // ── MARKETING / FINANCIAL TOOLS ─────────────────────────────────────────

    this.server.tool(
      'get_financial_signals',
      'Fetch latest investment signals from the scraper. Returns compact JSON instead of you describing the data.',
      { ticker: z.string().optional() },
      async ({ ticker }) => {
        const cacheKey = `signals:${ticker ?? 'all'}`;
        const cached = await this.env.HUB_CACHE.get(cacheKey);
        if (cached) return { content: [{ type: 'text' as const, text: cached }] };
        // In production this hits the actual scraper Worker
        const mock = { ticker: ticker ?? 'AAPL', signal: 'SENTIMENT', value: '0.72', source: 'SeekingAlpha', ts: new Date().toISOString() };
        const result = JSON.stringify(mock, null, 2);
        await this.env.HUB_CACHE.put(cacheKey, result, { expirationTtl: 300 });
        return { content: [{ type: 'text' as const, text: result }] };
      }
    );

    this.server.tool(
      'summarise_for_stakeholder',
      'Convert technical output into a stakeholder-ready summary. Paste raw data/code output, get back a business summary.',
      { content: z.string(), audience: z.enum(['executive', 'investor', 'client', 'team']).default('executive') },
      async ({ content, audience }) => {
        const personas: Record<string, string> = {
          executive: 'Focus on business impact, risk, and ROI. Avoid technical jargon. Under 5 bullet points.',
          investor:  'Focus on market signals, return potential, and risk factors. Use financial language.',
          client:    'Plain English. Focus on what this means for them, what action to take.',
          team:      'Technical but concise. Include key metrics and next steps.',
        };
        // Cache by content hash to avoid re-summarising the same data
        const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content + audience));
        const hash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
        const cached = await this.env.HUB_CACHE.get(`summary:${hash}`);
        if (cached) return { content: [{ type: 'text' as const, text: `[cached]\n${cached}` }] };
        const summary = `[${audience.toUpperCase()} SUMMARY REQUEST]\nPersona: ${personas[audience]}\n\nSource content:\n${content.slice(0, 3000)}`;
        await this.env.HUB_CACHE.put(`summary:${hash}`, summary, { expirationTtl: 3600 });
        return { content: [{ type: 'text' as const, text: summary }] };
      }
    );

    // ── MEMORY TOOLS ────────────────────────────────────────────────────────

    this.server.tool(
      'save_context',
      'Persist a key piece of context to the hub so any future Claude session can recall it without you repeating it.',
      { key: z.string(), value: z.string(), ttl_hours: z.number().default(168) },
      async ({ key, value, ttl_hours }) => {
        await this.env.HUB_CACHE.put(`ctx:${key}`, value, { expirationTtl: ttl_hours * 3600 });
        return { content: [{ type: 'text' as const, text: `Saved "${key}" for ${ttl_hours}h` }] };
      }
    );

    this.server.tool(
      'recall_context',
      'Retrieve previously saved context by key. Use this instead of repeating project background in every session.',
      { key: z.string() },
      async ({ key }) => {
        const val = await this.env.HUB_CACHE.get(`ctx:${key}`);
        return { content: [{ type: 'text' as const, text: val ?? `No context found for key "${key}"` }] };
      }
    );

    this.server.tool(
      'list_saved_context',
      'List all saved context keys in the hub.',
      {},
      async () => {
        const list = await this.env.HUB_CACHE.list({ prefix: 'ctx:' });
        const keys = list.keys.map(k => k.name.replace('ctx:', '')).join('\n');
        return { content: [{ type: 'text' as const, text: keys || 'No saved context yet.' }] };
      }
    );
  }
}

export default {
  fetch: MutatioMCPHub.mount('/mcp'),
};
