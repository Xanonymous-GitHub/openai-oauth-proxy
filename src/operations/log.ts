export interface LogEvent {
  requestId: string;
  route: "models" | "chat" | "responses" | "metrics" | "admin";
  model?: string;
  status: number;
  durationMs: number;
  streamOutcome?: "completed" | "cancelled" | "failed";
  queueOutcome?: "admitted" | "queued" | "full";
  leaseOutcome?: "acquired" | "busy" | "released";
  processGeneration?: number;
  restartReason?: string;
}

export type Logger = (event: LogEvent) => void;

export function createLogger(
  write: (line: string) => void = (line) => console.log(line),
): Logger {
  return (event) => {
    write(
      JSON.stringify({
        requestId: event.requestId,
        route: event.route,
        ...(event.model === undefined ? {} : { model: event.model }),
        status: event.status,
        durationMs: event.durationMs,
        ...(event.streamOutcome === undefined
          ? {}
          : { streamOutcome: event.streamOutcome }),
        ...(event.queueOutcome === undefined
          ? {}
          : { queueOutcome: event.queueOutcome }),
        ...(event.leaseOutcome === undefined
          ? {}
          : { leaseOutcome: event.leaseOutcome }),
        ...(event.processGeneration === undefined
          ? {}
          : { processGeneration: event.processGeneration }),
        ...(event.restartReason === undefined
          ? {}
          : { restartReason: event.restartReason }),
      }),
    );
  };
}

export const log = createLogger();
