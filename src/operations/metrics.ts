export type MetricRoute = "models" | "chat" | "responses" | "metrics" | "admin";

interface RequestMetric {
  route: MetricRoute;
  status: number;
  count: number;
}

interface ErrorMetric {
  route: MetricRoute;
  code: string;
  count: number;
}

interface LatencyMetric {
  count: number;
  sum: number;
}

interface RestartMetric {
  generation: number;
  reason: string;
  count: number;
}

function escapeLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

function label(name: string, value: string | number): string {
  return `${name}="${escapeLabel(String(value))}"`;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export class Metrics {
  readonly #requests = new Map<string, RequestMetric>();
  readonly #errors = new Map<string, ErrorMetric>();
  readonly #latencies = new Map<MetricRoute, LatencyMetric>();
  readonly #restarts = new Map<string, RestartMetric>();
  #activeTurns = 0;
  #queueDepth = 0;
  #busyThreads = 0;
  #pendingTools = 0;
  #expiredTools = 0;
  #authReady = 0;

  recordRequest(
    route: MetricRoute,
    status: number,
    durationSeconds: number,
    errorCode?: string,
  ): void {
    const requestKey = `${route}\u0000${status}`;
    const request = this.#requests.get(requestKey) ?? {
      route,
      status,
      count: 0,
    };
    request.count += 1;
    this.#requests.set(requestKey, request);

    const latency = this.#latencies.get(route) ?? { count: 0, sum: 0 };
    latency.count += 1;
    latency.sum += finiteNonNegative(durationSeconds);
    this.#latencies.set(route, latency);

    if (errorCode !== undefined) {
      const errorKey = `${route}\u0000${errorCode}`;
      const error = this.#errors.get(errorKey) ?? {
        route,
        code: errorCode,
        count: 0,
      };
      error.count += 1;
      this.#errors.set(errorKey, error);
    }
  }

  setActiveTurns(value: number): void {
    this.#activeTurns = finiteNonNegative(value);
  }

  setQueueDepth(value: number): void {
    this.#queueDepth = finiteNonNegative(value);
  }

  setBusyThreads(value: number): void {
    this.#busyThreads = finiteNonNegative(value);
  }

  setPendingTools(value: number): void {
    this.#pendingTools = finiteNonNegative(value);
  }

  recordExpiredTools(count = 1): void {
    this.#expiredTools += finiteNonNegative(count);
  }

  setExpiredTools(value: number): void {
    this.#expiredTools = finiteNonNegative(value);
  }

  recordAppServerRestart(generation: number, reason: string): void {
    const key = `${generation}\u0000${reason}`;
    const restart = this.#restarts.get(key) ?? {
      generation,
      reason,
      count: 0,
    };
    restart.count += 1;
    this.#restarts.set(key, restart);
  }

  setAuthReady(ready: boolean): void {
    this.#authReady = ready ? 1 : 0;
  }

  render(): string {
    const lines = [
      "# HELP proxy_http_requests_total HTTP requests completed.",
      "# TYPE proxy_http_requests_total counter",
    ];
    for (const metric of this.#requests.values()) {
      lines.push(
        `proxy_http_requests_total{${label("route", metric.route)},${label("status", metric.status)}} ${metric.count}`,
      );
    }
    lines.push(
      "# HELP proxy_http_request_duration_seconds HTTP request duration.",
      "# TYPE proxy_http_request_duration_seconds summary",
    );
    for (const [route, metric] of this.#latencies) {
      const labels = label("route", route);
      lines.push(
        `proxy_http_request_duration_seconds_count{${labels}} ${metric.count}`,
        `proxy_http_request_duration_seconds_sum{${labels}} ${metric.sum}`,
      );
    }
    lines.push(
      "# HELP proxy_errors_total Proxy errors by stable code.",
      "# TYPE proxy_errors_total counter",
    );
    for (const metric of this.#errors.values()) {
      lines.push(
        `proxy_errors_total{${label("route", metric.route)},${label("code", metric.code)}} ${metric.count}`,
      );
    }
    lines.push(
      "# TYPE proxy_active_turns gauge",
      `proxy_active_turns ${this.#activeTurns}`,
      "# TYPE proxy_queue_depth gauge",
      `proxy_queue_depth ${this.#queueDepth}`,
      "# TYPE proxy_busy_threads gauge",
      `proxy_busy_threads ${this.#busyThreads}`,
      "# TYPE proxy_pending_tools gauge",
      `proxy_pending_tools ${this.#pendingTools}`,
      "# TYPE proxy_expired_tools_total counter",
      `proxy_expired_tools_total ${this.#expiredTools}`,
      "# TYPE proxy_app_server_restarts_total counter",
    );
    for (const metric of this.#restarts.values()) {
      lines.push(
        `proxy_app_server_restarts_total{${label("generation", metric.generation)},${label("reason", metric.reason)}} ${metric.count}`,
      );
    }
    lines.push(
      "# TYPE proxy_auth_ready gauge",
      `proxy_auth_ready ${this.#authReady}`,
    );
    return `${lines.join("\n")}\n`;
  }
}
