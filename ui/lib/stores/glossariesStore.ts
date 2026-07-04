'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type GlossaryEntry = {
  source: string
  target: string
  note?: string
}

export type Glossary = {
  id: string
  name: string
  entries: GlossaryEntry[]
  createdAt: number
}

type GlossariesState = {
  glossaries: Glossary[]
  /** Ids of glossaries currently applied to the prompt + highlight. */
  activeGlossaryIds: string[]
  addGlossary: (name: string) => Glossary
  updateGlossary: (id: string, patch: Partial<Pick<Glossary, 'name'>>) => void
  removeGlossary: (id: string) => void
  duplicateGlossary: (id: string) => Glossary | undefined
  toggleActive: (id: string) => void
  addEntry: (glossaryId: string, source: string, target: string, note?: string) => void
  updateEntry: (glossaryId: string, index: number, patch: Partial<GlossaryEntry>) => void
  removeEntry: (glossaryId: string, index: number) => void
  /** Replace the whole list (used by import). Caller is responsible for ids/names. */
  replaceGlossaries: (glossaries: Glossary[]) => void
  /** Add glossaries from an import, de-duplicating names with a suffix. */
  importGlossaries: (incoming: Glossary[]) => number
}

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`

function uniqueName(existing: string[], name: string): string {
  if (!existing.includes(name)) return name
  let i = 2
  while (existing.includes(`${name} (${i})`)) i += 1
  return `${name} (${i})`
}

export const useGlossariesStore = create<GlossariesState>()(
  persist(
    (set, get) => ({
      glossaries: [],
      activeGlossaryIds: [],

      addGlossary: (name) => {
        const g: Glossary = {
          id: newId(),
          name: name.trim() || 'Glossary',
          entries: [],
          createdAt: Date.now(),
        }
        set((state) => ({ glossaries: [...state.glossaries, g] }))
        return g
      },

      updateGlossary: (id, patch) =>
        set((state) => ({
          glossaries: state.glossaries.map((g) =>
            g.id === id ? { ...g, ...('name' in patch ? { name: patch.name ?? g.name } : {}) } : g,
          ),
        })),

      removeGlossary: (id) =>
        set((state) => ({
          glossaries: state.glossaries.filter((g) => g.id !== id),
          activeGlossaryIds: state.activeGlossaryIds.filter((a) => a !== id),
        })),

      duplicateGlossary: (id) => {
        const src = get().glossaries.find((g) => g.id === id)
        if (!src) return undefined
        const copy: Glossary = {
          ...src,
          id: newId(),
          name: uniqueName(get().glossaries.map((g) => g.name), src.name),
          entries: src.entries.map((e) => ({ ...e })),
          createdAt: Date.now(),
        }
        set((state) => ({ glossaries: [...state.glossaries, copy] }))
        return copy
      },

      toggleActive: (id) =>
        set((state) => ({
          activeGlossaryIds: state.activeGlossaryIds.includes(id)
            ? state.activeGlossaryIds.filter((a) => a !== id)
            : [...state.activeGlossaryIds, id],
        })),

      addEntry: (glossaryId, source, target, note) =>
        set((state) => ({
          glossaries: state.glossaries.map((g) =>
            g.id === glossaryId
              ? { ...g, entries: [...g.entries, { source, target, note }] }
              : g,
          ),
        })),

      updateEntry: (glossaryId, index, patch) =>
        set((state) => ({
          glossaries: state.glossaries.map((g) =>
            g.id === glossaryId
              ? {
                  ...g,
                  entries: g.entries.map((e, i) => (i === index ? { ...e, ...patch } : e)),
                }
              : g,
          ),
        })),

      removeEntry: (glossaryId, index) =>
        set((state) => ({
          glossaries: state.glossaries.map((g) =>
            g.id === glossaryId
              ? { ...g, entries: g.entries.filter((_, i) => i !== index) }
              : g,
          ),
        })),

      replaceGlossaries: (glossaries) =>
        set({ glossaries, activeGlossaryIds: [] }),

      importGlossaries: (incoming) => {
        if (!incoming.length) return 0
        const existingNames = get().glossaries.map((g) => g.name)
        const toAdd: Glossary[] = incoming.map((g) => ({
          id: newId(),
          name: uniqueName(existingNames, (g.name ?? 'Imported').trim() || 'Imported'),
          entries: Array.isArray(g.entries) ? g.entries.map((e) => ({ ...e })) : [],
          createdAt: g.createdAt ?? Date.now(),
        }))
        for (const a of toAdd) existingNames.push(a.name)
        set((state) => ({ glossaries: [...state.glossaries, ...toAdd] }))
        return toAdd.length
      },
    }),
    {
      name: 'koharu-glossaries',
      version: 1,
      partialize: (state) => ({
        glossaries: state.glossaries,
        activeGlossaryIds: state.activeGlossaryIds,
      }),
    },
  ),
)
