import { Span } from "@opentelemetry/api";
import { ElelemUsage, ElelemConfigAttributes } from "./types";

export const setElelemConfigAttributes = (
  span: Span,
  ElelemConfigAttributes: ElelemConfigAttributes,
) => {
  for (const key of Object.keys(ElelemConfigAttributes)) {
    const attributeKey = key as keyof ElelemConfigAttributes;
    span.setAttribute(attributeKey, ElelemConfigAttributes[attributeKey]);
  }
};

export const setUsageAttributes = (span: Span, usage: ElelemUsage) => {
  span.setAttribute("openai.usage.completion_tokens", usage.completion_tokens);
  span.setAttribute("openai.usage.prompt_tokens", usage.prompt_tokens);
  span.setAttribute("openai.usage.total_tokens", usage.total_tokens);
  span.setAttribute("openai.usage.cost_usd", usage.cost_usd);
};
