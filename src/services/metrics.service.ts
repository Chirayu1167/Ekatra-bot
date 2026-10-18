import { silentLogger, type Logger } from '../logger';

/** A thread-safe-ish in-memory Prometheus metric family. Single process; fine for our
 * one-instance-per-process deployment model. Prometheus scrapes each instance's /metrics. */

type LabelSet = Record<string, string>;

interface CounterState {
  value: number;
}

interface GaugeState {
  value: number;
}

interface HistogramState {
  buckets: Record<string, number>; // le -> count (cumulative)
  declared: number[];              // configured bucket le values
  sum: number;
  count: number;
}

export class MetricsService {
  private readonly logger: Logger;
  private readonly counters = new Map<string, Map<string, CounterState>>(); // name -> labelKey -> state
  private readonly gauges = new Map<string, Map<string, GaugeState>>();
  private readonly histograms = new Map<string, Map<string, HistogramState>>();

  constructor(logger?: Logger) {
    this.logger = logger ?? silentLogger;
  }

  private labelKey(labels: LabelSet): string {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${this.escapeLabel(v)}"`)
      .join(',');
  }

  private escapeLabel(v: string): string {
    return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  private promName(name: string): string {
    // Sanitise to [a-zA-Z_:][a-zA-Z0-9_:]*
    return name.replace(/[^a-zA-Z0-9_:]/g, '_');
  }

  private fmtLabels(labels: LabelSet): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return '';
    return `{${entries.map(([k, v]) => `${k}="${this.escapeLabel(v)}"`).join(',')}}`;
  }

  /* ---------- Counter ---------- */

  counter(name: string): void {
    if (!this.counters.has(name)) this.counters.set(name, new Map());
  }

  inc(name: string, value = 1, labels: LabelSet = {}): void {
    const family = this.counters.get(name);
    if (!family) {
      this.logger.warn('metrics.unknown_counter', { name });
      return;
    }
    const key = this.labelKey(labels);
    let state = family.get(key);
    if (!state) { state = { value: 0 }; family.set(key, state); }
    state.value += value;
  }

  /* ---------- Gauge ---------- */

  gauge(name: string): void {
    if (!this.gauges.has(name)) this.gauges.set(name, new Map());
  }

  set(name: string, value: number, labels: LabelSet = {}): void {
    const family = this.gauges.get(name);
    if (!family) {
      this.logger.warn('metrics.unknown_gauge', { name });
      return;
    }
    const key = this.labelKey(labels);
    let state = family.get(key);
    if (!state) { state = { value: 0 }; family.set(key, state); }
    state.value = value;
  }

  incGauge(name: string, value = 1, labels: LabelSet = {}): void {
    const family = this.gauges.get(name);
    if (!family) return;
    const key = this.labelKey(labels);
    let state = family.get(key);
    if (!state) { state = { value: 0 }; family.set(key, state); }
    state.value += value;
  }

  decGauge(name: string, value = 1, labels: LabelSet = {}): void {
    this.incGauge(name, -value, labels);
  }

  /* ---------- Histogram ---------- */

  histogram(name: string, buckets: number[]): void {
    if (!this.histograms.has(name)) {
      this.histograms.set(name, new Map());
      // Pre-register all buckets at zero so they always appear in output.
      const family = this.histograms.get(name)!;
      const emptyKey = '';
      family.set(emptyKey, {
        buckets: Object.fromEntries(buckets.map((b) => [String(b), 0])),
        declared: [...buckets],
        sum: 0,
        count: 0,
      });
    }
  }

  observe(name: string, value: number, labels: LabelSet = {}): void {
    const family = this.histograms.get(name);
    if (!family) {
      this.logger.warn('metrics.unknown_histogram', { name });
      return;
    }
    const key = this.labelKey(labels);
    let state = family.get(key);
    if (!state) {
      // Lazily create from declared buckets (registered at declaration time).
      const proto = family.get('') ?? { buckets: {}, declared: [], sum: 0, count: 0 };
      state = {
        buckets: Object.fromEntries(proto.declared.map((b) => [String(b), 0])),
        declared: proto.declared,
        sum: 0,
        count: 0,
      };
      family.set(key, state);
    }
    state.sum += value;
    state.count += 1;
    // Increment every bucket whose le >= value (cumulative), plus +Inf.
    const sorted = Object.keys(state.buckets).map(Number).sort((a, b) => a - b);
    for (const le of sorted) {
      if (value <= le) state.buckets[String(le)] = (state.buckets[String(le)] ?? 0) + 1;
    }
    state.buckets['+Inf'] = (state.buckets['+Inf'] ?? 0) + 1;
  }

  /* ---------- Render ---------- */

  register(): string {
    const lines: string[] = [];

    for (const [name, family] of this.counters) {
      lines.push(`# HELP ${name} counter`);
      lines.push(`# TYPE ${name} counter`);
      for (const [key, state] of family) {
        lines.push(`${name}${key ? `{${key}}` : ''} ${state.value}`);
      }
      lines.push('');
    }

    for (const [name, family] of this.gauges) {
      lines.push(`# HELP ${name} gauge`);
      lines.push(`# TYPE ${name} gauge`);
      for (const [key, state] of family) {
        lines.push(`${name}${key ? `{${key}}` : ''} ${state.value}`);
      }
      lines.push('');
    }

    for (const [name, family] of this.histograms) {
      lines.push(`# HELP ${name} histogram`);
      lines.push(`# TYPE ${name} histogram`);
      for (const [key, state] of family) {
        // Skip the empty-key prototype entry used only for lazily cloning declared buckets.
        if (key === '' && state.count === 0 && state.sum === 0) continue;
        const declared = state.declared.length > 0 ? state.declared : Object.keys(state.buckets).map(Number);
        const sorted = [...declared, Number.POSITIVE_INFINITY].sort((a, b) => a - b);
        let cumulative = 0;
        for (const le of sorted) {
          cumulative += state.buckets[String(le)] ?? 0;
          const leStr = le === Number.POSITIVE_INFINITY ? '+Inf' : String(le);
          lines.push(`${name}_bucket${key ? `{${key},le="${leStr}"}` : `{le="${leStr}"}`} ${cumulative}`);
        }
        lines.push(`${name}_sum${key ? `{${key}}` : ''} ${state.sum}`);
        lines.push(`${name}_count${key ? `{${key}}` : ''} ${state.count}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

export const metrics = new MetricsService();

/* ---------- Convenience: pre-declared Ekatra metrics ---------- */

// API
export function apiRequestsTotal(): void {
  metrics.counter('ekatra_api_requests_total');
}
export function apiRequestDurationSeconds(): void {
  metrics.histogram('ekatra_api_request_duration_seconds', [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
  ]);
}
export function recordApiRequest(method: string, route: string, statusCode: number, seconds: number): void {
  apiRequestsTotal();
  metrics.inc('ekatra_api_requests_total', 1, { method, route, status_code: String(statusCode) });
  apiRequestDurationSeconds();
  metrics.observe('ekatra_api_request_duration_seconds', seconds, {
    method,
    route,
    status_code: String(statusCode),
  });
}

// Worker / queue
export function queueDepth(): void {
  metrics.gauge('ekatra_jobs_depth');
}
export function setQueueDepth(kind: string, status: string, value: number): void {
  queueDepth();
  metrics.set('ekatra_jobs_depth', value, { kind, status });
}

export function workerHeartbeatAgeSeconds(): void {
  metrics.gauge('ekatra_worker_heartbeat_age_seconds');
}
export function setWorkerHeartbeatAgeSeconds(ageSeconds: number): void {
  workerHeartbeatAgeSeconds();
  metrics.set('ekatra_worker_heartbeat_age_seconds', ageSeconds);
}

// Delivery
export function outboundMessagesTotal(): void {
  metrics.counter('ekatra_outbound_messages_total');
}
export function recordOutboundMessage(kind: string, outcome: string): void {
  outboundMessagesTotal();
  metrics.inc('ekatra_outbound_messages_total', 1, { kind, outcome });
}

export function outboundMessageAttemptsTotal(): void {
  metrics.counter('ekatra_outbound_message_attempts_total');
}
export function recordOutboundAttempt(outcome: string): void {
  outboundMessageAttemptsTotal();
  metrics.inc('ekatra_outbound_message_attempts_total', 1, { outcome });
}

// Dead letters
export function deadLettersTotal(): void {
  metrics.counter('ekatra_dead_letters_total');
}
export function recordDeadLetter(kind: string, reasonCode: string): void {
  deadLettersTotal();
  metrics.inc('ekatra_dead_letters_total', 1, { kind, reason_code: reasonCode });
}

// Inbound
export function webhookReceivedTotal(): void {
  metrics.counter('ekatra_webhook_received_total');
}
export function recordWebhookReceived(): void {
  webhookReceivedTotal();
  metrics.inc('ekatra_webhook_received_total', 1);
}

// LLM
export function llmCallsTotal(): void {
  metrics.counter('ekatra_llm_calls_total');
}
export function recordLlmCall(model: string, outcome: string): void {
  llmCallsTotal();
  metrics.inc('ekatra_llm_calls_total', 1, { model, outcome });
}

export function llmTokensTotal(): void {
  metrics.counter('ekatra_llm_tokens_total');
}
export function recordLlmTokens(model: string, direction: 'input' | 'output', tokens: number): void {
  llmTokensTotal();
  metrics.inc('ekatra_llm_tokens_total', tokens, { model, direction });
}

// Opt-out
export function optOutsTotal(): void {
  metrics.gauge('ekatra_opt_outs_total');
}
export function setOptOutsTotal(value: number): void {
  optOutsTotal();
  metrics.set('ekatra_opt_outs_total', value);
}
