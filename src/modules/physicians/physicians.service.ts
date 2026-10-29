import { prisma } from '../../infrastructure/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { SerperDiscovery } from './serper.js';
import { DoctoraliaPublicProvider, BraveDiscovery, DirectoryError, profileUrl,
  type PhysicianProvider, type DiscoveryProvider, type SearchInput, type Candidate, type Profile } from './providers.js';

const normalize = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function score(c: Candidate, q: SearchInput) {
  const text = normalize([c.name, ...c.specialties, c.city].join(' '));
  const words = normalize(q.query).split(/\s+/).filter(Boolean);
  return words.filter(w => text.includes(w)).length * 10 +
    (q.specialty && normalize(c.specialties.join(' ')).includes(normalize(q.specialty)) ? 2 : 0) +
    (q.city && normalize(c.city).includes(normalize(q.city)) ? 1 : 0);
}
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
export function configuredDiscovery(env: NodeJS.ProcessEnv = process.env): DiscoveryProvider | undefined {
  if (env.SERPER_API_KEY?.trim()) return new SerperDiscovery(env.SERPER_API_KEY.trim());
  if (env.BRAVE_SEARCH_API_KEY?.trim()) return new BraveDiscovery(env.BRAVE_SEARCH_API_KEY.trim());
  return undefined;
}
function sufficient(candidates: Candidate[], q: SearchInput) {
  const words = normalize(q.query).split(/\s+/).filter(Boolean);
  return candidates.some(c => {
    const text = normalize([c.name, ...c.specialties].join(' '));
    return words.every(w => text.includes(w)) &&
      (!q.specialty || normalize(c.specialties.join(' ')).includes(normalize(q.specialty))) &&
      (!q.city || normalize(c.city).includes(normalize(q.city)));
  });
}
export class PhysicianDirectory {
  constructor(private provider: PhysicianProvider = new DoctoraliaPublicProvider(),
    private discovery: DiscoveryProvider | null | undefined = configuredDiscovery()) {}

  async search(q: SearchInput) {
    const warnings: string[] = [], methods: string[] = ['directory'];
    // Only public, provider-verified entries are in this directory. Patient text
    // and appointment notes never participate in this search.
    const rows = await prisma.physician.findMany({
      where: { AND: q.query.split(/\s+/).filter(Boolean).map(w => ({ name: { contains: w, mode: 'insensitive' as const } })) },
      include: { sources: true }, take: 50, orderBy: { updatedAt: 'desc' },
    });
    const found = new Map<string, Candidate & { directoryDoctorId?: string }>();
    for (const r of rows) {
      const source = r.sources.find(s => s.provider === 'doctoralia');
      if (!source) continue;
      found.set(source.profileUrl, { directoryDoctorId: r.id, name: r.name,
        photoUrl: r.photoUrl, photoSourceUrl: r.photoSourceUrl,
        specialties: r.specialties as string[], city: (r.offices as Profile['offices']).map(o => o.address).join(' · '),
        provider: source.provider, profileUrl: source.profileUrl });
    }
    const consult = async (provider: DiscoveryProvider) => {
      try {
        const rows = await provider.search(q); methods.push(provider.name);
        for (const c of rows) if (!found.has(c.profileUrl)) found.set(c.profileUrl, c);
      } catch { warnings.push(`${provider.name}_unavailable`); }
    };
    await consult(this.provider);
    // Paid discovery is a fallback, not a request on every keystroke/search.
    if (this.discovery && !sufficient([...found.values()], q)) await consult(this.discovery);
    if (!this.discovery) warnings.push('web_search_not_configured');
    return { result: 'OK', value: [...found.values()].sort((a,b) => score(b,q) - score(a,q)).slice(0,20),
      methods, warnings, requiresConfirmation: true };
  }

  async profile(input: string) {
    const url = profileUrl(input);
    if (!url) throw new DirectoryError(400, 'INVALID_PROFILE_URL');
    const cached = await prisma.physicianSource.findUnique({ where: { provider_profileUrl: { provider: 'doctoralia', profileUrl: url } }, include: { physician: true } });
    if (cached && cached.physician.photoCheckedAt && Date.now() - cached.fetchedAt.getTime() < 24 * 60 * 60 * 1000) {
      return { result: 'OK', value: { directoryDoctorId: cached.physicianId, name: cached.physician.name,
        photoUrl: cached.physician.photoUrl, photoSourceUrl: cached.physician.photoSourceUrl,
        specialties: cached.physician.specialties, offices: cached.physician.offices, provider: cached.provider,
        profileUrl: cached.profileUrl, externalId: cached.externalId, fetchedAt: cached.fetchedAt.toISOString() } };
    }
    const p = await this.provider.profile(url);
    const value = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`physician:${p.provider}:${p.profileUrl}`}, 0))`;
      const existing = await tx.physicianSource.findUnique({ where: { provider_profileUrl: { provider: p.provider, profileUrl: p.profileUrl } } });
      const data = { name: p.name, specialties: json(p.specialties), offices: json(p.offices), fetchedAt: new Date(p.fetchedAt),
        photoUrl: p.photoUrl, photoSourceUrl: p.photoSourceUrl, photoCheckedAt: new Date(p.fetchedAt) };
      const physician = existing ? await tx.physician.update({ where: { id: existing.physicianId }, data }) : await tx.physician.create({ data });
      await tx.physicianSource.upsert({ where: { provider_profileUrl: { provider: p.provider, profileUrl: p.profileUrl } },
        create: { physicianId: physician.id, provider: p.provider, profileUrl: p.profileUrl, externalId: p.externalId, fetchedAt: data.fetchedAt },
        update: { fetchedAt: data.fetchedAt, ...(p.externalId ? { externalId: p.externalId } : {}) } });
      return { ...p, directoryDoctorId: physician.id };
    });
    return { result: 'OK', value };
  }
}
