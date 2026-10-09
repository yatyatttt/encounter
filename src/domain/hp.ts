// Pure HP arithmetic (PRD 5.2). Shared by the server (authoritative) and the web UI (previews only).
export type Hp = { hp: number; tempHp: number };

export function applyDamage({ hp, tempHp }: Hp, amount: number): Hp {
  const absorbed = Math.min(tempHp, amount);
  return { hp: Math.max(0, hp - (amount - absorbed)), tempHp: tempHp - absorbed };
}

export function applyHealing({ hp, tempHp }: Hp, maxHp: number, amount: number): Hp {
  return { hp: Math.min(maxHp, hp + amount), tempHp };
}

export function grantTempHp({ hp, tempHp }: Hp, amount: number, choice: 'keep' | 'replace'): Hp {
  return { hp, tempHp: choice === 'replace' ? amount : Math.max(tempHp, amount) };
}

export type HpInput = { type: 'damage' | 'heal' | 'set'; amount: number };

/** Quick input: "-12" damage, "+8" healing, "15" set current HP. Returns null if not a valid integer entry. */
export function parseHpInput(text: string): HpInput | null {
  const m = /^\s*([+-]?)\s*(\d+)\s*$/.exec(text);
  if (!m) return null;
  const amount = Number(m[2]);
  if (!Number.isSafeInteger(amount)) return null;
  return { type: m[1] === '-' ? 'damage' : m[1] === '+' ? 'heal' : 'set', amount };
}
