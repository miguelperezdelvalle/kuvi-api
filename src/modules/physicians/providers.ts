import { load } from 'cheerio';

export class DirectoryError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export type SearchInput = { query: string; city: string; specialty: string };
export type Candidate = { name: string; specialties: string[]; city: string; profileUrl: string; provider: string; photoUrl?: string | null; photoSourceUrl?: string | null };
export type Profile = Candidate & { photoUrl: string | null; photoSourceUrl: string | null; offices: { name: string; address: string }[]; fetchedAt: string; externalId: string | null };
export interface PhysicianProvider {
  readonly name: string;
  search(input: SearchInput): Promise<Candidate[]>;
  profile(url: string): Promise<Profile>;
}
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
// Restrict the temporary HTML adapter to the observed Doctoralia portrait CDN,
// excluding gallery images, generic site logos and arbitrary remote addresses.
export function doctorPhotoUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const u = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (u.protocol !== 'https:' || u.port || u.username || u.password ||
        u.hostname !== 's3.us-east-1.amazonaws.com' ||
        !/^\/doctoralia\.com\.mx\/doctor\/[a-zA-Z0-9/_-]+\.(jpg|jpeg|png|webp)$/i.test(u.pathname)) return null;
    u.hash = ''; return u.href;
  } catch { return null; }
}
export function profileUrl(input: string): string | null {
  try {
    const u = new URL(input);
    const p = u.pathname.split('/').filter(Boolean);
    if (u.protocol !== 'https:' || u.port || u.username || u.password ||
        !['www.doctoralia.com.mx', 'doctoralia.com.mx'].includes(u.hostname) ||
        !(p.length === 2 && p[0] === 'perfil' || p.length === 3) ||
        p.some(v => !/^[a-z0-9-]+$/.test(v)) ||
        ['buscar','clinicas','preguntas-respuestas','usuarios','tratamientos-servicios'].includes(p[0]!)) return null;
    return `https://www.doctoralia.com.mx/${p.join('/')}`;
  } catch { return null; }
}

// Every redirect is validated before fetching; no caller-supplied hosts or credentials.
export async function fetchPublic(url: string, fetcher: typeof fetch = fetch, apiKey?: string): Promise<string> {
  const signal = AbortSignal.timeout(15000);
  try {
    for (let hop = 0; hop < 4; hop++) {
      const u = new URL(url);
      const brave = apiKey !== undefined;
      if (u.protocol !== 'https:' || u.port || u.username || u.password ||
          (brave ? u.host !== 'api.search.brave.com' || u.pathname !== '/res/v1/web/search'
            : u.host !== 'www.doctoralia.com.mx' || !(u.pathname === '/buscar' || profileUrl(url))))
        throw new DirectoryError(400, 'INVALID_PROVIDER_URL');
      const response = await fetcher(url, { redirect: 'manual', signal,
        headers: brave ? { Accept: 'application/json', 'X-Subscription-Token': apiKey! } : { Accept: 'text/html' } });
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        const next = location && !brave ? profileUrl(new URL(location, url).href) : null;
        if (!next) throw new DirectoryError(502, 'UNSAFE_PROVIDER_REDIRECT');
        url = next; continue;
      }
      if (!response.ok || !response.headers.get('content-type')?.includes(brave ? 'application/json' : 'text/html')) {
        await response.body?.cancel();
        throw new DirectoryError(502, 'PROVIDER_UNAVAILABLE');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new DirectoryError(502, 'EMPTY_PROVIDER_RESPONSE');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length;
          if (size > 3 * 1024 * 1024) throw new DirectoryError(502, 'PROVIDER_RESPONSE_TOO_LARGE');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      return Buffer.concat(chunks).toString('utf8');
    }
    throw new DirectoryError(502, 'TOO_MANY_REDIRECTS');
  } catch (e) {
    if (e instanceof DirectoryError) throw e;
    throw new DirectoryError(502, 'PROVIDER_UNAVAILABLE');
  }
}

export function parseSearch(source: string): Candidate[] {
  const $ = load(source);
  if (!$('[data-test-id="search-list"]').length) {
    // An actual empty result is not a parser/network failure.
    if ($('[data-test-id="search-listing-container"]').length &&
        $('h1').text().includes('No hemos encontrado')) return [];
    throw new DirectoryError(502, 'UNREADABLE_PROVIDER_SEARCH');
  }
  const results = new Map<string, Candidate>();
  $('[data-test-id="result-item"][data-test-entity-type="doctor"]').each((_, el) => {
    const card = $(el), url = profileUrl(card.attr('data-doctor-url') ?? '');
    const name = clean(card.attr('data-doctor-name') ?? '');
    if (!url || !name || name.length > 200) return;
    const specialty = clean(card.find('[data-test-id="doctor-specializations"]').text()).slice(0, 200);
    results.set(url, { name, profileUrl: url, provider: 'doctoralia',
      specialties: specialty ? [specialty] : [], city: clean(card.attr('data-eec-address-cities') ?? '').slice(0, 200) });
  });
  return [...results.values()].slice(0, 20);
}
export function parseProfile(source: string, requested: string): Profile {
  const $ = load(source), canonical = profileUrl($('link[rel="canonical"]').attr('href') ?? requested);
  const physicians: Record<string, unknown>[] = [];
  function collect(n: unknown) {
    if (Array.isArray(n)) { n.forEach(collect); return; }
    if (n && typeof n === 'object') {
      const obj = n as Record<string, unknown>;
      if (obj['@type'] === 'Physician') physicians.push(obj);
      if (obj['@graph']) collect(obj['@graph']);
    }
  }
  $('script[type="application/ld+json"]').each((_, el) => { try { collect(JSON.parse($(el).text())); } catch { /* Ignore malformed unrelated JSON. */ } });
  const matches = physicians.filter(p => profileUrl(String(p.url ?? '')) === canonical);
  if (!canonical || matches.length !== 1 || requested.includes('/perfil/') && canonical !== profileUrl(requested))
    throw new DirectoryError(502, 'UNVERIFIED_PROFILE');
  const name = clean(String(matches[0]!.name ?? ''));
  if (!name || name.length > 200) throw new DirectoryError(502, 'UNVERIFIED_PROFILE');
  const image = matches[0]!.image;
  const imageValues = (Array.isArray(image) ? image : [image]).flatMap(v =>
    v && typeof v === 'object' ? [(v as Record<string, unknown>).contentUrl, (v as Record<string, unknown>).url] : [v]);
  const photoUrl = [...imageValues, $('meta[property="og:image"]').attr('content')]
    .map(doctorPhotoUrl).find(Boolean) ?? null;
  const specialties = [...new Set($('[data-test-id="doctor-specializations"] a[title]').toArray()
    .map(e => clean($(e).text())).filter(v => v && v.length <= 200))].slice(0, 20);
  const offices: Profile['offices'] = [];
  $('[data-id="doctor-address-item"]').each((_, el) => {
    const card = $(el), street = card.find('[data-test-id="address-info-street"]');
    if (!street.length) return;
    const address = clean(card.find('.profile-address-card__location').text() || street.text());
    const officeName = clean(card.find('[data-test-id="address-info-name"]').text());
    if (address && address.length <= 1000 && officeName.length <= 200 &&
        !offices.some(o => o.address === address && o.name === officeName)) offices.push({ name: officeName, address });
  });
  return { name, profileUrl: canonical, provider: 'doctoralia', specialties, city: '',
    photoUrl, photoSourceUrl: photoUrl ? canonical : null,
    offices: offices.slice(0, 30), fetchedAt: new Date().toISOString(), externalId: null };
}
export class DoctoraliaPublicProvider implements PhysicianProvider {
  readonly name = 'doctoralia_public';
  constructor(private fetcher: typeof fetch = fetch) {}
  async search(input: SearchInput) {
    const url = new URL('https://www.doctoralia.com.mx/buscar');
    url.searchParams.set('q', input.query); if (input.city) url.searchParams.set('loc', input.city);
    return parseSearch(await fetchPublic(url.href, this.fetcher));
  }
  async profile(input: string) {
    const url = profileUrl(input);
    if (!url) throw new DirectoryError(400, 'INVALID_PROFILE_URL');
    return parseProfile(await fetchPublic(url, this.fetcher), url);
  }
}
export interface DiscoveryProvider { readonly name: string; search(input: SearchInput): Promise<Candidate[]> }
export class BraveDiscovery implements DiscoveryProvider {
  readonly name = 'web_search';
  constructor(private key: string, private fetcher: typeof fetch = fetch) {}
  async search(input: SearchInput): Promise<Candidate[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    const terms = [input.query, input.specialty, input.city].join(' ').replace(/["\r\n]/g, ' ');
    url.searchParams.set('q', `site:doctoralia.com.mx ${terms}`);
    url.searchParams.set('count', '10'); url.searchParams.set('country', 'MX'); url.searchParams.set('search_lang', 'es');
    const body = JSON.parse(await fetchPublic(url.href, this.fetcher, this.key));
    if (!Array.isArray(body.web?.results)) return [];
    return body.web.results.flatMap((r: { url?: string; title?: string }) => {
      const link = profileUrl(r.url ?? '');
      return link && typeof r.title === 'string' ? [{ name: clean(load(r.title).text()).slice(0, 200),
        profileUrl: link, provider: 'doctoralia', specialties: [], city: '' }] : [];
    });
  }
}
