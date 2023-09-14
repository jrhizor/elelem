import { Redis } from "ioredis";
import { BackoffOptions } from "exponential-backoff";
import OpenAI from "openai";
import { ZodType } from "zod";
import { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { ElelemUsage } from "./elelem";

export interface ElelemCache {
  // keys will be hashed using object-hash
  read: (key: object) => Promise<string | null>;
  write: (key: object, value: string) => Promise<void>;
}

export interface ElelemCacheConfig {
  redis?: Redis;
  custom?: ElelemCache;
}

export interface ElelemConfig {
  // only applies to the whole "singleChat", not cache retries, which always use the default behavior
  backoffOptions?: BackoffOptions;
  cache?: ElelemCacheConfig;
  openai: OpenAI;
}

export interface Elelem {
  init: (config: ElelemConfig) => InitializedElelem;
}

export type ElelemFormatter = <T>(schema: ZodType<T>) => string;

export type ElelemModelOptions = Omit<
  ChatCompletionCreateParamsNonStreaming,
  "messages"
>;

export interface InitializedElelem {
  session: <T>(
    sessionId: string,
    defaultModelOptions: ElelemModelOptions,
    contextFunction: (context: ElelemContext) => Promise<T>,
  ) => Promise<{ result: T; usage: ElelemUsage }>;
}

export interface ElelemContext {
  singleChat: <T>(
    chatId: string,
    modelOptions: Partial<ElelemModelOptions>,
    systemPrompt: string,
    userPrompt: string,
    schema: ZodType<T>,
    formatter: ElelemFormatter,
  ) => Promise<{ result: T; usage: ElelemUsage }>;
}

export interface ElelemConfigAttributes {
  "elelem.cache.hit": boolean;
  "elelem.error": string;
  "openai.prompt.options": string;
  "openai.prompt.system": string;
  "openai.prompt.user": string;
  "openai.prompt.response": string;
  "openai.prompt.response.extracted": string;
}
