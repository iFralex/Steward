/**
 * Renders a pending tool-approval request: the tool name + its typed
 * payload (e.g. an email draft) with Approve / Reject. This is the
 * custom rendering of a gated action — the user confirms here before the
 * host lets the tool execute. The payload can be EDITED before approving
 * (approve-with-edit): the tool then runs with the corrected arguments.
 */
import { useState } from "react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { PendingApproval } from "@/lib/host-socket";
import type { ApprovalDecision } from "@llm-wiki/protocol";

export function ApprovalCard({
  approval,
  onDecision,
}: {
  approval: PendingApproval;
  onDecision: (
    requestId: string,
    decision: ApprovalDecision,
    note?: string,
    editedInput?: Record<string, unknown>,
  ) => void;
}) {
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const original = JSON.stringify(approval.input, null, 2);
  const [draft, setDraft] = useState(original);

  // Parse the edited draft when editing. editedInput must be a JSON object.
  let parsed: Record<string, unknown> | undefined;
  let parseError: string | undefined;
  if (editing) {
    try {
      const value: unknown = JSON.parse(draft);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      } else {
        parseError = "Arguments must be a JSON object";
      }
    } catch (e) {
      parseError = e instanceof Error ? e.message : "Invalid JSON";
    }
  }
  const changed = editing && parsed !== undefined && draft.trim() !== original.trim();

  const approve = () =>
    onDecision(approval.requestId, "allow", note || undefined, changed ? parsed : undefined);

  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Badge variant="outline" className="border-amber-500/60 text-amber-600">
            approval needed
          </Badge>
          <span className="font-mono text-sm">{approval.tool}</span>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground ml-auto text-xs underline"
            onClick={() => {
              if (editing) setDraft(original); // cancel edits
              setEditing((v) => !v);
            }}
          >
            {editing ? "Cancel edit" : "Edit args"}
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {editing ? (
          <>
            <textarea
              className="border-input bg-muted h-40 w-full resize-y rounded-md border p-3 font-mono text-xs outline-none"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
            />
            {parseError && <p className="mt-1 text-xs text-red-500">{parseError}</p>}
            {changed && !parseError && (
              <p className="mt-1 text-xs text-amber-600">Will run with your edited arguments.</p>
            )}
          </>
        ) : (
          <pre className="bg-muted text-muted-foreground overflow-auto rounded-md p-3 text-xs">
            {original}
          </pre>
        )}
        <input
          className="border-input mt-3 w-full rounded-md border bg-transparent px-3 py-1.5 text-sm outline-none"
          placeholder="Optional note (sent to the agent after approval)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </CardContent>
      <CardFooter className="gap-2">
        <Button size="sm" onClick={approve} disabled={editing && parseError !== undefined}>
          {changed ? "Approve (edited)" : "Approve"}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => onDecision(approval.requestId, "deny", note || undefined)}
        >
          Reject
        </Button>
      </CardFooter>
    </Card>
  );
}
