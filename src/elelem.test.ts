import { Redis } from "ioredis";
import OpenAI from "openai";
import { z } from "zod";
import { elelem, ElelemError, ElelemUsage } from "./elelem";
import { describe, expect, test, afterAll } from "@jest/globals";
import { config } from "dotenv";

import * as opentelemetry from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  JsonSchemaAndExampleFormatter,
  langchainJsonSchemaFormatter,
} from "./formatters";

const sdk = new opentelemetry.NodeSDK({
  serviceName: "elelem-test",
  traceExporter: new OTLPTraceExporter(),
});
sdk.start();

// eslint-disable-next-line @typescript-eslint/no-unsafe-call,@typescript-eslint/no-unsafe-member-access
config();

const redisClient = new Redis(process.env.REDIS!);
const openAiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const llm = elelem.init({
  openai: openAiClient,
  cache: { redis: redisClient },
});

// whole thing caches too

const capitolResponseSchema = z.object({
  capitol: z.string(),
});

const cityResponseSchema = z.object({
  foundingYear: z.string(),
  populationEstimate: z.number(),
});

const strResponseSchema = z.object({
  str: z.string(),
});

afterAll(async () => {
  redisClient.disconnect();
  redisClient.shutdown();

  await sdk
    .shutdown()
    .then(() => console.log("Tracing terminated"))
    .catch((error) => console.log("Error terminating tracing", error));
});

describe("elelem", () => {
  test("e2e example", async () => {
    const { result, usage } = await llm.session(
      { id: "e2e-example" },
      { model: "gpt-3.5-turbo" },
      async (c) => {
        const { result: capitol } = await c.singleChat(
          { id: "capitol" },
          `What is the capitol of the country provided?`,
          "USA",
          capitolResponseSchema,
          JsonSchemaAndExampleFormatter,
          { max_tokens: 100, temperature: 0 },
        );
        console.log("capitol", capitol);

        const { result: cityDescription } = await c.singleChat(
          { id: "city-description" },
          `For the given capitol city, return the founding year and an estimate of the population of the city.`,
          capitol.capitol,
          cityResponseSchema,
          JsonSchemaAndExampleFormatter,
          {
            max_tokens: 100,
            temperature: 0,
          },
        );
        console.log("cityDescription", cityDescription);

        return cityDescription;
      },
    );

    console.log(result);
    console.log(usage);

    expect(result.foundingYear).toBe("1790");
    expect(result.populationEstimate).toBeGreaterThan(500000);
  }, 10000);

  test("cache test", async () => {
    const inputString = `something-${Math.random()}`;
    const fn = async (id: string) => {
      const { usage } = await llm.session(
        { id: id },
        { model: "gpt-3.5-turbo" },
        async (c) => {
          return await c.singleChat(
            { id: id },
            `Wrap the input string in the json format.`,
            inputString,
            strResponseSchema,
            JsonSchemaAndExampleFormatter,
            { max_tokens: 100, temperature: 0 },
          );
        },
      );

      return usage;
    };

    const usage1 = await fn("cache-test-uncached");
    const usage2 = await fn("cache-test-cached");

    expect(usage1.prompt_tokens).toBeGreaterThan(0);
    expect(usage1.completion_tokens).toBeGreaterThan(0);
    expect(usage1.total_tokens).toBeGreaterThan(0);
    expect(usage1.cost_usd).toBeGreaterThan(0);

    expect(usage2.prompt_tokens).toBe(0);
    expect(usage2.completion_tokens).toBe(0);
    expect(usage2.total_tokens).toBe(0);
    expect(usage2.cost_usd).toBe(0);
  }, 10000);

  test("correct sums of tokens", async () => {
    let usage1: ElelemUsage = {
      completion_tokens: 0,
      prompt_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
    };
    let usage2: ElelemUsage = {
      completion_tokens: 0,
      prompt_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
    };

    const { usage: totalUsage } = await llm.session(
      { id: "sum-tokens-test" },
      { model: "gpt-3.5-turbo" },
      async (c) => {
        const { usage: u1 } = await c.singleChat(
          { id: "first-call" },
          `Wrap the input string in the json format.`,
          `something-${Math.random()}`,
          strResponseSchema,
          JsonSchemaAndExampleFormatter,
          { max_tokens: 100, temperature: 0 },
        );

        const { usage: u2 } = await c.singleChat(
          { id: "second-call" },
          `Wrap the input string in the json format.`,
          `something-${Math.random()}`,
          strResponseSchema,
          JsonSchemaAndExampleFormatter,
          { max_tokens: 100, temperature: 0 },
        );

        usage1 = u1;
        usage2 = u2;

        // don't actually do anything with calls
        return;
      },
    );

    expect(totalUsage.prompt_tokens).toBe(
      usage1.prompt_tokens + usage2.prompt_tokens,
    );
    expect(totalUsage.completion_tokens).toBe(
      usage1.completion_tokens + usage2.completion_tokens,
    );
    expect(totalUsage.total_tokens).toBe(
      usage1.total_tokens + usage2.total_tokens,
    );
    expect(totalUsage.cost_usd).toBe(usage1.cost_usd + usage2.cost_usd);

    expect(totalUsage.prompt_tokens).toBeGreaterThan(0);
    expect(totalUsage.completion_tokens).toBeGreaterThan(0);
    expect(totalUsage.total_tokens).toBeGreaterThan(0);
    expect(totalUsage.cost_usd).toBeGreaterThan(0);
  }, 10000);

  test("invalid format", async () => {
    const usage: ElelemUsage = {
      completion_tokens: 0,
      prompt_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
    };

    const wrapper = async () => {
      await llm
        .session(
          { id: "invalid-format" },
          { model: "gpt-3.5-turbo" },
          async (c) => {
            try {
              // todo: move cache out to before to only do once?
              // todo: move cache write to before parsing
              const { result: cityDescription } = await c.singleChat(
                { id: "city-description" },
                `Request ${Math.random()}\nFor the given capitol city, return the founding year and an estimate of the population of the city.`,
                "Washington, D.C.",
                cityResponseSchema,
                langchainJsonSchemaFormatter,
                {
                  max_tokens: 100,
                  temperature: 0,
                },
              );
              return cityDescription;
            } catch (e) {
              // check that we're returning usage for the individual attempts
              if (e instanceof ElelemError) {
                expect(e.usage.prompt_tokens).toBeGreaterThan(0);
                expect(e.usage.completion_tokens).toBeGreaterThan(0);
                expect(e.usage.total_tokens).toBeGreaterThan(0);
                expect(e.usage.cost_usd).toBeGreaterThan(0);

                usage.prompt_tokens += e.usage.prompt_tokens;
                usage.completion_tokens += e.usage.completion_tokens;
                usage.total_tokens += e.usage.total_tokens;
                usage.cost_usd += e.usage.cost_usd;
              } else {
                // this should never happen!
                expect(true).toBe(false);
              }
              throw e;
            }
          },
        )
        .catch((e) => {
          // check that we're returning usage for the session
          if (e instanceof ElelemError) {
            expect(e.usage.prompt_tokens).toBe(usage.prompt_tokens);
            expect(e.usage.completion_tokens).toBe(usage.completion_tokens);
            expect(e.usage.total_tokens).toBe(usage.total_tokens);
            expect(e.usage.cost_usd).toBe(usage.cost_usd);
          } else {
            // this should never happen!
            expect(true).toBe(false);
          }
          throw e;
        });
    };

    // langchain formatter is worse than the one that includes examples, so this should fail with the same prompt
    await expect(wrapper()).rejects.toThrowError(ElelemError);
  }, 10000);
});
