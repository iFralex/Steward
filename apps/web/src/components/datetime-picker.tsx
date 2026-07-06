/**
 * Date + time picker (shadcn): a Calendar in a Popover for the day and a native
 * time input for the hour. Value/onChange are ISO 8601 strings ("" = unset).
 */
import * as React from "react";
import { format } from "date-fns";
import { ChevronDownIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { dateFnsLocale } from "@/lib/locale";

export function DateTimePicker({ value, onChange }: { value: string; onChange: (iso: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const date = value ? new Date(value) : undefined;
  const valid = !!date && !Number.isNaN(date.getTime());
  const time = valid ? format(date as Date, "HH:mm") : "";

  const setDatePart = (d: Date | undefined) => {
    if (!d) return;
    const base = valid ? new Date(date as Date) : new Date();
    base.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
    onChange(base.toISOString());
    setOpen(false);
  };
  const setTimePart = (timeStr: string) => {
    const [h, m] = timeStr.split(":").map(Number);
    const base = valid ? new Date(date as Date) : new Date();
    base.setHours(h || 0, m || 0, 0, 0);
    onChange(base.toISOString());
  };

  return (
    <div className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button type="button" variant="outline" className="flex-1 justify-between font-normal" />}>
          {valid ? format(date as Date, "PPP", { locale: dateFnsLocale() }) : t("datetimePicker.chooseDate")}
          <ChevronDownIcon className="size-4 opacity-60" />
        </PopoverTrigger>
        <PopoverContent className="w-auto overflow-hidden p-0" align="start">
          <Calendar
            mode="single"
            selected={valid ? date : undefined}
            captionLayout="dropdown"
            defaultMonth={valid ? date : undefined}
            onSelect={setDatePart}
            locale={dateFnsLocale()}
          />
        </PopoverContent>
      </Popover>
      <Input type="time" value={time} onChange={(e) => setTimePart(e.target.value)} className="w-28" />
      {value ? <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")} title={t("datetimePicker.clear")}>×</Button> : null}
    </div>
  );
}
