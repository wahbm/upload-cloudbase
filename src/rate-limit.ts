interface WindowEntry {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, WindowEntry>();

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const now = this.now();
    const current = this.entries.get(key);
    if (!current || current.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (current.count >= this.maxRequests) return false;
    current.count += 1;
    return true;
  }

  clear(): void {
    this.entries.clear();
  }
}
