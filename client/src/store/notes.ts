import { openDB } from 'idb'
import type { Note, HistoryCursor } from '../types/protocol'

const DB_NAME = 'sigil-notes'
const STORE = 'notes'
let connection: ReturnType<typeof openDB> | undefined

async function notesDb() {
  if (!connection) {
    connection = openDB(DB_NAME, 2, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        const store = oldVersion < 1 ? db.createObjectStore(STORE, { keyPath: 'jti' }) : transaction.objectStore(STORE)
        if (oldVersion < 1) {
          store.createIndex('channel', 'channel')
          store.createIndex('issuedAt', 'issuedAt')
        }
        if (!store.indexNames.contains('history')) store.createIndex('history', ['channel', 'issuedAt', 'jti'])
      },
      blocking() { void connection?.then(db => db.close()); connection = undefined },
    }).catch(error => { connection = undefined; throw error })
  }
  return connection
}

export async function saveNote(note: Note): Promise<void> {
  await (await notesDb()).put(STORE, note)
}

/** Atomic across live delivery, parallel peer replies, and browser tabs. */
export async function saveNoteIfNew(note: Note): Promise<boolean> {
  const db = await notesDb()
  const tx = db.transaction(STORE, 'readwrite')
  if (await tx.store.get(note.jti)) { await tx.done; return false }
  await tx.store.add(note)
  await tx.done
  return true
}

export async function getNotesByChannel(channel: string): Promise<Note[]> {
  const notes = await (await notesDb()).getAllFromIndex(STORE, 'channel', channel)
  return notes.sort((a, b) => a.issuedAt - b.issuedAt || (a.jti < b.jti ? -1 : 1))
}

export interface HistoryPage { notes: Note[]; more: boolean }

/** Strict compound cursor avoids losing notes sharing the same second. */
export async function getHistoryPage(channel: string, till: number, before?: HistoryCursor, limit = 25): Promise<HistoryPage> {
  const db = await notesDb()
  const upper = before ? [channel, before.iat, before.jti] : [channel, till]
  const range = IDBKeyRange.bound([channel], upper, false, true)
  let cursor = await db.transaction(STORE).store.index('history').openCursor(range, 'prev')
  const notes: Note[] = []
  while (cursor && notes.length < limit) {
    notes.push(cursor.value as Note)
    cursor = await cursor.continue()
  }
  return { notes, more: cursor !== null }
}

export async function hasNote(jti: string): Promise<boolean> {
  return (await (await notesDb()).get(STORE, jti)) !== undefined
}

export async function deleteNotesByAuthor(authorFp: string): Promise<void> {
  const db = await notesDb()
  const tx = db.transaction(STORE, 'readwrite')
  const all = await tx.store.getAll()
  await Promise.all(all.filter(n => n.authorFp === authorFp).map(n => tx.store.delete(n.jti)))
  await tx.done
}
