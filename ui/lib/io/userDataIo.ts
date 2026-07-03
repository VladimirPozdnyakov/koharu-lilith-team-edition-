'use client'

import { openJsonFile } from '@/lib/io/openFiles'
import { saveBlob } from '@/lib/io/saveBlob'

/**
 * Cross-platform helpers for exporting/importing global user-data collections
 * (render presets, glossaries, …) as JSON files. Built on top of the existing
 * `saveBlob` / file-picker primitives so they work the same on Tauri desktop
 * and the web fallback.
 */

/** Export a single object as a pretty-printed JSON file. Returns false if cancelled. */
export async function exportUserData(data: unknown, defaultName: string): Promise<boolean> {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  return saveBlob(blob, defaultName.endsWith('.json') ? defaultName : `${defaultName}.json`)
}

/** Export a collection (array) wrapped in `{ items: [...] }` as one JSON file. */
export async function exportUserDataCollection(
  items: unknown[],
  defaultName: string,
): Promise<boolean> {
  return exportUserData({ items }, defaultName)
}

/**
 * Open a JSON file and parse it. Returns the parsed value (or `null` if the
 * user cancelled / the file was empty or unparseable).
 *
 * Accepts either a bare JSON value or a `{ items: [...] }` envelope (as written
 * by `exportUserDataCollection`); in the envelope case the inner array is
 * returned so callers always get the list of records.
 */
export async function importUserData<T = unknown>(): Promise<T | null> {
  const file = await openJsonFile()
  if (!file) return null
  const text = await file.text()
  try {
    const parsed = JSON.parse(text)
    // Unwrap the collection envelope written by exportUserDataCollection.
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { items?: unknown }).items)
    ) {
      return (parsed as { items: T }).items
    }
    return parsed as T
  } catch {
    return null
  }
}
