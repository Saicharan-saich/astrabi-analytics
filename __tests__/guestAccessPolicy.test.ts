import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Tab, UserRole, type User } from '../types';
import {
  GUEST_PRIMARY_TABS,
  canGuestNavigateToTab,
  createGuestContributor,
  isGuestPrimaryTab,
  isGuestUser,
} from '../services/guestAccessPolicy';
import { checkAiSqlLimit, recordAiSqlUsage } from '../services/aiSqlRateLimiter';

const guest = (): User => ({
  id: 'guest_test',
  email: 'guest@quickinsight.app',
  name: 'Guest User',
  role: UserRole.CONTRIBUTOR,
  passwordHash: '',
  createdAt: 1,
});

describe('guest contributor access', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
  });

  it('shows exactly the four requested primary tabs', () => {
    expect(GUEST_PRIMARY_TABS).toEqual([
      Tab.UPLOAD,
      Tab.BUILDER,
      Tab.AI_SQL,
      Tab.DASHBOARD,
    ]);
    expect(Object.values(Tab).filter(isGuestPrimaryTab).sort()).toEqual([...GUEST_PRIMARY_TABS].sort());
  });

  it('allows only required child screens beyond the four primary tabs', () => {
    expect(canGuestNavigateToTab(Tab.COLUMN_MAPPING)).toBe(true);
    expect(canGuestNavigateToTab(Tab.VISUAL_PREVIEW)).toBe(true);
    expect(canGuestNavigateToTab(Tab.ALERTS)).toBe(false);
    expect(canGuestNavigateToTab(Tab.BENCHMARK)).toBe(false);
    expect(canGuestNavigateToTab(Tab.DATASET_SUMMARY)).toBe(false);
  });

  it('recognises only local guest identities as guests', () => {
    expect(isGuestUser(guest())).toBe(true);
    expect(isGuestUser({ id: 'registered-contributor' })).toBe(false);
  });

  it('creates guests with contributor capabilities', () => {
    const created = createGuestContributor(1234);
    expect(created.role).toBe(UserRole.CONTRIBUTOR);
    expect(created.id).toBe(`guest_${(1234).toString(36)}`);
  });

  it('allows ten AI SQL questions and blocks the eleventh across guest sessions', () => {
    const firstSession = guest();
    for (let request = 0; request < 10; request += 1) {
      expect(checkAiSqlLimit(firstSession).allowed).toBe(true);
      recordAiSqlUsage(firstSession);
    }

    const nextSession = { ...guest(), id: 'guest_next_session' };
    const status = checkAiSqlLimit(nextSession);
    expect(status).toMatchObject({ allowed: false, remaining: 0, limit: 10, used: 10, blocked: false });
  });
});
