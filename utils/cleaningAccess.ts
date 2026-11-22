/**
 * cleaningAccess.ts — who may use the Cleaning workspace.
 *
 * Cleaning (checklist, your steps, saved setups, handover pages) is for admins
 * only. Contributors, viewers and guests (who are contributors) never see it;
 * their files are still cleaned automatically on upload. The server enforces
 * the same rule on the saved-setup routes.
 */
import { UserRole } from '../types';

export const canUseCleaning = (user: { role?: UserRole | string } | null | undefined): boolean => String(user?.role || '').toUpperCase() === UserRole.ADMIN;
