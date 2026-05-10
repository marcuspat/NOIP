// Unit tests for the condition evaluator registry.
//
// Coverage: every registered evaluator's allow + deny path, plus the
// closed-registry guarantee (unknown name → deny).

import {
  evaluateConditions,
  listConditionEvaluators,
} from '../../../src/services/iam/condition-evaluator';

describe('evaluateConditions: registry surface', () => {
  it('exposes the four ADR-0008 evaluators', () => {
    expect(listConditionEvaluators().sort()).toEqual([
      'duringHours',
      'inIpRange',
      'ownerOf',
      'sameTenantAs',
    ]);
  });

  it('denies with unknown-condition for an unregistered name', () => {
    const decision = evaluateConditions({ 'magic(foo)': true }, {});
    expect(decision).toEqual({ kind: 'deny', reason: 'unknown-condition' });
  });

  it('denies with unknown-condition for a malformed key', () => {
    // `parseKey` rejects non-identifier names.
    const decision = evaluateConditions({ '!!@(arg)': true }, {});
    expect(decision).toEqual({ kind: 'deny', reason: 'unknown-condition' });
  });

  it('allows when no conditions are present', () => {
    expect(evaluateConditions({}, {})).toEqual({ kind: 'allow' });
  });
});

describe('evaluateConditions: sameTenantAs', () => {
  it('allows when the field equals user.tenantId', () => {
    const result = evaluateConditions(
      { 'sameTenantAs(tenantId)': true },
      {
        user: { _id: 'u-1', tenantId: 't-acme' },
        params: { tenantId: 't-acme' },
      }
    );
    expect(result).toEqual({ kind: 'allow' });
  });

  it('denies with tenant-mismatch when values differ', () => {
    const result = evaluateConditions(
      { 'sameTenantAs(tenantId)': true },
      {
        user: { _id: 'u-1', tenantId: 't-acme' },
        params: { tenantId: 't-other' },
      }
    );
    expect(result).toEqual({ kind: 'deny', reason: 'tenant-mismatch' });
  });

  it('denies when the user has no tenantId', () => {
    const result = evaluateConditions(
      { 'sameTenantAs(tenantId)': true },
      { user: { _id: 'u-1' }, params: { tenantId: 't-x' } }
    );
    expect(result).toEqual({ kind: 'deny', reason: 'no-user-tenant' });
  });

  it('denies when the request field is missing', () => {
    const result = evaluateConditions(
      { 'sameTenantAs(tenantId)': true },
      { user: { _id: 'u-1', tenantId: 't-acme' } }
    );
    expect(result).toEqual({ kind: 'deny', reason: 'tenant-field-missing' });
  });
});

describe('evaluateConditions: ownerOf', () => {
  it('allows when params.id matches user._id (string form)', () => {
    const result = evaluateConditions(
      { 'ownerOf(id)': true },
      { user: { _id: 'u-1' }, params: { id: 'u-1' } }
    );
    expect(result).toEqual({ kind: 'allow' });
  });

  it('allows when the field is an object with userId', () => {
    const result = evaluateConditions(
      { 'ownerOf(resource)': true },
      {
        user: { _id: 'u-1' },
        body: { resource: { userId: 'u-1', name: 'thing' } },
      }
    );
    expect(result).toEqual({ kind: 'allow' });
  });

  it('denies with not-owner when ids differ', () => {
    const result = evaluateConditions(
      { 'ownerOf(id)': true },
      { user: { _id: 'u-1' }, params: { id: 'u-2' } }
    );
    expect(result).toEqual({ kind: 'deny', reason: 'not-owner' });
  });

  it('denies when the field is missing', () => {
    const result = evaluateConditions(
      { 'ownerOf(id)': true },
      { user: { _id: 'u-1' } }
    );
    expect(result).toEqual({ kind: 'deny', reason: 'owner-field-missing' });
  });

  it('denies when no user id is present in context', () => {
    const result = evaluateConditions(
      { 'ownerOf(id)': true },
      { params: { id: 'u-1' } }
    );
    expect(result).toEqual({ kind: 'deny', reason: 'no-user-id' });
  });
});

describe('evaluateConditions: inIpRange', () => {
  it('allows for an IP inside the CIDR', () => {
    const result = evaluateConditions(
      { 'inIpRange(10.0.0.0/8)': true },
      { ip: '10.20.30.40' }
    );
    expect(result).toEqual({ kind: 'allow' });
  });

  it('denies for an IP outside the CIDR', () => {
    const result = evaluateConditions(
      { 'inIpRange(10.0.0.0/8)': true },
      { ip: '11.0.0.1' }
    );
    expect(result).toEqual({ kind: 'deny', reason: 'ip-out-of-range' });
  });

  it('handles a /32 single-host CIDR', () => {
    expect(
      evaluateConditions(
        { 'inIpRange(192.168.1.5/32)': true },
        { ip: '192.168.1.5' }
      )
    ).toEqual({ kind: 'allow' });
    expect(
      evaluateConditions(
        { 'inIpRange(192.168.1.5/32)': true },
        { ip: '192.168.1.6' }
      )
    ).toEqual({ kind: 'deny', reason: 'ip-out-of-range' });
  });

  it('strips IPv4-mapped IPv6 prefix', () => {
    expect(
      evaluateConditions(
        { 'inIpRange(10.0.0.0/8)': true },
        { ip: '::ffff:10.0.0.5' }
      )
    ).toEqual({ kind: 'allow' });
  });

  it('denies a real IPv6 address with not-ipv4', () => {
    expect(
      evaluateConditions(
        { 'inIpRange(10.0.0.0/8)': true },
        { ip: '2001:db8::1' }
      )
    ).toEqual({ kind: 'deny', reason: 'not-ipv4' });
  });

  it('denies with no-ip when the request has no ip', () => {
    expect(evaluateConditions({ 'inIpRange(10.0.0.0/8)': true }, {})).toEqual({
      kind: 'deny',
      reason: 'no-ip',
    });
  });

  it('denies with invalid-cidr on malformed CIDR', () => {
    expect(
      evaluateConditions({ 'inIpRange(not-a-cidr)': true }, { ip: '10.0.0.1' })
    ).toEqual({ kind: 'deny', reason: 'invalid-cidr' });
  });
});

describe('evaluateConditions: duringHours', () => {
  it('allows inside the window', () => {
    const result = evaluateConditions(
      { duringHours: { start: '09:00', end: '17:00', tz: 'UTC' } },
      { now: new Date('2026-05-10T12:00:00Z') }
    );
    expect(result).toEqual({ kind: 'allow' });
  });

  it('denies outside the window with outside-hours', () => {
    const result = evaluateConditions(
      { duringHours: { start: '09:00', end: '17:00', tz: 'UTC' } },
      { now: new Date('2026-05-10T18:30:00Z') }
    );
    expect(result).toEqual({ kind: 'deny', reason: 'outside-hours' });
  });

  it('handles a midnight-straddling window', () => {
    // Window 22:00 → 02:00 UTC. 23:30 is inside; 03:00 is outside.
    expect(
      evaluateConditions(
        { duringHours: { start: '22:00', end: '02:00', tz: 'UTC' } },
        { now: new Date('2026-05-10T23:30:00Z') }
      )
    ).toEqual({ kind: 'allow' });
    expect(
      evaluateConditions(
        { duringHours: { start: '22:00', end: '02:00', tz: 'UTC' } },
        { now: new Date('2026-05-10T03:00:00Z') }
      )
    ).toEqual({ kind: 'deny', reason: 'outside-hours' });
  });

  it('denies when payload args are missing', () => {
    expect(evaluateConditions({ duringHours: { start: '09:00' } }, {})).toEqual(
      { kind: 'deny', reason: 'duringHours-args-missing' }
    );
  });

  it('denies on an invalid timezone', () => {
    expect(
      evaluateConditions(
        { duringHours: { start: '09:00', end: '17:00', tz: 'Mars/Phobos' } },
        { now: new Date('2026-05-10T12:00:00Z') }
      )
    ).toEqual({ kind: 'deny', reason: 'duringHours-tz-invalid' });
  });
});

describe('evaluateConditions: aggregation', () => {
  it('short-circuits on the first deny', () => {
    const result = evaluateConditions(
      {
        'sameTenantAs(tenantId)': true,
        'ownerOf(id)': true,
      },
      {
        user: { _id: 'u-1', tenantId: 't-acme' },
        params: { tenantId: 't-other', id: 'u-1' },
      }
    );
    expect(result).toEqual({ kind: 'deny', reason: 'tenant-mismatch' });
  });

  it('allows only when every predicate allows', () => {
    const result = evaluateConditions(
      {
        'sameTenantAs(tenantId)': true,
        'ownerOf(id)': true,
      },
      {
        user: { _id: 'u-1', tenantId: 't-acme' },
        params: { tenantId: 't-acme', id: 'u-1' },
      }
    );
    expect(result).toEqual({ kind: 'allow' });
  });
});
