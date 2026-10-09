// Shared form fields for library templates and ad hoc combatants. State is kept as strings so fields can be cleared;
// the server (Zod) is the validator and its fieldErrors are shown inline.
import { fieldError } from '@/api';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import type { Template } from '../../shared/contract';

const KEYS = ['kind', 'name', 'maxHp', 'startingHp', 'startingTempHp', 'armorClass', 'initiativeModifier', 'speedFt', 'className', 'level', 'passivePerception', 'notes', 'tags'] as const;
export type FormState = Record<(typeof KEYS)[number], string>;

export const emptyForm = (): FormState => ({
  kind: 'enemy', name: '', maxHp: '10', startingHp: '', startingTempHp: '0', armorClass: '10', initiativeModifier: '0',
  speedFt: '30', className: '', level: '', passivePerception: '', notes: '', tags: '',
});

export const formFromTemplate = (t: Template): FormState => ({
  kind: t.kind, name: t.name, maxHp: String(t.maxHp), startingHp: t.startingHp === null ? '' : String(t.startingHp),
  startingTempHp: String(t.startingTempHp), armorClass: String(t.armorClass), initiativeModifier: String(t.initiativeModifier),
  speedFt: String(t.speedFt), className: t.className ?? '', level: t.level === null ? '' : String(t.level),
  passivePerception: t.passivePerception === null ? '' : String(t.passivePerception), notes: t.notes, tags: t.tags.join(', '),
});

const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

export function formToInput(f: FormState, withTags: boolean) {
  return {
    kind: f.kind, name: f.name, maxHp: num(f.maxHp), startingHp: numOrNull(f.startingHp), startingTempHp: num(f.startingTempHp),
    armorClass: num(f.armorClass), initiativeModifier: num(f.initiativeModifier), speedFt: num(f.speedFt),
    className: f.className.trim() || null, level: numOrNull(f.level), passivePerception: numOrNull(f.passivePerception), notes: f.notes,
    ...(withTags ? { tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
  };
}

export function CombatantForm({ form, setForm, errors, tags }: {
  form: FormState; setForm: (f: FormState) => void; errors?: Record<string, string[]> | null; tags?: boolean;
}) {
  const bind = (k: keyof FormState) => ({
    value: form[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value }),
  });
  const num = (k: keyof FormState, label: string, hint = '') => (
    <Field label={label} error={fieldError(errors, k)}>{(id) => <Input id={id} type="number" inputMode="numeric" placeholder={hint} {...bind(k)} />}</Field>
  );
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <Field label="Name" error={fieldError(errors, 'name')} className="col-span-2">{(id) => <Input id={id} {...bind('name')} />}</Field>
      <Field label="Kind" error={fieldError(errors, 'kind')}>
        {(id) => <Select id={id} {...bind('kind')}><option value="player">Player</option><option value="enemy">Enemy</option><option value="npc">NPC</option></Select>}
      </Field>
      {num('maxHp', 'Max HP')}
      {num('startingHp', 'Starting HP', 'max')}
      {num('startingTempHp', 'Starting temp HP')}
      {num('armorClass', 'AC')}
      {num('initiativeModifier', 'Initiative mod')}
      {num('speedFt', 'Speed (ft)')}
      {num('passivePerception', 'Passive perception')}
      <Field label="Class" error={fieldError(errors, 'className')}>{(id) => <Input id={id} {...bind('className')} />}</Field>
      {num('level', 'Level')}
      {tags && <Field label="Tags (comma separated)" error={fieldError(errors, 'tags')} className="col-span-2 sm:col-span-3">{(id) => <Input id={id} {...bind('tags')} />}</Field>}
      <Field label="Notes" error={fieldError(errors, 'notes')} className="col-span-2 sm:col-span-3">{(id) => <Textarea id={id} {...bind('notes')} />}</Field>
    </div>
  );
}
