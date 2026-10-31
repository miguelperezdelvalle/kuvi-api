import { createHash } from 'node:crypto';

type Bucket = { count: number; until: number };
export type AuthCategory = 'login' | 'register' | 'refresh' | 'logout';

// Bounded, per-process limits. request.ip is the socket peer: the server must
// not trust caller-supplied forwarding headers. Use shared storage for scaling.
export class AuthRateLimiter {
  private buckets = new Map<string, Bucket>();
  private nextPrune = 0;
  constructor(private clock = Date.now, private maxEntries = 10000) {}

  private consume(key: string, limit: number, seconds: number) {
    const now = this.clock();
    if (now >= this.nextPrune) {
      for (const [k, b] of this.buckets) if (b.until <= now) this.buckets.delete(k);
      this.nextPrune = now + 1000;
    }
    let b = this.buckets.get(key);
    if (b && b.until <= now) { this.buckets.delete(key); b = undefined; }
    if (!b) {
      if (this.buckets.size >= this.maxEntries) return 60;
      b = { count: 0, until: now + seconds * 1000 };
      this.buckets.set(key, b);
    }
    if (b.count >= limit) return Math.max(1, Math.ceil((b.until - now) / 1000));
    b.count++;
    return 0;
  }

  ip(ip: string, category: AuthCategory) {
    const [limit, seconds] = category === 'login' ? [20, 900] :
      category === 'register' ? [10, 3600] : [60, 60];
    return this.consume(`${category}:ip:${ip}`, limit, seconds);
  }

  account(username: string) {
    const hash = createHash('sha256').update(username.trim().toLowerCase()).digest('hex');
    return this.consume(`login:account:${hash}`, 10, 900);
  }
}
