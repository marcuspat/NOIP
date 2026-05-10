// SecurityPolicy aggregate invariants — versioning + events.

import { SecurityPolicy } from '../../../src/contexts/security/domain/security-policy';
import { FixedClock } from '../../../src/shared/kernel';
import { ValidationError } from '../../../src/shared/errors';

describe('SecurityPolicy aggregate', () => {
  const clock = new FixedClock(new Date('2026-05-10T00:00:00.000Z'));

  it('create() rejects empty name and emits security.policy.created', () => {
    expect(() =>
      SecurityPolicy.create(
        {
          name: '',
          type: 'k8s',
          config: {},
        },
        clock
      )
    ).toThrow(ValidationError);
    const p = SecurityPolicy.create(
      { name: 'k8s.privileged', type: 'k8s', config: {} },
      clock
    );
    const events = p.drainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('security.policy.created');
    expect(p.version).toBe(1);
  });

  it('update() bumps version, archives previous, emits updated', () => {
    const p = SecurityPolicy.create(
      { name: 'p', type: 'k8s', config: { description: 'orig' } },
      clock
    );
    p.drainEvents();
    p.update({ config: { description: 'changed' } }, clock);
    expect(p.version).toBe(2);
    const archived = p.drainArchivedVersions();
    expect(archived).toHaveLength(1);
    expect(archived[0]!.version).toBe(1);
    const events = p.drainEvents();
    expect(events.map(e => e.type)).toEqual(['security.policy.updated']);
  });

  it('disabling emits security.policy.disabled in addition to updated', () => {
    const p = SecurityPolicy.create(
      { name: 'p', type: 'k8s', config: {} },
      clock
    );
    p.drainEvents();
    p.update({ enabled: false }, clock);
    const events = p.drainEvents();
    expect(events.map(e => e.type)).toEqual([
      'security.policy.updated',
      'security.policy.disabled',
    ]);
    expect(p.enabled).toBe(false);
  });

  it('no-op update does not bump version', () => {
    const p = SecurityPolicy.create(
      { name: 'p', type: 'k8s', config: { description: 'x' }, priority: 50 },
      clock
    );
    p.drainEvents();
    p.update({ priority: 50 }, clock);
    expect(p.version).toBe(1);
    expect(p.drainArchivedVersions()).toHaveLength(0);
    expect(p.drainEvents()).toHaveLength(0);
  });

  it('persistence round-trips', () => {
    const p = SecurityPolicy.create(
      { name: 'p', type: 'secrets', config: { description: 'x' } },
      clock
    );
    const reloaded = SecurityPolicy.fromPersistence(p.toPersistence());
    expect(reloaded.id).toBe(p.id);
    expect(reloaded.type).toBe('secrets');
    expect(reloaded.version).toBe(1);
  });
});
