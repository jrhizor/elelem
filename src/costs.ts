import { CompletionUsage } from "openai/resources";

export const estimateCost = (usage: CompletionUsage, model: string) => {
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
