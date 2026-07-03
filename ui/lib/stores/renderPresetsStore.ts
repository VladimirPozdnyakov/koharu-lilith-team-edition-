'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { TextStyle } from '@/lib/api/schemas'

/**
 * A saved snapshot of render style controls. `Partial<TextStyle>` so a preset
 * can omit e.g. `fontSize` (preserving each block's auto-fit size) when applied
 * via `applyStyleToSelected` / `applyStyleToAll` (which merge per-field).
 */
export type RenderPreset = {
  id: string
  name: string
  style: Partial<TextStyle>
  createdAt: number
}

type RenderPresetsState = {
  presets: RenderPreset[]
  activePresetId: string | null
  addPreset: (name: string, style: Partial<TextStyle>) => RenderPreset
  updatePreset: (id: string, patch: Partial<Pick<RenderPreset, 'name' | 'style'>>) => void
  removePreset: (id: string) => void
  duplicatePreset: (id: string) => RenderPreset | undefined
  setActivePreset: (id: string | null) => void
  /** Replace the whole list (used by import). Caller is responsible for ids/names. */
  replacePresets: (presets: RenderPreset[]) => void
  /** Add presets from an import, de-duplicating names with a suffix. */
  importPresets: (incoming: RenderPreset[]) => number
}

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`

/** Ensure an imported name doesn't collide with an existing one. */
function uniqueName(existing: string[], name: string): string {
  if (!existing.includes(name)) return name
  let i = 2
  while (existing.includes(`${name} (${i})`)) i += 1
  return `${name} (${i})`
}

export const useRenderPresetsStore = create<RenderPresetsState>()(
  persist(
    (set, get) => ({
      presets: [],
      activePresetId: null,

      addPreset: (name, style) => {
        const preset: RenderPreset = {
          id: newId(),
          name: name.trim() || 'Preset',
          style,
          createdAt: Date.now(),
        }
        set((state) => ({ presets: [...state.presets, preset] }))
        return preset
      },

      updatePreset: (id, patch) =>
        set((state) => ({
          presets: state.presets.map((p) =>
            p.id === id
              ? {
                  ...p,
                  ...('name' in patch ? { name: patch.name ?? p.name } : {}),
                  ...('style' in patch ? { style: { ...p.style, ...patch.style } } : {}),
                }
              : p,
          ),
        })),

      removePreset: (id) =>
        set((state) => ({
          presets: state.presets.filter((p) => p.id !== id),
          activePresetId: state.activePresetId === id ? null : state.activePresetId,
        })),

      duplicatePreset: (id) => {
        const src = get().presets.find((p) => p.id === id)
        if (!src) return undefined
        const copy: RenderPreset = {
          ...src,
          id: newId(),
          name: uniqueName(get().presets.map((p) => p.name), src.name),
          style: { ...src.style },
          createdAt: Date.now(),
        }
        set((state) => ({ presets: [...state.presets, copy] }))
        return copy
      },

      setActivePreset: (id) => set({ activePresetId: id }),

      replacePresets: (presets) => set({ presets, activePresetId: null }),

      importPresets: (incoming) => {
        if (!incoming.length) return 0
        const existingNames = get().presets.map((p) => p.name)
        const toAdd: RenderPreset[] = incoming.map((p) => ({
          id: newId(),
          name: uniqueName(existingNames, (p.name ?? 'Imported').trim() || 'Imported'),
          style: p.style ?? {},
          createdAt: p.createdAt ?? Date.now(),
        }))
        // Update existingNames as we go so chained duplicates within the import
        // also get distinct names.
        for (const a of toAdd) existingNames.push(a.name)
        set((state) => ({ presets: [...state.presets, ...toAdd] }))
        return toAdd.length
      },
    }),
    {
      name: 'koharu-render-presets',
      version: 1,
      partialize: (state) => ({ presets: state.presets, activePresetId: state.activePresetId }),
    },
  ),
)
