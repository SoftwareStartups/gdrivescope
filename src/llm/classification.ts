export const CLASSIFICATION_VALUES = [
  'pitch_deck',
  'board_minutes',
  'board_presentation',
  'financial',
  'reporting',
  'newsletter',
  'legal',
  'strategy',
  'hr',
  'research',
  'other',
] as const;

export type Classification = (typeof CLASSIFICATION_VALUES)[number];
