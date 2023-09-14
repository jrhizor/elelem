import { type Redis } from "ioredis";
import type OpenAI from "openai";
import { type ZodType } from "zod";
import { backOff, type BackoffOptions } from "exponential-backoff";
import objectHash from "object-hash";
import {
  type Exception,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { type CompletionUsage } from "openai/resources";
import { type ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { extractLastJSON } from "./helpers";

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

export interface ElelemMetadata {
  id: string;
}

export interface Elelem {
  init: (config: ElelemConfig) => InitializedElelem;
}

export type ElelemFormatter = <T>(schema: ZodType<T>) => string;

type ElelemModelOptions = Omit<
  ChatCompletionCreateParamsNonStreaming,
  "messages"
>;

export interface InitializedElelem {
  session: <T>(
    metadata: ElelemMetadata,
    defaultModelOptions: ElelemModelOptions,
    contextFunction: (context: ElelemContext) => Promise<T>,
  ) => Promise<{ result: T; usage: ElelemUsage }>;
}

export interface ElelemContext {
  singleChat: <T>(
    metadata: ElelemMetadata,
    systemPrompt: string,
    userPrompt: string,
    schema: ZodType<T>,
    formatter: ElelemFormatter,
    modelOptions?: Partial<ElelemModelOptions>,
  ) => Promise<{ result: T; usage: ElelemUsage }>;
}

const getCache = (cacheConfig: ElelemCacheConfig): ElelemCache => {
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

const estimateCost = (usage: CompletionUsage, model: string) => {
  const computeCost = (
    pricePerThousandInputTokens: number,
    pricePerThousandOutputTokens: number,
  ) => {
    return (
      (pricePerThousandInputTokens * usage.prompt_tokens) / 1000 +
      (pricePerThousandOutputTokens * usage.completion_tokens) / 1000
    );
  };

  if (model.startsWith("gpt-4")) {
    if (model.includes("32k")) {
      return computeCost(0.06, 0.12);
    } else {
      // 8k
      return computeCost(0.03, 0.06);
    }
  } else if (model.startsWith("gpt-3.5-turbo")) {
    if (model.includes("16k")) {
      return computeCost(0.003, 0.004);
    } else {
      // 4k
      return computeCost(0.0015, 0.002);
    }
  } else {
    return 0;
  }
};

const setUsageAttributes = (span: Span, usage: ElelemUsage) => {
  span.setAttribute("openai.usage.completion_tokens", usage.completion_tokens);
  span.setAttribute("openai.usage.prompt_tokens", usage.prompt_tokens);
  span.setAttribute("openai.usage.total_tokens", usage.total_tokens);
  span.setAttribute("openai.usage.cost_usd", usage.cost_usd);
};

interface ConfigAttributes {
  "elelem.cache.hit": boolean;
  "elelem.error": string;
  "openai.prompt.options": string;
  "openai.prompt.system": string;
  "openai.prompt.user": string;
  "openai.prompt.response": string;
  "openai.prompt.response.extracted": string;
}

const setConfigAttributes = (
  span: Span,
  configAttributes: ConfigAttributes,
) => {
  for (const key of Object.keys(configAttributes)) {
    const attributeKey = key as keyof ConfigAttributes;
    span.setAttribute(attributeKey, configAttributes[attributeKey]);
  }
};

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

const callApi = async (
  openai: OpenAI,
  systemPromptWithFormat: string,
  userPrompt: string,
  modelOptions: ElelemModelOptions,
  localAttemptUsage: ElelemUsage,
  localUsage: ElelemUsage,
  sessionUsage: ElelemUsage,
): Promise<string> => {
  return await tracer.startActiveSpan(`openai-call`, async (span) => {
    span.setAttribute("openai.prompt.system", systemPromptWithFormat);
    span.setAttribute("openai.prompt.user", userPrompt);

    const chat = await openai.chat.completions.create({
      ...modelOptions,
      messages: [
        { role: "system", content: systemPromptWithFormat },
        { role: "user", content: userPrompt },
      ],
    });

    const choice = chat.choices[0];

    if (
      choice !== undefined &&
      choice.message !== undefined &&
      choice.message.content !== undefined
    ) {
      const response = choice.message.content;

      if (response === null) {
        span.end();
        throw new Error("Null response from api!");
      }

      if (chat.usage !== undefined) {
        const costUsd = estimateCost(chat.usage, modelOptions.model);

        setUsageAttributes(span, { cost_usd: costUsd, ...chat.usage });

        localAttemptUsage.completion_tokens += chat.usage.completion_tokens;
        localAttemptUsage.prompt_tokens += chat.usage.prompt_tokens;
        localAttemptUsage.total_tokens += chat.usage.total_tokens;
        localAttemptUsage.cost_usd += costUsd;

        localUsage.completion_tokens += chat.usage.completion_tokens;
        localUsage.prompt_tokens += chat.usage.prompt_tokens;
        localUsage.total_tokens += chat.usage.total_tokens;
        localUsage.cost_usd += costUsd;

        sessionUsage.completion_tokens += chat.usage.completion_tokens;
        sessionUsage.prompt_tokens += chat.usage.prompt_tokens;
        sessionUsage.total_tokens += chat.usage.total_tokens;
        sessionUsage.cost_usd += costUsd;
      }

      span.setAttribute("openai.response", response);

      span.end();
      return response;
    } else {
      span.end();
      throw new Error("No chat response from api!");
    }
  });
};

const tracer = trace.getTracer("elelem", "0.0.1");

async function withRetries<T>(
  spanName: string,
  operation: (span: Span, parentSpan: Span) => Promise<T>,
  backoffOptions?: Partial<BackoffOptions>,
): Promise<T> {
  let attemptCounter = 0;

  return await tracer.startActiveSpan(spanName, async (parentSpan) => {
    try {
      return await backOff(async () => {
        return tracer.startActiveSpan(
          `${spanName}-attempt-${attemptCounter}`,
          async (span) => {
            try {
              return await operation(span, parentSpan);
            } catch (error) {
              span.recordException(error as Exception);
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw error;
            } finally {
              attemptCounter++;
              span.end();
            }
          },
        );
      }, backoffOptions);
    } catch (error) {
      parentSpan.recordException(error as Exception);
      parentSpan.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      parentSpan.end();
    }
  });
}

export const elelem: Elelem = {
  init: (config: ElelemConfig) => {
    const { backoffOptions, cache: cacheConfig, openai } = config;

    const cache: ElelemCache = getCache(cacheConfig || {});

    return {
      session: async (metadata, defaultModelOptions, contextFunction) => {
        const sessionUsage: ElelemUsage = {
          completion_tokens: 0,
          prompt_tokens: 0,
          total_tokens: 0,
          cost_usd: 0,
        };

        return tracer.startActiveSpan(metadata.id, async (sessionSpan) => {
          try {
            const context: ElelemContext = {
              singleChat: async (
                meta,
                systemPrompt,
                userPrompt,
                schema,
                formatter: ElelemFormatter,
                modelOptions,
              ) => {
                const singleChatUsage: ElelemUsage = {
                  completion_tokens: 0,
                  prompt_tokens: 0,
                  total_tokens: 0,
                  cost_usd: 0,
                };

                return await withRetries(
                  meta.id,
                  async (singleChatAttemptSpan, singleChatSpan) => {
                    const combinedOptions = {
                      ...defaultModelOptions,
                      ...modelOptions,
                    };

                    let cacheHit = false;
                    let error: string | null = null;
                    let response: string | null = null;
                    let extractedJson: string | null = null;

                    const systemPromptWithFormat = `${systemPrompt}\n${formatter(
                      schema,
                    )}`;

                    const singleChatAttemptUsage: ElelemUsage = {
                      completion_tokens: 0,
                      prompt_tokens: 0,
                      total_tokens: 0,
                      cost_usd: 0,
                    };

                    try {
                      const cacheKey = {
                        systemPromptWithFormat,
                        userPrompt,
                        combinedOptions,
                      };

                      const cached = await withRetries(
                        "cache-read",
                        async (cacheReadSpan) => {
                          const cacheResult = await cache.read(cacheKey);
                          cacheReadSpan.setAttribute(
                            "elelem.cache.hit",
                            cacheResult !== null,
                          );
                          cacheReadSpan.end();
                          return cacheResult;
                        },
                        backoffOptions || { numOfAttempts: 3 },
                      );

                      cacheHit =
                        cached !== null &&
                        schema.safeParse(JSON.parse(cached)).success;
                      response = cacheHit
                        ? cached
                        : await callApi(
                            openai,
                            systemPromptWithFormat,
                            userPrompt,
                            combinedOptions,
                            singleChatAttemptUsage,
                            singleChatUsage,
                            sessionUsage,
                          );

                      return await tracer.startActiveSpan(
                        `parse-response`,
                        async (parseSpan) => {
                          try {
                            if (response === null) {
                              throw new Error("Null response");
                            }

                            extractedJson = extractLastJSON(response);

                            if (extractedJson === null) {
                              throw new Error("No JSON available in response");
                            }

                            const parsed = schema.safeParse(
                              JSON.parse(extractedJson),
                            );

                            if (!parsed.success) {
                              throw new Error(
                                `Invalid schema returned from LLM: ${parsed.error.toString()}`,
                              );
                            } else {
                              const nonNullJson: string = extractedJson;

                              if (!cacheHit) {
                                await withRetries(
                                  "cache-write",
                                  async (cacheReadSpan) => {
                                    await cache.write(cacheKey, nonNullJson);
                                    cacheReadSpan.end();
                                  },
                                  backoffOptions || { numOfAttempts: 3 },
                                );
                              }

                              return {
                                result: parsed.data,

                                // should represent total across all attempts
                                usage: singleChatUsage,
                              };
                            }
                          } catch (error) {
                            parseSpan.recordException(error as Exception);
                            parseSpan.setStatus({ code: SpanStatusCode.ERROR });
                            throw error;
                          } finally {
                            parseSpan.end();
                          }
                        },
                      );
                    } catch (e) {
                      singleChatAttemptSpan.recordException(e as Error);
                      singleChatAttemptSpan.setStatus({
                        code: SpanStatusCode.ERROR,
                      });
                      error = String(e);
                      throw new ElelemError(
                        (e as Error).message,
                        // should represent total so far across attempts
                        singleChatUsage,
                      );
                    } finally {
                      const attributes: ConfigAttributes = {
                        "elelem.cache.hit": cacheHit,
                        "elelem.error": error || "null",
                        "openai.prompt.options":
                          JSON.stringify(combinedOptions),
                        "openai.prompt.system": systemPromptWithFormat,
                        "openai.prompt.user": userPrompt,
                        "openai.prompt.response": response || "null",
                        "openai.prompt.response.extracted":
                          extractedJson || "null",
                      };

                      // handle attempt attributes
                      setConfigAttributes(singleChatAttemptSpan, attributes);
                      setUsageAttributes(
                        singleChatAttemptSpan,
                        singleChatAttemptUsage,
                      );

                      // handle the parent attributes each attempt
                      setConfigAttributes(singleChatSpan, attributes);
                      setUsageAttributes(singleChatSpan, singleChatUsage);

                      singleChatAttemptSpan.end();
                    }
                  },
                  backoffOptions || { numOfAttempts: 3 },
                );
              },
            };

            const result = await contextFunction(context);

            return {
              result,
              usage: sessionUsage,
            };
          } catch (e) {
            sessionSpan.recordException(e as Error);
            sessionSpan.setStatus({ code: SpanStatusCode.ERROR });
            throw new ElelemError((e as Error).message, sessionUsage);
          } finally {
            setUsageAttributes(sessionSpan, sessionUsage);
            sessionSpan.end();
          }
        });
      },
    };
  },
};
