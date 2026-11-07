import type { Note } from '../types/protocol'

export function compareNotes(a: Note, b: Note): number {
  return a.issuedAt - b.issuedAt || (a.jti < b.jti ? -1 : a.jti > b.jti ? 1 : 0)
}

/** One deterministic ascending timeline across live brokers, local storage and history. */
export function mergeNotes(existing: readonly Note[], incoming: readonly Note[]): Note[] {
  const unique = new Map(existing.map(note => [note.jti, note]))
  for (const note of incoming) if (!unique.has(note.jti)) unique.set(note.jti, note)
  return [...unique.values()].sort(compareNotes)
}
