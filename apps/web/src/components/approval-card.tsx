/**
 * Renders a pending tool-approval request: the tool name + its typed
 * payload (e.g. an email draft) with Approve / Reject. This is the
 * custom rendering of a gated action — the user confirms here before the
 * host lets the tool execute.
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
  onDecision: (requestId: string, decision: ApprovalDecision, note?: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Badge variant="outline" className="border-amber-500/60 text-amber-600">
            approval needed
          </Badge>
          <span className="font-mono text-sm">{approval.tool}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <pre className="bg-muted text-muted-foreground overflow-auto rounded-md p-3 text-xs">
          {JSON.stringify(approval.input, null, 2)}
        </pre>
        <input
          className="border-input mt-3 w-full rounded-md border bg-transparent px-3 py-1.5 text-sm outline-none"
          placeholder="Optional note (sent to the agent if you reject)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </CardContent>
      <CardFooter className="gap-2">
        <Button size="sm" onClick={() => onDecision(approval.requestId, "allow", note || undefined)}>
          Approve
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
