import type { ChatMessage } from "../llm/client";

/**
 * json-repair@v1: the single repair turn used by generateJson(). It is
 * appended to the original conversation (after the model's bad reply), so
 * the model keeps the task context and only has to fix the format.
 */

export const id = "json-repair";
export const version = 1;

export const jsonRepairPrompt = {
  id,
  version,
  build({
    jsonSchema,
    error,
  }: {
    jsonSchema: Record<string, unknown>;
    error: string;
  }): ChatMessage {
    return {
      role: "user",
      content: [
        "Your previous reply could not be used. Problems found:",
        error.slice(0, 1500),
        "",
        "Reply again with ONLY one JSON object that fixes these problems and conforms to this JSON Schema.",
        "No prose, no explanations, no code fences.",
        JSON.stringify(jsonSchema),
      ].join("\n"),
    };
  },
};
