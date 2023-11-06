import type OpenAI from "openai";
import {
  backOff,
  type BackoffOptions,
  IBackOffOptions,
} from "exponential-backoff";
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
  ElelemUsage,
  ElelemError,
  Cohere,
} from "./types";
import { estimateCost } from "./costs";
import { getCache } from "./caching";
import { setElelemConfigAttributes, setUsageAttributes } from "./tracing";
import { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { ZodType } from "zod";
import { generateRequest } from "cohere-ai/dist/models";

function getTracer() {
  return trace.getTracer("elelem", "0.0.1");
}

const callOpenAIApi = async (
  openai: OpenAI,
  systemPromptWithFormat: string,
  userPrompt: string,
  modelOptions: Omit<ChatCompletionCreateParamsNonStreaming, "messages">,
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

const callCohereApi = async (
  cohere: Cohere,
  systemPromptWithFormat: string,
  userPrompt: string,
  modelOptions: Omit<generateRequest, "prompt"> & { max_tokens: number },
): Promise<string> => {
  return await getTracer().startActiveSpan(`cohere-call`, async (span) => {
    span.setAttribute("cohere.prompt.system", systemPromptWithFormat);
    span.setAttribute("cohere.prompt.user", userPrompt);

    const response = await cohere.generate({
      ...modelOptions,
      prompt: `${systemPromptWithFormat}\n${userPrompt}`,
    });

    if (response.statusCode !== 200) {
      span.end();
      throw new Error("Error code from api!");
    }

    // todo: add cost calculation once available if cohere supports it in the future

    span.setAttribute("cohere.response", response.body.generations[0].text);

    span.end();
    return response.body.generations[0].text;
  });
};

async function withRetries<T>(
  spanName: string,
  operation: (span: Span, parentSpan: Span) => Promise<T>,
  backoffOptions?: Partial<BackoffOptions>,
): Promise<T> {
  let attemptCounter = 0;
  let nonRetryErr: Error | undefined = undefined;

  return await getTracer().startActiveSpan(spanName, async (parentSpan) => {
    try {
      return await backOff(async () => {
        if (nonRetryErr !== undefined) {
          throw nonRetryErr;
        } else {
          return getTracer().startActiveSpan(
            `${spanName}-attempt-${attemptCounter}`,
            async (span) => {
              try {
                return await operation(span, parentSpan);
              } catch (error) {
                span.recordException(error as Exception);
                span.setStatus({ code: SpanStatusCode.ERROR });

                if ((error as Error).message.startsWith("ELELEM_NO_RETRY")) {
                  nonRetryErr = error as Error;
                }

                throw error;
              } finally {
                attemptCounter++;
                span.end();
              }
            },
          );
        }
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

async function generate<T, ModelOpt extends object>(
  chatId: string,
  combinedOptions: ModelOpt,
  systemPrompt: string,
  userPrompt: string,
  schema: ZodType<T>,
  formatter: ElelemFormatter,
  backoffOptions: Partial<IBackOffOptions> | undefined,
  cache: ElelemCache,
  apiCaller: (
    systemPromptWithFormat: string,
    userPrompt: string,
    combinedOptions: ModelOpt,
    generateAttemptUsage: ElelemUsage,
    generateUsage: ElelemUsage,
  ) => Promise<string>,
): Promise<{ result: T; usage: ElelemUsage }> {
  const generateUsage: ElelemUsage = {
    completion_tokens: 0,
    prompt_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
  };

  return await withRetries(
    chatId,
    async (generateAttemptSpan, generateSpan) => {
      let cacheHit = false;
      let error: string | null = null;
      let response: string | null = null;
      let extractedJson: string | null = null;

      const systemPromptWithFormat = `${systemPrompt}\n${formatter(schema)}`;

      const generateAttemptUsage: ElelemUsage = {
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
          cached !== null && schema.safeParse(JSON.parse(cached)).success;
        response = cacheHit
          ? cached
          : await apiCaller(
              systemPromptWithFormat,
              userPrompt,
              combinedOptions,
              generateAttemptUsage,
              generateUsage,
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

              let json;

              try {
                json = JSON.parse(extractedJson);
              } catch (e: any) {
                if (
                  "temperature" in combinedOptions &&
                  combinedOptions.temperature === 0
                ) {
                  throw new Error(`ELELEM_NO_RETRY ${e.message}`);
                } else {
                  throw e;
                }
              }

              const parsed = schema.safeParse(json);

              if (!parsed.success) {
                if (
                  "temperature" in combinedOptions &&
                  combinedOptions.temperature === 0
                ) {
                  throw new Error(
                    `ELELEM_NO_RETRY Invalid schema returned from LLM: ${parsed.error.toString()}`,
                  );
                } else {
                  throw new Error(
                    `Invalid schema returned from LLM: ${parsed.error.toString()}`,
                  );
                }
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
                  usage: generateUsage,
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
        generateAttemptSpan.recordException(e as Error);
        generateAttemptSpan.setStatus({
          code: SpanStatusCode.ERROR,
        });
        error = String(e);
        const message = (e as Error).message;
        throw new ElelemError(
          message,
          // should represent total so far across attempts
          generateUsage,
        );
      } finally {
        const attributes: ElelemConfigAttributes = {
          "elelem.cache.hit": cacheHit,
          "elelem.error": error || "null",
          "openai.prompt.options": JSON.stringify(combinedOptions),
          "openai.prompt.system": systemPromptWithFormat,
          "openai.prompt.user": userPrompt,
          "openai.prompt.response": response || "null",
          "openai.prompt.response.extracted": extractedJson || "null",
        };

        // handle attempt attributes
        setElelemConfigAttributes(generateAttemptSpan, attributes);
        setUsageAttributes(generateAttemptSpan, generateAttemptUsage);

        // handle the parent attributes each attempt
        setElelemConfigAttributes(generateSpan, attributes);
        setUsageAttributes(generateSpan, generateUsage);

        generateAttemptSpan.end();
      }
    },
    backoffOptions || { numOfAttempts: 3 },
  );
}

export const elelem: Elelem = {
  init: (config: ElelemConfig) => {
    const { backoffOptions, cache: cacheConfig, openai, cohere } = config;

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
              openai: async (
                chatId,
                modelOptions,
                systemPrompt,
                userPrompt,
                schema,
                formatter: ElelemFormatter,
              ) => {
                if (
                  openai === undefined ||
                  defaultModelOptions.openai === undefined
                ) {
                  throw new Error("You must configure OpenAI!");
                }

                const apiCaller = async (
                  systemPromptWithFormat: string,
                  userPrompt: string,
                  combinedOptions: Omit<
                    ChatCompletionCreateParamsNonStreaming,
                    "messages"
                  >,
                  generateAttemptUsage: ElelemUsage,
                  generateUsage: ElelemUsage,
                ): Promise<string> => {
                  return await callOpenAIApi(
                    openai,
                    systemPromptWithFormat,
                    userPrompt,
                    combinedOptions,
                    generateAttemptUsage,
                    generateUsage,
                    sessionUsage,
                  );
                };

                const combinedOptions = {
                  ...defaultModelOptions.openai,
                  ...modelOptions,
                };

                return await generate(
                  chatId,
                  combinedOptions,
                  systemPrompt,
                  userPrompt,
                  schema,
                  formatter,
                  backoffOptions,
                  cache,
                  apiCaller,
                );
              },
              cohere: async (
                chatId,
                modelOptions,
                systemPrompt,
                userPrompt,
                schema,
                formatter: ElelemFormatter,
              ) => {
                if (cohere === undefined) {
                  throw new Error("You must configure Cohere!");
                }

                const apiCaller = async (
                  systemPromptWithFormat: string,
                  userPrompt: string,
                  combinedOptions: Omit<generateRequest, "prompt"> & {
                    max_tokens: number;
                  },
                ): Promise<string> => {
                  return await callCohereApi(
                    cohere,
                    systemPromptWithFormat,
                    userPrompt,
                    combinedOptions,
                  );
                };

                const combinedOptions: Omit<generateRequest, "prompt"> & {
                  max_tokens: number;
                } = {
                  ...{ max_tokens: 100 },
                  ...defaultModelOptions.cohere,
                  ...modelOptions,
                };

                // since cohere doesn't have actual system prompts, it has trouble identifying where the input starts
                const prefixedUserPrompt = `\nInput: ${userPrompt}`;

                return await generate(
                  chatId,
                  combinedOptions,
                  systemPrompt,
                  prefixedUserPrompt,
                  schema,
                  formatter,
                  backoffOptions,
                  cache,
                  apiCaller,
                );
              },
              action: async <AC extends object, T>(
                actionId: string,
                actionContext: AC,
                cacheSerializer: (cacheValue: T) => string,
                cacheDeserializer: (cacheValue: string) => T,
                operation: (
                  actionContext: AC,
                  span: Span,
                  parentSpan: Span,
                ) => Promise<T>,
                backoffOptions?: Partial<BackoffOptions>,
              ): Promise<T> => {
                return await withRetries(
                  actionId,
                  async (span, parentSpan) => {
                    const cacheValue = await withRetries(
                      "cache-read",
                      async (cacheReadSpan) => {
                        const cacheResult = await cache.read(actionContext);
                        cacheReadSpan.setAttribute(
                          "elelem.cache.hit",
                          cacheResult !== null,
                        );
                        cacheReadSpan.end();
                        return cacheResult;
                      },
                      backoffOptions || { numOfAttempts: 3 },
                    );

                    if (cacheValue) {
                      return cacheDeserializer(cacheValue);
                    } else {
                      const result = await operation(
                        actionContext,
                        span,
                        parentSpan,
                      );

                      await withRetries(
                        "cache-write",
                        async (cacheReadSpan) => {
                          await cache.write(
                            actionContext,
                            cacheSerializer(result),
                          );
                          cacheReadSpan.end();
                        },
                        backoffOptions || { numOfAttempts: 3 },
                      );

                      return result;
                    }
                  },
                  backoffOptions,
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
