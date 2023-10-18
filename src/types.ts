import { Redis } from "ioredis";
import { BackoffOptions } from "exponential-backoff";
import OpenAI from "openai";
import { ZodType } from "zod";
import { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { CompletionUsage } from "openai/resources";
import { Span } from "@opentelemetry/api";
import {
  cohereResponse,
  generateRequest,
  generateResponse,
} from "cohere-ai/dist/models";

export interface ElelemCache {
  // keys will be hashed using object-hash
  read: (key: object) => Promise<string | null>;
  write: (key: object, value: string) => Promise<void>;
}

export interface ElelemCacheConfig {
  redis?: Redis;
  custom?: ElelemCache;
}

export interface CohereGenerateBaseConfig {
  model: string;
  max_tokens: number;
  temperature: number;
}

export interface Cohere {
  generate: (
    config: generateRequest,
  ) => Promise<cohereResponse<generateResponse>>;
}

export interface ElelemConfig {
  // only applies to the whole "singleChat", not cache retries, which always use the default behavior
  backoffOptions?: BackoffOptions;
  cache?: ElelemCacheConfig;
  openai?: OpenAI;
  cohere?: Cohere;
}

export interface Elelem {
  init: (config: ElelemConfig) => InitializedElelem;
}

export type ElelemFormatter = <T>(schema: ZodType<T>) => string;

export interface ElelemModelOptions {
  openai?: Omit<ChatCompletionCreateParamsNonStreaming, "messages">;
  cohere?: Partial<Omit<generateRequest, "prompt">>;
}

export interface PartialElelemModelOptions {
  openai?: Partial<Omit<ChatCompletionCreateParamsNonStreaming, "messages">>;
  cohere?: Partial<Omit<generateRequest, "prompt">>;
}

export interface InitializedElelem {
  session: <T>(
    sessionId: string,
    defaultModelOptions: ElelemModelOptions,
    contextFunction: (context: ElelemContext) => Promise<T>,
  ) => Promise<{ result: T; usage: ElelemUsage }>;
}

export interface ElelemContext {
  openai: <T>(
    chatId: string,
    modelOptions: Partial<
      Omit<ChatCompletionCreateParamsNonStreaming, "messages">
    >,
    systemPrompt: string,
    userPrompt: string,
    schema: ZodType<T>,
    formatter: ElelemFormatter,
  ) => Promise<{ result: T; usage: ElelemUsage }>;

  cohere: <T>(
    chatId: string,
    modelOptions: Partial<Omit<generateRequest, "prompt">>,
    systemPrompt: string,
    userPrompt: string,
    schema: ZodType<T>,
    formatter: ElelemFormatter,
  ) => Promise<{ result: T; usage: ElelemUsage }>;

  action: <AC extends object, T>(
    actionId: string,
    actionContext: AC,
    cacheSerializer: (cacheValue: T) => string,
    cacheDeserializer: (cacheValue: string) => T,
    operation: (actionContext: AC, span: Span, parentSpan: Span) => Promise<T>,
    backoffOptions?: Partial<BackoffOptions>,
  ) => Promise<T>;
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

export type ElelemUsage = CompletionUsage & { cost_usd: number };

export class ElelemError extends Error {
  public usage: ElelemUsage;

  constructor(message: string, usage: ElelemUsage) {
    super(message);
    this.usage = usage;

    // needed for instanceOf
    Object.setPrototypeOf(this, ElelemError.prototype);
  }
}
