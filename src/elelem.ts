import type OpenAI from "openai";
import { backOff, type BackoffOptions } from "exponential-backoff";
import {
  type Exception,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { extractLastJSON } from "./helpers";
import {
  Elelem,
  ElelemCache,
  ElelemConfig,
  ElelemConfigAttributes,
  ElelemContext,
  ElelemFormatter,
  ElelemModelOptions,
  ElelemUsage,
  ElelemError,
} from "./types";
import { estimateCost } from "./costs";
import { getCache } from "./caching";
import { setElelemConfigAttributes, setUsageAttributes } from "./tracing";

function getTracer() {
  return trace.getTracer("elelem", "0.0.1");
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
  return await getTracer().startActiveSpan(`openai-call`, async (span) => {
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

async function withRetries<T>(
  spanName: string,
  operation: (span: Span, parentSpan: Span) => Promise<T>,
  backoffOptions?: Partial<BackoffOptions>,
): Promise<T> {
  let attemptCounter = 0;

  return await getTracer().startActiveSpan(spanName, async (parentSpan) => {
    try {
      return await backOff(async () => {
        return getTracer().startActiveSpan(
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
      session: async (sessionId, defaultModelOptions, contextFunction) => {
        const sessionUsage: ElelemUsage = {
          completion_tokens: 0,
          prompt_tokens: 0,
          total_tokens: 0,
          cost_usd: 0,
        };

        return getTracer().startActiveSpan(sessionId, async (sessionSpan) => {
          try {
            const context: ElelemContext = {
              singleChat: async (
                chatId,
                modelOptions,
                systemPrompt,
                userPrompt,
                schema,
                formatter: ElelemFormatter,
              ) => {
                const singleChatUsage: ElelemUsage = {
                  completion_tokens: 0,
                  prompt_tokens: 0,
                  total_tokens: 0,
                  cost_usd: 0,
                };

                return await withRetries(
                  chatId,
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

                      return await getTracer().startActiveSpan(
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
                      const attributes: ElelemConfigAttributes = {
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
                      setElelemConfigAttributes(
                        singleChatAttemptSpan,
                        attributes,
                      );
                      setUsageAttributes(
                        singleChatAttemptSpan,
                        singleChatAttemptUsage,
                      );

                      // handle the parent attributes each attempt
                      setElelemConfigAttributes(singleChatSpan, attributes);
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
