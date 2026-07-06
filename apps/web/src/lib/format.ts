import type { ActionCenterItem } from "@steward/protocol";
import { currentLocale } from "@/lib/locale";

export function formatWhen(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(currentLocale(), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function priorityVariant(priority: ActionCenterItem["priority"]): "default" | "secondary" | "destructive" | "outline" {
  if (priority === "high") return "destructive";
  if (priority === "low") return "secondary";
  return "default";
}
