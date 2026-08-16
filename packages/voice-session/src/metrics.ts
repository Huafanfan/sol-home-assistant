import type { MetricsSink, SafeMetricEvent } from "./contracts.js";

export class NoopMetrics implements MetricsSink {
  public record(_event: SafeMetricEvent): void {
    // Intentionally empty. Production logging is injected at the Gateway edge.
  }
}

export class InMemoryMetrics implements MetricsSink {
  readonly events: SafeMetricEvent[] = [];

  public record(event: SafeMetricEvent): void {
    this.events.push(event);
  }

  public summary(): {
    readonly eventCount: number;
    readonly failureCount: number;
    readonly interruptionCount: number;
  } {
    return {
      eventCount: this.events.length,
      failureCount: this.events.filter((event) => event.type === "failed")
        .length,
      interruptionCount: this.events.filter(
        (event) => event.type === "interrupted",
      ).length,
    };
  }
}
