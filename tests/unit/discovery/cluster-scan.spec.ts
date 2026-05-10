// Unit tests for the ClusterScan state machine.

import { ClusterScan } from '../../../src/contexts/discovery/domain/cluster-scan';
import {
  FixedClock,
  type ClusterId,
  type SnapshotId,
} from '../../../src/shared/kernel';
import { ValidationError } from '../../../src/shared/errors';
import { emptyCounters } from '../../../src/contexts/discovery/domain/value-objects';

describe('ClusterScan aggregate', () => {
  const clusterId = '00000000-0000-7000-8000-000000000001' as ClusterId;
  const snapshotId = '00000000-0000-7000-8000-00000000beef' as SnapshotId;
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

  it('opens in pending', () => {
    const scan = ClusterScan.open(clusterId, clock);
    expect(scan.status).toBe('pending');
    expect(scan.completedAt).toBeNull();
    expect(scan.snapshotId).toBeNull();
  });

  it('start() transitions pending → running and emits scan_started', () => {
    const scan = ClusterScan.open(clusterId, clock);
    scan.start(clock);
    const evts = scan.drainEvents();
    expect(scan.status).toBe('running');
    expect(evts).toHaveLength(1);
    expect(evts[0]!.type).toBe('discovery.cluster.scan_started');
  });

  it('cannot start twice', () => {
    const scan = ClusterScan.open(clusterId, clock);
    scan.start(clock);
    expect(() => scan.start(clock)).toThrow(ValidationError);
  });

  it('succeed() requires running and emits scanned', () => {
    const scan = ClusterScan.open(clusterId, clock);
    expect(() => scan.succeed(snapshotId, emptyCounters(), clock)).toThrow(
      ValidationError
    );
    scan.start(clock);
    scan.drainEvents();
    scan.succeed(snapshotId, emptyCounters(), clock);
    expect(scan.status).toBe('succeeded');
    expect(scan.snapshotId).toBe(snapshotId);
    expect(scan.completedAt).not.toBeNull();
    const evts = scan.drainEvents();
    expect(evts).toHaveLength(1);
    expect(evts[0]!.type).toBe('discovery.cluster.scanned');
  });

  it('fail() ends the scan and emits scan_failed', () => {
    const scan = ClusterScan.open(clusterId, clock);
    scan.start(clock);
    scan.drainEvents();
    scan.fail({ code: 'PROVIDER_ERROR', message: 'kube down' }, clock);
    expect(scan.status).toBe('failed');
    const evts = scan.drainEvents();
    expect(evts).toHaveLength(1);
    expect(evts[0]!.type).toBe('discovery.cluster.scan_failed');
  });

  it('partial() preserves the error and emits scanned with partial=true', () => {
    const scan = ClusterScan.open(clusterId, clock);
    scan.start(clock);
    scan.drainEvents();
    scan.partial(
      snapshotId,
      emptyCounters(),
      { code: 'BACKPRESSURE', message: 'rate-limited' },
      clock
    );
    expect(scan.status).toBe('partial');
    expect(scan.error).toEqual({
      code: 'BACKPRESSURE',
      message: 'rate-limited',
    });
    const evts = scan.drainEvents();
    expect(evts).toHaveLength(1);
    expect(evts[0]!.type).toBe('discovery.cluster.scanned');
    expect((evts[0]!.payload as { partial: boolean }).partial).toBe(true);
  });

  it('terminal scans cannot transition again', () => {
    const scan = ClusterScan.open(clusterId, clock);
    scan.start(clock);
    scan.succeed(snapshotId, emptyCounters(), clock);
    expect(() =>
      scan.fail({ code: 'INTERNAL_ERROR', message: 'no' }, clock)
    ).toThrow(ValidationError);
    expect(() => scan.succeed(snapshotId, emptyCounters(), clock)).toThrow(
      ValidationError
    );
  });

  it('persistence round-trips', () => {
    const scan = ClusterScan.open(clusterId, clock);
    scan.start(clock);
    scan.succeed(snapshotId, emptyCounters(), clock);
    scan.drainEvents();
    const reloaded = ClusterScan.fromPersistence(scan.toPersistence());
    expect(reloaded.status).toBe('succeeded');
    expect(reloaded.snapshotId).toBe(snapshotId);
  });
});
