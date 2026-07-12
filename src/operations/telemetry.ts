export interface RequestTelemetryUpdate {
  model?: string;
  errorCode?: string;
  streamOutcome?: "completed" | "cancelled" | "failed";
  queueOutcome?: "admitted" | "queued" | "full";
  leaseOutcome?: "acquired" | "busy" | "released";
  streamCleanup?: Promise<void>;
}

export type ObserveRequest = (
  request: Request,
  update: RequestTelemetryUpdate,
) => void;
