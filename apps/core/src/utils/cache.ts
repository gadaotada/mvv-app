interface CacheEntry<T> {
  value: T;
  expiration: number;
}
// we focus not to use the old js api for dates
// gonna use the new one

export class Cache<T> {
    private cache: Map<string, CacheEntry<T>> = new Map();

    set(key: string, value: T, ttl?: number): void {
        if (ttl === undefined) {
            this.cache.set(key, { value, expiration: Infinity });
            return;
        }
        const expiration = Temporal.Now.instant()
            .add({ minutes: ttl })
            .epochMilliseconds;
        
        this.cache.set(key, { value, expiration });
    }

    get(key: string): T | null {
        const entry = this.cache.get(key);
        if (!entry) return null;

        if (this.isExpired(entry)) {
            this.cache.delete(key);
            return null;
        }

        return entry.value;
    }

    remove(key: string): void {
        this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }

    private cycle(): void {
        // this needs to fire every setup interval to clean up expired entries;
    }

    private isExpired(entry: CacheEntry<T>): boolean {
        return Temporal.Now.instant().epochMilliseconds >= entry.expiration;
    }
}