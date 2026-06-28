import { openDB } from 'idb'
import type { Note } from '../types/protocol'

const DB_NAME = 'sigil-notes'
const DB_VERSION = 1
const STORE = 'notes'

async function notesDb() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const store = db.createObjectStore(STORE, { keyPath: 'jti' })
      store.createIndex('channel', 'channel')
      store.createIndex('issuedAt', 'issuedAt')
    },
  })
}

export async function saveNote(note: Note): Promise<void> {
  const db = await notesDb()
  await db.put(STORE, note)
}

export async function getNotesByChannel(channel: string): Promise<Note[]> {
  const db = await notesDb()
  const notes = await db.getAllFromIndex(STORE, 'channel', channel)
  return notes.sort((a, b) => b.issuedAt - a.issuedAt)
}

export async function hasNote(jti: string): Promise<boolean> {
  const db = await notesDb()
  return (await db.get(STORE, jti)) !== undefined
}

export async function deleteNotesByAuthor(authorFp: string): Promise<void> {
  const db = await notesDb()
  const tx = db.transaction(STORE, 'readwrite')
  const all = await tx.store.getAll()
  await Promise.all(
    all.filter(n => n.authorFp === authorFp).map(n => tx.store.delete(n.jti)),
  )
  await tx.done
}
