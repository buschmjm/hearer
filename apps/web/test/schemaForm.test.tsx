import { Permission, REDACTED_SECRET } from '@hearer/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PermissionEditor } from '../src/components/PermissionEditor.tsx';
import { SchemaForm } from '../src/components/SchemaForm.tsx';
import {
  asSchema,
  fieldKind,
  humanize,
  normalizeConfig,
  schemaDefaults,
  validateAgainstSchema,
} from '../src/lib/schemaForm.ts';

const SCHEMA = asSchema({
  type: 'object',
  required: ['url'],
  properties: {
    url: { type: 'string', format: 'uri', description: 'Where to send it.' },
    optionalUrl: {
      default: '',
      anyOf: [
        { type: 'string', const: '' },
        { type: 'string', format: 'uri' },
      ],
    },
    token: { type: 'string', 'x-secret': true, default: '' },
    timeoutSeconds: { type: 'integer', minimum: 1, maximum: 60, default: 10 },
    secure: { type: 'boolean', default: false },
    policy: { type: 'string', enum: ['album', 'skip'], default: 'album' },
    tags: { type: 'array', items: { type: 'string' }, default: [] },
    headers: { type: 'object', additionalProperties: { type: 'string' }, default: {} },
    kinds: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
  },
});

function Harness({
  initial,
  saved,
  onValue,
}: {
  initial: Record<string, unknown>;
  saved?: Record<string, unknown>;
  onValue: (v: Record<string, unknown>) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SchemaForm
      schema={SCHEMA}
      value={value}
      {...(saved ? { saved } : {})}
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
    />
  );
}

describe('schema helpers', () => {
  it('classifies field kinds', () => {
    const kinds = Object.fromEntries(
      Object.entries(SCHEMA.properties ?? {}).map(([k, v]) => [k, fieldKind(v)]),
    );
    expect(kinds).toEqual({
      url: 'url',
      optionalUrl: 'url',
      token: 'secret',
      timeoutSeconds: 'number',
      secure: 'boolean',
      policy: 'enum',
      tags: 'list',
      headers: 'map',
      kinds: 'multiEnum',
    });
  });

  it('humanizes property names and reads defaults', () => {
    expect(humanize('webhookUrl')).toBe('Webhook URL');
    expect(humanize('qualityProfileId')).toBe('Quality profile ID');
    expect(schemaDefaults(SCHEMA)).toMatchObject({
      timeoutSeconds: 10,
      policy: 'album',
      secure: false,
    });
  });

  it('validates required, url, range and integer constraints', () => {
    expect(validateAgainstSchema(SCHEMA, {})).toEqual({ url: 'This field is required.' });
    expect(validateAgainstSchema(SCHEMA, { url: 'nope' }).url).toMatch(/full URL/);
    expect(
      validateAgainstSchema(SCHEMA, { url: 'https://x.test', timeoutSeconds: 0 }).timeoutSeconds,
    ).toMatch(/at least 1/);
    expect(
      validateAgainstSchema(SCHEMA, { url: 'https://x.test', timeoutSeconds: 61 }).timeoutSeconds,
    ).toMatch(/at most 60/);
    expect(
      validateAgainstSchema(SCHEMA, { url: 'https://x.test', timeoutSeconds: 1.5 }).timeoutSeconds,
    ).toMatch(/whole/);
    expect(
      validateAgainstSchema(SCHEMA, {
        url: 'https://x.test',
        optionalUrl: '',
        token: REDACTED_SECRET,
      }),
    ).toEqual({});
  });

  it('normalizes blank numbers, list lines and unnamed headers', () => {
    expect(
      normalizeConfig(SCHEMA, {
        url: 'https://x.test',
        timeoutSeconds: '',
        tags: [' a ', '', 'b'],
        headers: { X: '1', '': '' },
      }),
    ).toEqual({ url: 'https://x.test', tags: ['a', 'b'], headers: { X: '1' } });
  });
});

describe('SchemaForm', () => {
  it('renders every field type and reports edits', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(
      <Harness
        initial={{
          url: '',
          timeoutSeconds: 10,
          secure: false,
          policy: 'album',
          tags: [],
          headers: {},
        }}
        onValue={onValue}
      />,
    );

    await user.type(screen.getByLabelText(/^URL/), 'https://hook.test');
    await user.clear(screen.getByLabelText('Timeout seconds'));
    await user.type(screen.getByLabelText('Timeout seconds'), '30');
    await user.click(screen.getByRole('switch', { name: /secure/i }));
    await user.selectOptions(screen.getByLabelText('Policy'), 'skip');
    await user.type(screen.getByLabelText('Tags'), 'one{enter}two');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.type(screen.getByLabelText('Headers name 1'), 'X-Id');
    await user.type(screen.getByLabelText('Headers value 1'), '7');
    await user.click(screen.getByRole('checkbox', { name: 'b' }));

    expect(onValue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: 'https://hook.test',
        timeoutSeconds: 30,
        secure: true,
        policy: 'skip',
        tags: ['one', 'two'],
        headers: { 'X-Id': '7' },
        kinds: ['b'],
      }),
    );
  });

  it('keeps a masked secret untouched unless the user replaces or removes it', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    const saved = { url: 'https://x.test', token: REDACTED_SECRET };
    render(<Harness initial={saved} saved={saved} onValue={onValue} />);

    // Locked while masked: no input to type into, and nothing was emitted.
    expect(screen.queryByLabelText('Token')).toBeNull();
    expect(screen.getByLabelText('Token (saved)')).toBeInTheDocument();
    expect(onValue).not.toHaveBeenCalled();

    // Editing another field still echoes the mask back, never a real value.
    await user.type(screen.getByLabelText(/^URL/), '/path');
    expect(onValue).toHaveBeenLastCalledWith(expect.objectContaining({ token: REDACTED_SECRET }));

    // Replace -> empty input -> type a new value.
    await user.click(screen.getByRole('button', { name: 'Replace Token' }));
    expect(onValue).toHaveBeenLastCalledWith(expect.objectContaining({ token: '' }));
    expect(screen.getByText('The saved value will be removed when you save.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Token'), 's3cret');
    expect(onValue).toHaveBeenLastCalledWith(expect.objectContaining({ token: 's3cret' }));
    expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');

    // Changed their mind: restore the mask.
    await user.click(screen.getByRole('button', { name: 'Keep the saved value' }));
    expect(onValue).toHaveBeenLastCalledWith(expect.objectContaining({ token: REDACTED_SECRET }));
    expect(screen.getByLabelText('Token (saved)')).toBeInTheDocument();
  });

  it('shows field errors and honours hide', () => {
    render(
      <SchemaForm
        schema={SCHEMA}
        value={{}}
        errors={{ url: 'Bad URL' }}
        hide={['token']}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Bad URL');
    expect(screen.queryByText('Token')).toBeNull();
  });
});

describe('PermissionEditor', () => {
  const grantable = Permission.REQUEST | Permission.UPLOAD | Permission.MANAGE_USERS;

  it('disables bits the actor cannot grant and still toggles the rest', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PermissionEditor value={Permission.REQUEST} canGrant={grantable} onChange={onChange} />,
    );

    expect(screen.getByRole('checkbox', { name: /Manage settings/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /^Administrator/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Auto-approve requests/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Request songs/ })).toBeEnabled();

    await user.click(screen.getByRole('checkbox', { name: /Upload music/ }));
    expect(onChange).toHaveBeenCalledWith(Permission.REQUEST | Permission.UPLOAD);
    await user.click(screen.getByRole('checkbox', { name: /Request songs/ }));
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it('lets an administrator grant everything, and ADMIN implies the rest', () => {
    render(<PermissionEditor value={Permission.ADMIN} onChange={() => undefined} />);
    expect(screen.getByRole('checkbox', { name: /^Administrator/ })).toBeEnabled();
    const implied = screen.getByRole('checkbox', { name: /Manage users/ });
    expect(implied).toBeChecked();
    expect(implied).toBeDisabled();
  });

  it('can hide management bits for defaults', () => {
    render(<PermissionEditor value={0} groups="basic" onChange={() => undefined} />);
    expect(screen.queryByRole('checkbox', { name: /Manage users/ })).toBeNull();
    expect(screen.getByRole('checkbox', { name: /Request albums/ })).toBeInTheDocument();
  });

  it('disables everything when read-only', () => {
    render(<PermissionEditor value={0} disabled onChange={() => undefined} />);
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
  });
});
