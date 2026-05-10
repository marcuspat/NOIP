// In-memory `RawKubernetesClient` used as a fallback when the live
// kube apiserver isn't reachable. Production deployments wire
// `KubernetesClientFactory.fromConfig()` directly; this implementation
// exists so:
//
//   1. Local dev / unit tests can drive the adapter without
//      network access.
//   2. The HTTP edge has *something* to return when the operator has
//      not yet plumbed cluster credentials in.
//
// Tests that need to pin the data inject their own seed via
// `setSeed` / `setKindPage`.

import type {
  KindRef,
  RawKubernetesClient,
  RawKubeObject,
  RawListPage,
} from './kubernetes-adapter';
import type { NodeInfoView } from '../../domain/ports/kubernetes-client';

export interface InMemorySeed {
  byKind: Map<string, RawKubeObject[]>;
  namespaces: string[];
  nodes: NodeInfoView[];
  cluster: { name: string; endpoint: string; version: string };
}

export class InMemoryRawKubernetesClient implements RawKubernetesClient {
  private seed: InMemorySeed;

  constructor(seed?: Partial<InMemorySeed>) {
    this.seed = {
      byKind: seed?.byKind ?? new Map(),
      namespaces: seed?.namespaces ?? [],
      nodes: seed?.nodes ?? [],
      cluster: seed?.cluster ?? {
        name: 'in-memory',
        endpoint: 'in-memory://',
        version: 'v0.0.0',
      },
    };
  }

  setKindPage(kind: string, items: RawKubeObject[]): void {
    this.seed.byKind.set(kind, items);
  }

  async listKinds(): Promise<KindRef[]> {
    return [];
  }

  async listKindPage(args: {
    kind: KindRef;
    namespace?: string;
    labelSelector?: string;
    limit: number;
    continueToken?: string;
  }): Promise<RawListPage> {
    const items = this.seed.byKind.get(args.kind.kind) ?? [];
    const filtered = args.namespace
      ? items.filter(i => i.metadata?.namespace === args.namespace)
      : items;
    return { items: filtered };
  }

  async getClusterInfo(): Promise<{
    name: string;
    endpoint: string;
    version: string;
  }> {
    return this.seed.cluster;
  }

  async listNamespaces(): Promise<string[]> {
    return this.seed.namespaces;
  }

  async listNodeInfo(): Promise<NodeInfoView[]> {
    return this.seed.nodes;
  }
}
