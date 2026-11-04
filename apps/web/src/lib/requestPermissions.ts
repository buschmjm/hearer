import { Permission, type RequestDto } from '@hearer/shared';
import { useAuth } from '../api/auth.ts';
import { CANCELLABLE_STATUSES } from './format.ts';

/** What the signed-in user may do to a request (mirrors the server's rules). */
export function useRequestPermissions(request: RequestDto) {
  const { user, hasPermission } = useAuth();
  const canManage = hasPermission(Permission.MANAGE_REQUESTS);
  const isOwner = user !== null && request.requestedBy?.id === user.id;
  return {
    approve: canManage && request.status === 'PENDING',
    decline: canManage && request.status === 'PENDING',
    retry: canManage && request.status === 'FAILED',
    cancel: (isOwner || canManage) && CANCELLABLE_STATUSES.includes(request.status),
  };
}
