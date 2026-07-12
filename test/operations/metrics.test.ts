import { describe, expect, it } from "vitest";
import { Metrics } from "../../src/operations/metrics.js";

describe("Metrics", () => {
  it("renders bounded counters, latency, and operational gauges", () => {
    const metrics = new Metrics();
    metrics.recordRequest("chat", 200, 0.25);
    metrics.recordRequest("chat", 429, 0.5, "queue_full");
    metrics.setActiveTurns(4);
    metrics.setQueueDepth(32);
    metrics.setBusyThreads(2);
    metrics.setPendingTools(3);
    metrics.recordExpiredTools(2);
    metrics.recordAppServerRestart(7, "crash");
    metrics.setAuthReady(true);

    const output = metrics.render();

    expect(output).toContain(
      'proxy_http_requests_total{route="chat",status="200"} 1',
    );
    expect(output).toContain(
      'proxy_http_requests_total{route="chat",status="429"} 1',
    );
    expect(output).toContain(
      'proxy_http_request_duration_seconds_count{route="chat"} 2',
    );
    expect(output).toContain(
      'proxy_http_request_duration_seconds_sum{route="chat"} 0.75',
    );
    expect(output).toContain(
      'proxy_errors_total{route="chat",code="queue_full"} 1',
    );
    expect(output).toContain("proxy_active_turns 4");
    expect(output).toContain("proxy_queue_depth 32");
    expect(output).toContain("proxy_busy_threads 2");
    expect(output).toContain("proxy_pending_tools 3");
    expect(output).toContain("proxy_expired_tools_total 2");
    expect(output).toContain(
      'proxy_app_server_restarts_total{generation="7",reason="crash"} 1',
    );
    expect(output).toContain("proxy_auth_ready 1");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("escapes Prometheus label values", () => {
    const metrics = new Metrics();
    metrics.recordRequest("responses", 502, 0.1, 'bad\\"\ncode');

    expect(metrics.render()).toContain('code="bad\\\\\\"\\ncode"');
  });
});
