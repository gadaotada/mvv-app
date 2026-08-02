import { assertIntegerInRange } from "./global.js";

const MAX_CACHE_SIZE = 999_999_999; // prevents shit stuff from happening :D ;

export class Cache<T = unknown> {
    private readonly __items = new Map<string,T>();
    private readonly __maxCap: number;

    constructor(maxCapacity = MAX_CACHE_SIZE) {
        assertIntegerInRange("Max Capacity", maxCapacity, 1, MAX_CACHE_SIZE);
        // at this point we know we have 1 to max
        this.__maxCap = maxCapacity;
    }
    
    public get(key: string): T | null {
        const item = this.__items.get(key);
        if (typeof item !== "undefined") return item;

        return null;
    }

    public set(key: string, value: T): void {
        if (typeof value === "undefined") {
            console.error(`Cache.set() called with undefined value for key: ${key}`);
            return;
        }

        const exist = this.__items.has(key);
        if (exist) {
            this.__items.set(key, value);
            return;
        }

        const isAtMax = this.size() >= this.__maxCap;
        if (isAtMax) {
            // remove the oldest entry first
            const oldestItem = this.__items.keys().next().value as string;
            this.__items.delete(oldestItem);
        }

        this.__items.set(key, value);
    }

    public remove(key: string): void {
        this.__items.delete(key);
    }

    private size(): number {
        return this.__items.size;
    }
};