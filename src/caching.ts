import { ElelemCache, ElelemCacheConfig } from "./types";
import objectHash from "object-hash";

export const getCache = (cacheConfig: ElelemCacheConfig): ElelemCache => {
  if (cacheConfig.redis) {
    const redis = cacheConfig.redis;

    return {
      read: async (key: object) => {
        const hashedKey = objectHash(key);
        return redis.get(hashedKey);
      },
      write: async (key: object, value: string) => {
        const hashedKey = objectHash(key);
        await redis.set(hashedKey, value);
      },
    };
  } else if (cacheConfig.custom) {
    return cacheConfig.custom;
  } else {
    return {
      read: async () => null,
      write: async () => {
        // no-op
      },
    };
  }
};
