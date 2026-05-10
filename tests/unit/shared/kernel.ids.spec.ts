import {
  newId,
  parseId,
  tryParseId,
  type UserId,
  type RoleId,
  type EventId,
} from '../../../src/shared/kernel/ids';

describe('shared/kernel/ids', () => {
  describe('newId', () => {
    it('produces RFC4122-shaped UUIDs', () => {
      const id = newId<UserId>();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('produces unique values across many calls', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        seen.add(newId<EventId>());
      }
      expect(seen.size).toBe(1000);
    });
  });

  describe('parseId', () => {
    it('round-trips a freshly minted id', () => {
      const id = newId<UserId>();
      const parsed = parseId<UserId>(id);
      expect(parsed).toBe(id);
    });

    it('rejects non-UUID strings', () => {
      expect(() => parseId<UserId>('not-a-uuid')).toThrow(/Invalid id/);
      expect(() => parseId<UserId>('')).toThrow(/Invalid id/);
      expect(() => parseId<UserId>('1234')).toThrow(/Invalid id/);
    });

    it('rejects malformed UUIDs (wrong segment lengths)', () => {
      expect(
        () => parseId<UserId>('00000000-0000-4000-8000-00000000000') // 11-char tail
      ).toThrow(/Invalid id/);
    });

    it('rejects UUIDs with invalid version nibble', () => {
      // Version 0 is not a valid UUID version.
      expect(() =>
        parseId<UserId>('00000000-0000-0000-8000-000000000000')
      ).toThrow(/Invalid id/);
    });

    it('rejects non-string inputs gracefully', () => {
      expect(() => parseId<UserId>(123 as unknown as string)).toThrow(
        /Invalid id/
      );
    });
  });

  describe('tryParseId', () => {
    it('returns the id on valid input', () => {
      const id = newId<UserId>();
      expect(tryParseId<UserId>(id)).toBe(id);
    });

    it('returns null on invalid input', () => {
      expect(tryParseId<UserId>('garbage')).toBeNull();
      expect(tryParseId<UserId>('')).toBeNull();
    });
  });

  describe('branded type behaviour', () => {
    // Compile-time invariance: a function that demands a `UserId` cannot be
    // passed a `RoleId` even though both erase to `string`. This is checked
    // by the type system; the runtime body is a smoke test that the values
    // are still plain strings under the hood.
    it('brands erase to plain strings at runtime', () => {
      const userId = newId<UserId>();
      const roleId = newId<RoleId>();
      const requireUserId = (u: UserId): string => u;

      // @ts-expect-error - RoleId is not assignable to UserId
      requireUserId(roleId);

      expect(typeof userId).toBe('string');
      expect(typeof roleId).toBe('string');
      expect(requireUserId(userId)).toBe(userId);
    });
  });
});
