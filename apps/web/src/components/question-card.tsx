/**
 * Renders an `ask_user` question: the prompt plus its options as a single-select
 * (radio) or multi-select (checkbox) picker, and sends the chosen labels back as
 * a `question_response`. "Skip" replies with no choice (empty selection).
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PendingQuestion } from "@/lib/host-socket";

export function QuestionCard({
  question,
  onRespond,
}: {
  question: PendingQuestion;
  onRespond: (requestId: string, selected: string[]) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);

  const toggle = (opt: string) => {
    if (question.multiSelect) {
      setSelected((prev) => (prev.includes(opt) ? prev.filter((o) => o !== opt) : [...prev, opt]));
    } else {
      setSelected([opt]);
    }
  };

  const canSubmit = question.multiSelect ? selected.length > 0 : selected.length === 1;

  return (
    <Card className="border-primary/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-start gap-2 text-sm">
          <span aria-hidden>❓</span>
          <span>{question.question}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          {question.options.map((opt) => {
            const on = selected.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => toggle(opt)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition",
                  on ? "border-primary bg-primary/10" : "border-input hover:bg-muted",
                )}
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center border text-[10px] leading-none",
                    question.multiSelect ? "rounded" : "rounded-full",
                    on ? "border-primary bg-primary text-primary-foreground" : "border-input",
                  )}
                >
                  {on ? "✓" : ""}
                </span>
                <span>{opt}</span>
              </button>
            );
          })}
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => onRespond(question.requestId, [])}>
            {t("question.skip")}
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={() => onRespond(question.requestId, selected)}>
            {t("question.send")}{question.multiSelect && selected.length > 0 ? ` (${selected.length})` : ""}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
