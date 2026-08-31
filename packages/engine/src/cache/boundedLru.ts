export interface CacheSize<T> {
  (value: T): number
}

type CacheEntry<V> = {
  value: V
  size: number
}

export class BoundedLru<K, V> {
  private readonly values = new Map<K, CacheEntry<V>>()
  private size = 0

  constructor(
    private readonly options: {
      maxEntries: number
      maxSize: number
      sizeOf: CacheSize<V>
    },
  ) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive integer")
    }
    if (!Number.isInteger(options.maxSize) || options.maxSize <= 0) {
      throw new RangeError("maxSize must be a positive integer")
    }
  }

  get entryCount(): number {
    return this.values.size
  }

  get retainedSize(): number {
    return this.size
  }

  get(key: K): V | undefined {
    const entry = this.values.get(key)
    if (entry === undefined) return undefined
    this.values.delete(key)
    this.values.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): void {
    const entrySize = this.options.sizeOf(value)
    const previous = this.values.get(key)
    if (previous !== undefined) {
      this.values.delete(key)
      this.size -= previous.size
    }
    if (entrySize > this.options.maxSize) return
    this.values.set(key, { value, size: entrySize })
    this.size += entrySize
    this.trim()
  }

  private trim(): void {
    while (this.values.size > this.options.maxEntries || this.size > this.options.maxSize) {
      const oldest = this.values.entries().next().value
      if (oldest === undefined) return
      this.values.delete(oldest[0])
      this.size -= oldest[1].size
    }
  }
}
