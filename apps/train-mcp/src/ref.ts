import type { TrainRefData } from "./types.ts";

export function encodeTrainRef(data: Omit<TrainRefData, "version">): string {
  return `vt1_${Buffer.from(JSON.stringify({ version: 1, ...data }), "utf8").toString("base64url")}`;
}

export function decodeTrainRef(value: string): TrainRefData {
  if (!value.startsWith("vt1_")) throw new Error("Invalid trainRef. Call find_next_train again to obtain a current reference.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice(4), "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid trainRef. Call find_next_train again to obtain a current reference.");
  }
  const data = parsed as Partial<TrainRefData>;
  if (data.version !== 1 || typeof data.trainNumber !== "string" || typeof data.originId !== "string") {
    throw new Error("Invalid trainRef. Call find_next_train again to obtain a current reference.");
  }
  return data as TrainRefData;
}
