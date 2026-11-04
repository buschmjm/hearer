import { DECLINE_REASON_MAX, type RequestDto } from '@hearer/shared';
import { useId, useRef, useState, type SyntheticEvent } from 'react';
import { errorMessage } from '../api/client.ts';
import { useRequestAction } from '../api/requests.ts';
import { cx } from '../lib/cx.ts';
import { Dialog } from './Dialog.tsx';
import { useToast } from './Toast.tsx';
import { Alert, Button } from './ui.tsx';

/**
 * Decline a pending request. A reason is required (trimmed, at most 500 characters): the
 * requester sees it, so an empty or oversized one never reaches the server.
 */
export function DeclineDialog({
  request,
  onClose,
}: {
  /** The request being declined; null keeps the dialog closed. */
  request: RequestDto | null;
  onClose: () => void;
}) {
  const decline = useRequestAction('decline');
  const toast = useToast();
  const fieldId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);

  const close = () => {
    setReason('');
    setInvalid(null);
    decline.reset();
    onClose();
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!request) return;
    const trimmed = reason.trim();
    if (trimmed === '') {
      setInvalid('Give a reason so the requester knows why.');
      input.current?.focus();
      return;
    }
    if (trimmed.length > DECLINE_REASON_MAX) {
      setInvalid(`Keep the reason under ${String(DECLINE_REASON_MAX)} characters.`);
      input.current?.focus();
      return;
    }
    setInvalid(null);
    decline.mutate(
      { id: request.id, reason: trimmed },
      {
        onSuccess: () => {
          toast.push({ tone: 'success', title: 'Request declined', message: request.title });
          close();
        },
      },
    );
  };

  const remaining = DECLINE_REASON_MAX - reason.length;
  const describedBy = invalid ? `${fieldId}-err` : `${fieldId}-count`;

  return (
    <Dialog
      open={request !== null}
      title="Decline request"
      description={
        request ? `${request.title} will be declined. The requester sees your reason.` : ''
      }
      onClose={close}
      initialFocus={input}
      busy={decline.isPending}
    >
      <form onSubmit={submit} noValidate>
        <label htmlFor={fieldId} className="mb-1.5 block text-sm font-medium">
          Reason
        </label>
        <textarea
          ref={input}
          id={fieldId}
          value={reason}
          maxLength={DECLINE_REASON_MAX}
          rows={4}
          required
          aria-required="true"
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            setReason(event.target.value);
            if (invalid) setInvalid(null);
          }}
          className={cx(
            'block w-full resize-y rounded-lg border bg-surface-2 px-3 py-2 text-base text-fg placeholder:text-muted/70 sm:text-sm',
            invalid ? 'border-danger' : 'border-line hover:border-muted/60',
          )}
          placeholder="For example: already in another library, or not available in a lossless format"
        />
        <div className="mt-1.5 flex items-start justify-between gap-3">
          {invalid ? (
            <p id={`${fieldId}-err`} role="alert" className="text-xs text-danger">
              {invalid}
            </p>
          ) : (
            <span />
          )}
          <p
            id={`${fieldId}-count`}
            className={cx('text-xs tabular-nums', remaining < 50 ? 'text-warn' : 'text-muted')}
          >
            {remaining} characters left
          </p>
        </div>
        {decline.isError && <Alert className="mt-3">{errorMessage(decline.error)}</Alert>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={close} disabled={decline.isPending}>
            Keep pending
          </Button>
          <Button type="submit" variant="danger" loading={decline.isPending}>
            Decline request
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
