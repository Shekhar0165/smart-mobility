import { GoogleGenAI } from "@google/genai";

export const VISION_SYSTEM_PROMPT =
  "The user is visually impaired. Describe the scene briefly, calmly, and with safety first. Mention direction as left, front, or right and rough distance when possible. Never claim certainty. All distances are estimates and must be described as estimates. Scene understanding is advisory only and is not the safety trigger.";

export const sceneResponseSchema = {
  type: "OBJECT",
  additionalProperties: false,
  properties: {
    description: { type: "STRING" },
    objects: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        additionalProperties: false,
        properties: {
          label: { type: "STRING" },
          side: { type: "STRING", enum: ["left", "front", "right"] },
          estimatedDistanceM: { type: "NUMBER" },
          risk: { type: "STRING", enum: ["low", "medium", "high"] },
        },
        required: ["label", "side", "estimatedDistanceM", "risk"],
        propertyOrdering: ["label", "side", "estimatedDistanceM", "risk"],
      },
    },
    advice: { type: "STRING" },
  },
  required: ["description", "objects", "advice"],
  propertyOrdering: ["description", "objects", "advice"],
};

export async function describeWithGemini(imageBase64) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: "Describe the visible surroundings for a visually impaired user. Keep it short. Estimate the side and rough distance for visible obstacles, and return only the requested JSON fields. Do not present a guessed distance as certain.",
          },
          { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
        ],
      },
    ],
    config: {
      systemInstruction: VISION_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: sceneResponseSchema,
      maxOutputTokens: 400,
    },
  });
  return response.text || "";
}
