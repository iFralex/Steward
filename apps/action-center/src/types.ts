export type ActionSourceKind = "mail" | "calendar";
export type ActionKind =
  | "reply-needed"
  | "scheduling-request"
  | "calendar-invite"
  | "event-reminder"
  | "deadline"
  | "document-action"
  | "follow-up"
  | "admin-task";
export type ActionStatus = "new" | "read" | "done" | "dismissed";
export type ActionPriority = "low" | "normal" | "high";

export interface ProposedToolStep {
  id: string;
  label: string;
  tool: string;
  input: Record<string, unknown>;
  writes: boolean;
}

export interface ProposedAction {
  id: string;
  label: string;
  summary: string;
  confidence: "low" | "medium" | "high";
  steps: ProposedToolStep[];
}

export interface ContextSnapshot {
  mail?: Record<string, unknown>;
  calendar?: Record<string, unknown>;
  contacts?: Record<string, unknown>;
  wiki?: Record<string, unknown>;
  reasoning?: string;
}

export interface ActionItem {
  id: number;
  sourceKey: string;
  sourceKind: ActionSourceKind;
  kind: ActionKind;
  status: ActionStatus;
  priority: ActionPriority;
  title: string;
  summary: string;
  dueAt: number | null;
  createdAt: number;
  updatedAt: number;
  payload: Record<string, unknown>;
}

export interface UpsertAction {
  sourceKey: string;
  sourceKind: ActionSourceKind;
  kind: ActionKind;
  priority?: ActionPriority;
  title: string;
  summary: string;
  dueAt?: number | null;
  payload?: Record<string, unknown>;
}
