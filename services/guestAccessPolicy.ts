import { Tab, UserRole, type User } from '../types';

/** The complete primary navigation shown to a guest contributor. */
export const GUEST_PRIMARY_TABS: readonly Tab[] = [
  Tab.UPLOAD,
  Tab.BUILDER,
  Tab.AI_SQL,
  Tab.DASHBOARD,
];

/**
 * Internal child screens required by one of the four primary workflows. They
 * remain reachable from their parent but are never shown as sidebar tabs.
 */
const GUEST_WORKFLOW_TABS: readonly Tab[] = [
  Tab.COLUMN_MAPPING,
  Tab.VISUAL_PREVIEW,
  Tab.LEGAL,
];

export function isGuestUser(user: Pick<User, 'id'> | null | undefined): boolean {
  return Boolean(user?.id?.startsWith('guest_'));
}

export function createGuestContributor(createdAt = Date.now()): User {
  return {
    id: `guest_${createdAt.toString(36)}`,
    email: 'guest@quickinsight.app',
    name: 'Guest User',
    role: UserRole.CONTRIBUTOR,
    passwordHash: '',
    createdAt,
    avatar: '#94a3b8',
  };
}

export function isGuestPrimaryTab(tab: Tab): boolean {
  return GUEST_PRIMARY_TABS.includes(tab);
}

export function canGuestNavigateToTab(tab: Tab): boolean {
  return isGuestPrimaryTab(tab) || GUEST_WORKFLOW_TABS.includes(tab);
}
