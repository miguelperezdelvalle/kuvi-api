import { load } from 'cheerio';
import { DirectoryError, profileUrl, type Candidate, type DiscoveryProvider, type SearchInput } from './providers.js';

export class SerperDiscovery implements DiscoveryProvider {
  readonly name = 'serper';
  constructor(private key: string, private fetcher: typeof fetch = fetch) {}
  async search(input: SearchInput): Promise<Candidate[]> {
    try {
      const terms = [input.query, input.specialty, input.city].join(' ').replace(/["\r\n]/g, ' ');
      const response = await this.fetcher('https://google.serper.dev/search', {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': this.key, Accept: 'application/json' },
        body: JSON.stringify({ q: `site:doctoralia.com.mx ${terms}`, gl: 'mx', hl: 'es', num: 10 }),
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
        await response.body?.cancel();
        throw new DirectoryError(502, response.status === 429 ? 'SERPER_LIMIT_REACHED' : 'SERPER_UNAVAILABLE');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new DirectoryError(502, 'SERPER_UNREADABLE_RESPONSE');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length;
          if (size > 1024 * 1024) throw new DirectoryError(502, 'SERPER_RESPONSE_TOO_LARGE');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || !Array.isArray(data.organic)) throw new DirectoryError(502, 'SERPER_UNREADABLE_RESPONSE');
      const found = new Map<string, Candidate>();
      for (const row of data.organic) {
        if (!row || typeof row.link !== 'string' || typeof row.title !== 'string') continue;
        const url = profileUrl(row.link);
        const name = load(row.title).text().replace(/\s+/g, ' ').trim().slice(0, 200);
        // Search suggestions must be canonical doctor profiles, not three-part directory listings.
        // Legacy profile URLs remain supported by explicit profile import.
        if (!url || !new URL(url).pathname.startsWith('/perfil/') || !name) continue;
        found.set(url, { name, profileUrl: url, provider: 'doctoralia', specialties: [], city: '' });
        if (found.size >= 10) break;
      }
      return [...found.values()];
    } catch (e) {
      if (e instanceof DirectoryError) throw e;
      throw new DirectoryError(502, 'SERPER_UNAVAILABLE');
    }
  }
}
