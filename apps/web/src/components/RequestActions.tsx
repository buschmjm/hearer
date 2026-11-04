import type { RequestDto } from '@hearer/shared';
import { Check, RotateCcw, X, XCircle } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../api/client.ts';
import { cx } from '../lib/cx.ts';
import { useRequestAction } from '../api/requests.ts';
import { useRequestPermissions } from '../lib/requestPermissions.ts';
import { DeclineDialog } from './DeclineDialog.tsx';
import { Dialog } from './Dialog.tsx';
import { useToast } from './Toast.tsx';
import { Button } from './ui.tsx';

/**
 * The buttons a person may use on a request: Approve / Decline (managers, pending), Retry
 * (managers, failed) and Cancel (the owner or a manager, while it can still be cancelled).
 * Decline opens a reason dialog, Cancel asks to confirm.
 */
export function RequestActions({
  request,
  compact = false,
}: {
  request: RequestDto;
  compact?: boolean;
}) {
  const can = useRequestPermissions(request);
  const toast = useToast();
  const approve = useRequestAction('approve');
  const retry = useRequestAction('retry');
  const cancel = useRequestAction('cancel');
  const [declining, setDeclining] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  if (!can.approve && !can.decline && !can.retry && !can.cancel) return null;

  const size = compact ? 'min-h-8 px-2.5 text-xs' : '';
  const fail = (title: string) => (err: Error) => {
    toast.push({ tone: 'error', title, message: errorMessage(err) });
  };

  return (
    <div className={cx('flex items-center gap-1.5', !compact && 'flex-wrap')}>
      {can.approve && (
        <Button
          className={size}
          aria-label={`Approve ${request.title}`}
          loading={approve.isPending}
          onClick={() => {
            approve.mutate(
              { id: request.id },
              {
                onSuccess: () => {
                  toast.push({
                    tone: 'success',
                    title: 'Request approved',
                    message: request.title,
                  });
                },
                onError: fail('Could not approve'),
              },
            );
          }}
        >
          <Check className="size-3.5" aria-hidden /> Approve
        </Button>
      )}
      {can.decline && (
        <Button
          variant="secondary"
          className={size}
          aria-label={`Decline ${request.title}`}
          onClick={() => {
            setDeclining(true);
          }}
        >
          <XCircle className="size-3.5" aria-hidden /> Decline
        </Button>
      )}
      {can.retry && (
        <Button
          className={size}
          aria-label={`Retry ${request.title}`}
          loading={retry.isPending}
          onClick={() => {
            retry.mutate(
              { id: request.id },
              {
                onSuccess: () => {
                  toast.push({
                    tone: 'success',
                    title: 'Retrying request',
                    message: request.title,
                  });
                },
                onError: fail('Could not retry'),
              },
            );
          }}
        >
          <RotateCcw className="size-3.5" aria-hidden /> Retry
        </Button>
      )}
      {can.cancel && (
        <Button
          variant="ghost"
          className={size}
          aria-label={`Cancel ${request.title}`}
          title="Cancel request"
          onClick={() => {
            setConfirmingCancel(true);
          }}
        >
          <X className="size-3.5" aria-hidden />
          <span className={compact ? 'md:sr-only' : undefined}>Cancel</span>
        </Button>
      )}

      <DeclineDialog
        request={declining ? request : null}
        onClose={() => {
          setDeclining(false);
        }}
      />
      <Dialog
        open={confirmingCancel}
        title="Cancel this request?"
        description={`${request.title} will be withdrawn. This cannot be undone.`}
        busy={cancel.isPending}
        onClose={() => {
          setConfirmingCancel(false);
        }}
      >
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            disabled={cancel.isPending}
            onClick={() => {
              setConfirmingCancel(false);
            }}
          >
            Keep request
          </Button>
          <Button
            variant="danger"
            loading={cancel.isPending}
            onClick={() => {
              cancel.mutate(
                { id: request.id },
                {
                  onSuccess: () => {
                    toast.push({
                      tone: 'info',
                      title: 'Request cancelled',
                      message: request.title,
                    });
                  },
                  onError: fail('Could not cancel'),
                  onSettled: () => {
                    setConfirmingCancel(false);
                  },
                },
              );
            }}
          >
            Cancel request
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
