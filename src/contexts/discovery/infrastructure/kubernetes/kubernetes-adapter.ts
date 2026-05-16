// KubernetesAdapter — the Anti-Corruption Layer between NOIP's domain
// and the kube-apiserver (DDD-16).
//
// Responsibilities (DDD-16 §ACL responsibilities):
//   1. Speak the kube protocol (via `@kubernetes/client-node`).
//   2. Translate kube objects to `KubernetesResourceRecord`s — drop
//      `metadata.managedFields`, `resourceVersion`, `uid`,
//      `creationTimestamp`, etc. so snapshot hashes stay stable.
//   3. Apply retry/timeout policy (`retries.ts`).
//   4. Translate transport errors to typed `BackpressureError` /
//      `ProviderError` / `UnauthorizedError`.
//   5. Emit Prometheus-style metric *log lines* — real counters arrive
//      in Phase 5; until then the structured logs let us derive them
//      via Loki recording rules.
//
// The adapter is intentionally split into two layers:
//   - `kubernetesClientFactory` — a thin shim over the kube SDK that
//     returns *raw* kube list responses by kind. Easy to fake.
//   - `KubernetesAdapter` — the domain-facing class. It composes the
//     factory with retries, scope filtering, pagination, parallel
//     fan-out, and shape translation. This is the layer the
//     application service depends on.

import type {
  ClusterInfoView,
  ClusterSpec,
  KubernetesClient,
  NodeInfoView,
} from '../../domain/ports/kubernetes-client';
import type {
  KubernetesResourceRecord,
  Scope,
} from '../../domain/value-objects';
import type { Clock } from '../../../../shared/kernel';
import { kubernetesRequestsTotal } from '../../../../observability/metrics';
import { withRetry, translateError } from './retries';

/** Logger surface — subset of winston. */
export interface AdapterLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  /**
   * Optional. Phase 5 (ADR-0023) replaces noisy metric-style `info`
   * logs with real Prometheus counters; the corresponding human-grep
   * paper trail now lands on `debug`. Tests that hand in older
   * loggers without a `debug` method continue to work — call sites
   * fall back to `info` when `debug` is missing.
   */
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
}

const NOOP_LOGGER: AdapterLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * Minimal raw-list response shape we consume. The kube SDK returns
 * objects of this rough shape regardless of kind; we only depend on
 * `items` and `metadata.continue` so the binding is loose.
 */
export interface RawListPage {
  items: RawKubeObject[];
  continueToken?: string;
}

export interface RawKubeObject {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    // Fields we explicitly drop:
    resourceVersion?: string;
    uid?: string;
    creationTimestamp?: string | Date;
    managedFields?: unknown[];
  };
  spec?: unknown;
  status?: unknown;
}

/**
 * Bottom-half port the adapter delegates to. Tests substitute a fake;
 * production wires `KubernetesClientFactory.fromConfig`.
 */
export interface RawKubernetesClient {
  /** Discover supported kinds via `/apis`. */
  listKinds(): Promise<KindRef[]>;
  /** Paginated list of resources of one kind, optionally namespace-scoped. */
  listKindPage(args: {
    kind: KindRef;
    namespace?: string;
    labelSelector?: string;
    limit: number;
    continueToken?: string;
  }): Promise<RawListPage>;
  /** Cluster-info call for the legacy `ClusterInfo` shape. */
  getClusterInfo(): Promise<{
    name: string;
    endpoint: string;
    version: string;
  }>;
  listNamespaces(): Promise<string[]>;
  listNodeInfo(): Promise<NodeInfoView[]>;
}

export interface KindRef {
  apiVersion: string;
  kind: string;
  /** True when the resource is namespaced (Pod, Deployment, …). */
  namespaced: boolean;
}

/** Default kinds we always fetch when `scope.kinds` is empty. Keeps
 * the adapter useful out-of-the-box without a full `/apis` discovery
 * round-trip. The `discoverKinds: true` opt-in goes through the raw
 * client. */
export const DEFAULT_KINDS: ReadonlyArray<KindRef> = [
  { apiVersion: 'v1', kind: 'Node', namespaced: false },
  { apiVersion: 'v1', kind: 'Namespace', namespaced: false },
  { apiVersion: 'v1', kind: 'Pod', namespaced: true },
  { apiVersion: 'v1', kind: 'Service', namespaced: true },
  { apiVersion: 'v1', kind: 'ConfigMap', namespaced: true },
  { apiVersion: 'apps/v1', kind: 'Deployment', namespaced: true },
  { apiVersion: 'apps/v1', kind: 'StatefulSet', namespaced: true },
  { apiVersion: 'apps/v1', kind: 'DaemonSet', namespaced: true },
];

export interface KubernetesAdapterOptions {
  raw: RawKubernetesClient;
  clock: Clock;
  logger?: AdapterLogger;
  /** Maximum kinds fetched in parallel. */
  concurrency?: number;
  /** Per-page page-size. Default 500 (DDD-16). */
  pageSize?: number;
  /** Replace defaults; mostly useful in tests. */
  defaultKinds?: ReadonlyArray<KindRef>;
  /** When true, ask the apiserver for the kind catalogue. */
  discoverKinds?: boolean;
  /** Retry-helper deps: lets tests pin sleep/random. */
  retryDeps?: Parameters<typeof withRetry>[2];
}

/**
 * Translates a raw kube object onto our domain shape. Guards against
 * missing fields so a partially-formed apiserver response doesn't
 * blow up the whole scan.
 */
export function translateRecord(
  raw: RawKubeObject,
  fallbackKind: KindRef
): KubernetesResourceRecord | null {
  const name = raw.metadata?.name;
  if (!name) return null; // Unnamed resource — drop.
  const apiVersion = raw.apiVersion ?? fallbackKind.apiVersion;
  const kind = raw.kind ?? fallbackKind.kind;
  const out: KubernetesResourceRecord = {
    apiVersion,
    kind,
    name,
    labels: raw.metadata?.labels ?? {},
    annotations: stripVolatileAnnotations(raw.metadata?.annotations ?? {}),
    spec: raw.spec ?? null,
    status: raw.status ?? null,
  };
  if (raw.metadata?.namespace !== undefined) {
    out.namespace = raw.metadata.namespace;
  }
  return out;
}

/**
 * Strips annotations that change every reconcile loop and would make
 * the snapshot hash flap (`kubectl.kubernetes.io/last-applied-...`,
 * `deployment.kubernetes.io/revision`, etc.).
 */
const VOLATILE_ANNOTATION_KEYS: ReadonlyArray<RegExp> = [
  /^kubectl\.kubernetes\.io\/last-applied-configuration$/,
  /^deployment\.kubernetes\.io\/revision$/,
  /^control-plane\.alpha\.kubernetes\.io\/leader$/,
  /^autoscaling\.alpha\.kubernetes\.io\/.+$/,
];

function stripVolatileAnnotations(
  ann: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ann)) {
    let drop = false;
    for (const r of VOLATILE_ANNOTATION_KEYS) {
      if (r.test(k)) {
        drop = true;
        break;
      }
    }
    if (!drop) out[k] = v;
  }
  return out;
}

/**
 * Filters `DEFAULT_KINDS` (or `discoverKinds` output) by an optional
 * scope.kinds whitelist.
 */
function filterKinds(
  kinds: ReadonlyArray<KindRef>,
  whitelist?: string[]
): KindRef[] {
  if (!whitelist || whitelist.length === 0) return [...kinds];
  const set = new Set(whitelist.map(k => k.toLowerCase()));
  return kinds.filter(k => set.has(k.kind.toLowerCase()));
}

export class KubernetesAdapter implements KubernetesClient {
  private readonly raw: RawKubernetesClient;
  private readonly clock: Clock;
  private readonly logger: AdapterLogger;
  private readonly concurrency: number;
  private readonly pageSize: number;
  private readonly defaultKinds: ReadonlyArray<KindRef>;
  private readonly discoverKinds: boolean;
  private readonly retryDeps: Parameters<typeof withRetry>[2];

  constructor(opts: KubernetesAdapterOptions) {
    this.raw = opts.raw;
    this.clock = opts.clock;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.concurrency = opts.concurrency ?? 8;
    this.pageSize = opts.pageSize ?? 500;
    this.defaultKinds = opts.defaultKinds ?? DEFAULT_KINDS;
    this.discoverKinds = opts.discoverKinds ?? false;
    this.retryDeps = opts.retryDeps ?? {};
  }

  /**
   * Async iteration is the public face of the adapter. We resolve
   * kinds once up front, then fan out at most `concurrency` list
   * calls in parallel. Records arrive into a buffer the iterator
   * drains lazily.
   */
  async *listResources(scope: Scope): AsyncIterable<KubernetesResourceRecord> {
    const start = Date.now();
    const kinds = await this.resolveKinds(scope);

    // Producer queue: each kind dispatches to a worker bounded by
    // `concurrency`. We collect into an array first because the
    // domain-facing API is `AsyncIterable` and queues+backpressure
    // are an unnecessary complication for the data sizes we handle.
    const out: KubernetesResourceRecord[] = [];
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const idx = cursor;
        cursor++;
        if (idx >= kinds.length) return;
        const kind = kinds[idx]!;
        try {
          for await (const r of this.streamKind(scope, kind)) {
            out.push(r);
          }
        } catch (err) {
          // The error is already a typed domain error (translateError
          // in withRetry). Surface it as a partial-coverage warning;
          // upstream code (DiscoveryService) catches and decides
          // whether the scan is fully failed or partial.
          kubernetesRequestsTotal
            .labels({ verb: 'list', status: 'error' })
            .inc();
          this.debugLog('noip_kubernetes_request_partial_failure', {
            kind: kind.kind,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      }
    };

    const workers: Promise<void>[] = [];
    const limit = Math.min(this.concurrency, kinds.length);
    for (let i = 0; i < limit; i++) workers.push(worker());
    await Promise.all(workers);

    kubernetesRequestsTotal
      .labels({ verb: 'list', status: 'success' })
      .inc();
    this.debugLog('noip_kubernetes_request_total', {
      kinds: kinds.length,
      records: out.length,
      durationMs: Date.now() - start,
    });
    for (const r of out) yield r;
  }

  async getCluster(_spec: ClusterSpec): Promise<ClusterInfoView> {
    return withRetry(
      async () => {
        const start = Date.now();
        const info = await this.raw.getClusterInfo();
        const [namespaces, nodes, pods, services] = await Promise.all([
          this.raw.listNamespaces(),
          this.raw.listNodeInfo(),
          this.countKind({ apiVersion: 'v1', kind: 'Pod', namespaced: true }),
          this.countKind({
            apiVersion: 'v1',
            kind: 'Service',
            namespaced: true,
          }),
        ]);
        kubernetesRequestsTotal
          .labels({ verb: 'getCluster', status: 'success' })
          .inc();
        this.debugLog('noip_kubernetes_request_duration_ms', {
          op: 'getCluster',
          durationMs: Date.now() - start,
        });
        return {
          name: info.name,
          endpoint: info.endpoint,
          version: info.version,
          nodeCount: nodes.length,
          namespaceCount: namespaces.length,
          podCount: pods,
          serviceCount: services,
          lastScan: this.clock.now(),
        };
      },
      'getCluster',
      this.retryDeps
    );
  }

  async getNamespaces(): Promise<string[]> {
    return withRetry(
      async () => this.raw.listNamespaces(),
      'getNamespaces',
      this.retryDeps
    );
  }

  async getNodeInfo(): Promise<NodeInfoView[]> {
    return withRetry(
      async () => this.raw.listNodeInfo(),
      'getNodeInfo',
      this.retryDeps
    );
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------
  /**
   * Forward to `logger.debug` if available, otherwise silently drop.
   * Older injected loggers may pre-date the optional `debug` channel —
   * a metric paper trail is best-effort, not load-bearing.
   */
  private debugLog(msg: string, meta?: Record<string, unknown>): void {
    this.logger.debug?.(msg, meta);
  }

  private async resolveKinds(scope: Scope): Promise<KindRef[]> {
    if (this.discoverKinds) {
      const all = await withRetry(
        async () => this.raw.listKinds(),
        'listKinds',
        this.retryDeps
      );
      return filterKinds(all, scope.kinds);
    }
    return filterKinds(this.defaultKinds, scope.kinds);
  }

  private async *streamKind(
    scope: Scope,
    kind: KindRef
  ): AsyncIterable<KubernetesResourceRecord> {
    let token: string | undefined;
    do {
      const args: Parameters<RawKubernetesClient['listKindPage']>[0] = {
        kind,
        limit: this.pageSize,
      };
      if (kind.namespaced && scope.namespace !== undefined) {
        args.namespace = scope.namespace;
      }
      if (scope.labelSelector !== undefined) {
        args.labelSelector = scope.labelSelector;
      }
      if (token !== undefined) args.continueToken = token;
      const page = await withRetry(
        async () => this.raw.listKindPage(args),
        `list-${kind.kind}`,
        this.retryDeps
      );
      for (const item of page.items) {
        const rec = translateRecord(item, kind);
        if (rec !== null) yield rec;
      }
      token = page.continueToken;
    } while (token !== undefined && token !== '');
  }

  private async countKind(kind: KindRef): Promise<number> {
    let n = 0;
    let token: string | undefined;
    do {
      const args: Parameters<RawKubernetesClient['listKindPage']>[0] = {
        kind,
        limit: this.pageSize,
      };
      if (token !== undefined) args.continueToken = token;
      const page = await this.raw.listKindPage(args);
      n += page.items.length;
      token = page.continueToken;
    } while (token !== undefined && token !== '');
    return n;
  }
}

/** Re-export so consumers don't reach into `retries.ts` directly. */
export { withRetry, translateError };
