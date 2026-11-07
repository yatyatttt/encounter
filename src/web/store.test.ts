import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiFailure } from './api';
import { useStore } from './store';
import { newEncounter, toSnapshot } from '../domain/encounter';
import type { CommandResponse, EncounterSnapshot } from '../shared/contract';

vi.mock('./api', async (original) => ({
  ...await original<typeof import('./api')>(),
  api: { encounter: vi.fn(), command: vi.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const snapshot = (name: string) => toSnapshot(newEncounter(name, { now: 1, newId: () => crypto.randomUUID() }));
const load = vi.mocked(api.encounter);
const command = vi.mocked(api.command);

beforeEach(() => {
  vi.resetAllMocks();
  useStore.setState(useStore.getInitialState(), true);
});

describe('encounter request ownership', () => {
  it.each(['success', 'failure'] as const)('ignores an older open %s after navigating', async (outcome) => {
    const a = snapshot('A'), b = snapshot('B');
    const pending = deferred<EncounterSnapshot>();
    load.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(b);
    const opening = useStore.getState().open(a.id);
    await useStore.getState().open(b.id);
    if (outcome === 'success') pending.resolve(a);
    else pending.reject(new Error('A unavailable'));
    await opening;
    expect(useStore.getState()).toMatchObject({ snapshot: b, loadError: null });
  });

  it.each(['success', 'failure', 'conflict'] as const)('ignores a stale save %s even after returning to the same encounter', async (outcome) => {
    const a = snapshot('A'), b = snapshot('B');
    load.mockResolvedValueOnce(a).mockResolvedValueOnce(b).mockResolvedValueOnce(a);
    await useStore.getState().open(a.id);
    const pending = deferred<CommandResponse>();
    command.mockReturnValueOnce(pending.promise);
    const saving = useStore.getState().send({ type: 'UPDATE_METADATA', name: 'Old A edit' });
    await useStore.getState().open(b.id);
    await useStore.getState().open(a.id);
    if (outcome === 'success') pending.resolve({ snapshot: { ...a, name: 'Old A edit', version: 2 }, affectedIds: [] });
    else pending.reject(new ApiFailure(outcome === 'conflict' ? 'VERSION_CONFLICT' : 'NETWORK', 'Old failure'));
    expect(await saving).toBe(false);
    expect(useStore.getState()).toMatchObject({ snapshot: a, save: 'saved', failed: null, notice: null, error: null });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('does not offer a retry from A while B is open', async () => {
    const a = snapshot('A'), b = snapshot('B');
    load.mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    await useStore.getState().open(a.id);
    const pending = deferred<CommandResponse>();
    command.mockReturnValueOnce(pending.promise);
    const saving = useStore.getState().send({ type: 'UPDATE_METADATA', name: 'A edit' });
    await useStore.getState().open(b.id);
    pending.reject(new ApiFailure('NETWORK', 'Delayed failure'));
    await saving;
    expect(await useStore.getState().retry()).toBe(false);
    expect(command).toHaveBeenCalledTimes(1);
    expect(useStore.getState()).toMatchObject({ snapshot: b, save: 'saved', failed: null });
  });

  it('ignores a conflict refetch that finishes after navigation', async () => {
    const a = snapshot('A'), b = snapshot('B');
    const refresh = deferred<EncounterSnapshot>();
    load.mockResolvedValueOnce(a).mockReturnValueOnce(refresh.promise).mockResolvedValueOnce(b);
    await useStore.getState().open(a.id);
    command.mockRejectedValueOnce(new ApiFailure('VERSION_CONFLICT', 'Changed'));
    const saving = useStore.getState().send({ type: 'UPDATE_METADATA', name: 'A edit' });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await useStore.getState().open(b.id);
    refresh.resolve({ ...a, version: 2 });
    await saving;
    expect(useStore.getState()).toMatchObject({ snapshot: b, notice: null });
  });

  it('retries the original envelope and preserves drafts on failure', async () => {
    const a = snapshot('A');
    load.mockResolvedValueOnce(a);
    await useStore.getState().open(a.id);
    useStore.getState().setDraft('meta:name', 'A edit');
    command.mockRejectedValueOnce(new ApiFailure('NETWORK', 'Offline')).mockResolvedValueOnce({ snapshot: { ...a, name: 'A edit', version: 2 }, affectedIds: [] });
    const edit = { type: 'UPDATE_METADATA', name: 'A edit' } as const;
    expect(await useStore.getState().send(edit)).toBe(false);
    expect(useStore.getState().drafts).toEqual({ 'meta:name': 'A edit' });
    expect(await useStore.getState().retry()).toBe(true);
    expect(command.mock.calls).toEqual([[a.id, { expectedVersion: 1, command: edit }], [a.id, { expectedVersion: 1, command: edit }]]);
    expect(useStore.getState()).toMatchObject({ save: 'saved', failed: null });
  });

  it('does not let a delayed focus refetch roll back an acknowledged save', async () => {
    const a = snapshot('A');
    const refresh = deferred<EncounterSnapshot>();
    load.mockResolvedValueOnce(a).mockReturnValueOnce(refresh.promise);
    await useStore.getState().open(a.id);
    const refetching = useStore.getState().refetch();
    command.mockResolvedValueOnce({ snapshot: { ...a, version: 2 }, affectedIds: [] });
    await useStore.getState().send({ type: 'UPDATE_METADATA', name: 'A edit' });
    refresh.resolve(a);
    await refetching;
    expect(useStore.getState().snapshot?.version).toBe(2);
  });
});
