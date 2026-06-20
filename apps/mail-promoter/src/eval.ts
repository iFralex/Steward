// apps/mail-promoter/src/eval.ts
import { shouldConsider } from "./prefilter.ts";
import { classify } from "./classify.ts";
import type { Chat } from "./llm.ts";

export type LabelledItem = {
  messageId: string;
  label: "promote" | "skip";
  msg: { fromAddr: string; fromName: string; subject: string; bodyText: string; bodyState: string };
  role?: string;
};

export async function evaluate(items: LabelledItem[], chat: Chat): Promise<{ tp: number; fp: number; tn: number; fn: number; precision: number; recall: number }> {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const it of items) {
    let predict: boolean;
    if (!shouldConsider(it.msg, it.role)) {
      predict = false;
    } else {
      const v = await classify(it.msg, chat);
      predict = v?.promote === true;
    }
    const actual = it.label === "promote";
    if (predict && actual) tp++;
    else if (predict && !actual) fp++;
    else if (!predict && !actual) tn++;
    else fn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return { tp, fp, tn, fn, precision, recall };
}
