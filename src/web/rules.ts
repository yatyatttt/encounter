// Bundled, offline condition reference: short original summaries (not rules text). Labelled with RULES_VERSION in the UI.
// The app only records conditions; the DM applies the effects.
export { RULES_VERSION } from '../shared/contract';

export const CONDITION_RULES: Record<string, string> = {
  blinded: "Can't see; automatically fails checks that need sight. Attacks against it have Advantage; its own attacks have Disadvantage.",
  charmed: "Can't attack the charmer or target it with harmful effects. The charmer has Advantage on social interaction checks against it.",
  deafened: "Can't hear; automatically fails checks that need hearing.",
  frightened: 'While the source of fear is in line of sight: Disadvantage on ability checks and attack rolls, and it cannot willingly move closer to the source.',
  grappled: "Speed is 0 and can't increase. Disadvantage on attacks against anyone but the grappler. Ends if the grappler is incapacitated or the creature is moved out of reach.",
  incapacitated: "Can't take actions, Bonus Actions or Reactions; Concentration is broken; can't speak; Disadvantage on Initiative rolls.",
  invisible: 'Advantage on Initiative. Attacks against it have Disadvantage and its attacks have Advantage, unless the other side can see invisible creatures.',
  paralyzed: 'Incapacitated; Speed 0; automatically fails Strength and Dex saves. Attacks against it have Advantage; hits from within 5 ft are critical hits.',
  petrified: 'Turned to a solid substance: Incapacitated, Speed 0, unaware of surroundings. Attacks against it have Advantage; fails Strength and Dex saves; Resistance to all damage; immune to Poisoned.',
  poisoned: 'Disadvantage on attack rolls and ability checks.',
  prone: 'Can only crawl or stand (standing costs half Speed). Disadvantage on its attacks. Attacks against it have Advantage from within 5 ft, otherwise Disadvantage.',
  restrained: 'Speed 0. Attacks against it have Advantage; its attacks have Disadvantage; Disadvantage on Dexterity saves.',
  stunned: 'Incapacitated; automatically fails Strength and Dex saves; attacks against it have Advantage.',
  unconscious: 'Incapacitated and Prone; Speed 0; drops what it holds; unaware of surroundings. Fails Strength and Dex saves; attacks against it have Advantage; hits from within 5 ft are critical hits.',
  exhaustion: 'Levels 1–6. D20 Tests are reduced by 2 × level and Speed by 5 ft × level. Level 6 is death — the DM confirms the outcome. A long rest removes one level. (The app does not change stored stats.)',
};
