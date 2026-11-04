import type { AddressInfo } from 'node:net';
import { Permission, type RequestDto } from '@hearer/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addUser, completeSetup, createHarness, login, type Harness } from './helpers/auth.ts';
import { ALBUM, FakeMetadata } from './helpers/requests.ts';

/**
 * Over a real socket, Node emits `close` on the IncomingMessage as soon as its body is read.
 * That must not be mistaken for a disconnect: upstream metadata lookups still need their signal.
 */
class SlowMetadata extends FakeMetadata {
  aborted: boolean[] = [];
  override async getReleaseGroup(mbid: string, options?: { signal?: AbortSignal }) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    this.aborted.push(options?.signal?.aborted ?? false);
    return super.getReleaseGroup(mbid);
  }
}

let h: Harness;
let meta: SlowMetadata;
let base: string;

beforeEach(async () => {
  meta = new SlowMetadata();
  h = await createHarness({ deps: { metadata: meta.asProvider() } });
  await completeSetup(h);
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${String((h.app.server.address() as AddressInfo).port)}`;
});
afterEach(async () => {
  await h.cleanup();
});

describe('request creation over real HTTP', () => {
  it('does not abort the metadata lookup when the request body has been read', async () => {
    await addUser(h.app, 'alice', Permission.REQUEST_ALBUM);
    const alice = await login(h.app, 'alice');
    const res = await fetch(`${base}/api/v1/requests`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: alice.cookie,
        'x-csrf-token': alice.csrf,
      },
      body: JSON.stringify({ type: 'album', mbid: ALBUM }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(((await res.json()) as RequestDto).title).toBe('OK Computer');
    expect(meta.aborted.length).toBeGreaterThan(0);
    expect(meta.aborted.every((aborted) => !aborted)).toBe(true);
  });

  it('does abort the lookup when the client disconnects mid-flight', async () => {
    await addUser(h.app, 'bob', Permission.REQUEST_ALBUM);
    const bob = await login(h.app, 'bob');
    const controller = new AbortController();
    const pending = fetch(`${base}/api/v1/requests`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: bob.cookie,
        'x-csrf-token': bob.csrf,
      },
      body: JSON.stringify({ type: 'album', mbid: ALBUM }),
      signal: controller.signal,
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(meta.aborted.length).toBeGreaterThan(0);
    expect(meta.aborted.every(Boolean)).toBe(true);
  });
});
