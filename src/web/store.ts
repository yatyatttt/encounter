// One store: the latest ACKNOWLEDGED encounter snapshot (the UI never invents state), selection,
// save status, and form drafts that must survive a failed save.
import { create } from 'zustand';
import { api, ApiFailure } from './api';
import { timingAnnouncement } from './timing';
import type { EncounterCommand, EncounterSnapshot, CommandEnvelope } from '../shared/contract';

export type SaveStatus = 'saved' | 'saving' | 'failed';

type Store = {
  snapshot: EncounterSnapshot | null;
  loadError: string | null;
  selectedId: string | null;
  save: SaveStatus;
  error: string | null;
  fieldErrors: Record<string, string[]> | null;
  notice: string | null; // e.g. version conflict
  announcement: string; // aria-live text
  failed: CommandEnvelope | null; // envelope to resend on RETRY
  drafts: Record<string, string>;
  open: (id: string) => Promise<void>;
  refetch: () => Promise<void>;
  send: (command: EncounterCommand) => Promise<boolean>;
  retry: () => Promise<boolean>;
  dismissError: () => void;
  select: (id: string | null) => void;
  setDraft: (key: string, value: string | null) => void;
  announce: (text: string) => void;
};

/** Screen-reader text for HP / temp HP changes between two snapshots. */
export function hpAnnouncement(before: EncounterSnapshot | null, after: EncounterSnapshot): string {
  if (!before || before.id !== after.id) return '';
  const old = new Map(before.combatants.map((c) => [c.id, c]));
  return after.combatants
    .filter((c) => { const o = old.get(c.id); return o && (o.currentHp !== c.currentHp || o.tempHp !== c.tempHp || o.maxHp !== c.maxHp); })
    .map((c) => `${c.name}: ${c.currentHp} of ${c.maxHp} HP, ${c.tempHp} temporary${c.currentHp === 0 ? ', zero HP' : ''}.`)
    .join(' ');
}

/** Announce pending saves and concentration changes even if damage changes no current HP. */
export function concentrationAnnouncement(before: EncounterSnapshot | null, after: EncounterSnapshot): string {
  if (!before || before.id !== after.id) return '';
  const name = (id: string) => after.combatants.find((c) => c.id === id)?.name ?? 'Combatant';
  const ended = before.concentrations.filter((c) => !after.concentrations.some((k) => k.id === c.id));
  const messages = ended.map((c) => `${name(c.combatantId)}: ${c.name} concentration ended; linked effects ended.`);
  for (const c of after.concentrations) {
    const old = before.concentrations.find((k) => k.id === c.id);
    if (!old) messages.push(`${name(c.combatantId)}: concentrating on ${c.name}.`);
    for (const check of c.checks.filter((k) => !old?.checks.some((o) => o.id === k.id))) messages.push(`${name(c.combatantId)}: ${check.damage} damage, DC ${check.dc} Constitution save pending.`);
    if (old?.checks.some((k) => !c.checks.some((o) => o.id === k.id))) messages.push(`${name(c.combatantId)}: concentration check succeeded.`);
  }
  return messages.join(' ');
}

export const useStore = create<Store>((set, get) => {
  const run = async (env: CommandEnvelope, retrying: boolean): Promise<boolean> => {
    const id = get().snapshot!.id;
    set({ save: 'saving', error: null, fieldErrors: null, notice: null, failed: retrying ? get().failed : null });
    try {
      const res = await api.command(id, env);
      if (get().snapshot?.id !== id) return true;
      set({ snapshot: res.snapshot, save: 'saved', failed: null, announcement: [hpAnnouncement(get().snapshot, res.snapshot), concentrationAnnouncement(get().snapshot, res.snapshot), timingAnnouncement(get().snapshot, res.snapshot)].filter(Boolean).join(' ') });
      return true;
    } catch (e) {
      const err = e instanceof ApiFailure ? e : new ApiFailure('NETWORK', String(e));
      if (err.code === 'VERSION_CONFLICT') {
        try { set({ snapshot: await api.encounter(id) }); } catch { /* the notice below still applies */ }
        set({
          save: 'saved', failed: null,
          notice: retrying
            ? 'The server already has a newer version — your last change may have been applied. Review the current state before repeating it.'
            : 'This encounter changed elsewhere (another tab?). It was reloaded — review it, then repeat your change. Your typed input was kept.',
        });
        return false;
      }
      set({
        save: 'failed', error: err.message, fieldErrors: err.fieldErrors ?? null, failed: env,
        announcement: `Save failed. ${err.message}`,
      });
      return false;
    }
  };

  return {
    snapshot: null, loadError: null, selectedId: null, save: 'saved', error: null, fieldErrors: null,
    notice: null, announcement: '', failed: null, drafts: {},

    open: async (id) => {
      if (get().snapshot?.id !== id) {
        set({ snapshot: null, selectedId: null, save: 'saved', error: null, fieldErrors: null, notice: null, failed: null, drafts: {} });
      }
      set({ loadError: null });
      try { set({ snapshot: await api.encounter(id) }); } catch (e) { set({ loadError: (e as Error).message }); }
    },

    refetch: async () => {
      const s = get();
      if (!s.snapshot || s.save !== 'saved') return; // never overwrite while saving / failed
      try {
        const next = await api.encounter(s.snapshot.id);
        if (get().save === 'saved' && get().snapshot?.id === next.id && next.version !== get().snapshot!.version) set({ snapshot: next });
      } catch { /* a transient focus refetch failure is not a save failure */ }
    },

    send: async (command) => {
      const s = get();
      if (!s.snapshot || s.save === 'saving') return false;
      return run({ expectedVersion: s.snapshot.version, command }, false);
    },

    retry: async () => {
      const env = get().failed;
      if (!env || get().save === 'saving') return false;
      return run(env, true);
    },

    dismissError: () => set({ save: 'saved', error: null, fieldErrors: null, failed: null }),
    select: (id) => set({ selectedId: id }),
    setDraft: (key, value) =>
      set((s) => {
        const drafts = { ...s.drafts };
        if (value === null) delete drafts[key]; else drafts[key] = value;
        return { drafts };
      }),
    announce: (text) => set({ announcement: text }),
  };
});

/** Draft text that lives in the store, so it survives failed saves and re-renders. */
export function useDraft(key: string, initial = ''): [string, (v: string | null) => void] {
  const v = useStore((s) => s.drafts[key]);
  const setDraft = useStore((s) => s.setDraft);
  return [v ?? initial, (next) => setDraft(key, next)];
}
