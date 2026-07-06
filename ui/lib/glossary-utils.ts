'use client'

import { useGlossariesStore } from '@/lib/stores/glossariesStore'
import type { Glossary, GlossaryEntry } from '@/lib/stores/glossariesStore'

/**
 * React hook returning the formatted glossary string for the active
 * glossaries, or `undefined` if there is nothing to inject. Use in
 * pipeline-launch sites alongside `customSystemPrompt`.
 */
export function useGlossaryForPrompt(): string | undefined {
  const glossaries = useGlossariesStore((s) => s.glossaries)
  const activeGlossaryIds = useGlossariesStore((s) => s.activeGlossaryIds)
  return formatGlossaryForPrompt(glossaries, activeGlossaryIds) ?? undefined
}

/**
 * Non-hook variant: read the current store state and return the formatted
 * glossary string (or `undefined`). Use inside event handlers / getState().
 */
export function getGlossaryForPrompt(): string | undefined {
  const { glossaries, activeGlossaryIds } = useGlossariesStore.getState()
  return formatGlossaryForPrompt(glossaries, activeGlossaryIds) ?? undefined
}


/**
 * Collect entries from all active glossaries, in a stable order
 * (glossary order → entry order). Deduplicates identical (source,target) pairs.
 */
export function collectActiveEntries(
  glossaries: Glossary[],
  activeGlossaryIds: string[],
): GlossaryEntry[] {
  const active = new Set(activeGlossaryIds)
  const seen = new Set<string>()
  const out: GlossaryEntry[] = []
  for (const g of glossaries) {
    if (!active.has(g.id)) continue
    for (const e of g.entries) {
      const key = `${e.source}\0${e.target}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(e)
    }
  }
  return out
}

/**
 * Build the glossary injection text for the LLM system prompt.
 * Deterministic output: same entries → same string (so the cache key in
 * Phase 2 F is stable). Returns `null` if there are no usable entries.
 */
export function formatGlossaryForPrompt(
  glossaries: Glossary[],
  activeGlossaryIds: string[],
): string | null {
  const entries = collectActiveEntries(glossaries, activeGlossaryIds).filter(
    (e) => e.source.trim() && e.target.trim(),
  )
  if (entries.length === 0) return null
  const lines = entries.map((e) => `- ${e.source.trim()} → ${e.target.trim()}`)
  return `Glossary (translate these terms consistently):\n${lines.join('\n')}`
}

/**
 * Find all occurrences of glossary source terms in `text`, returning
 * `{start, end}` ranges for highlighting. Longest terms first so a longer
 * term wins over a shorter overlapping one.
 */
export function findTermRanges(
  text: string,
  glossaries: Glossary[],
  activeGlossaryIds: string[],
): { start: number; end: number }[] {
  const sources = Array.from(
    new Set(
      collectActiveEntries(glossaries, activeGlossaryIds)
        .map((e) => e.source.trim())
        .filter((s) => s.length > 0),
    ),
  ).sort((a, b) => b.length - a.length) // longest first for non-overlapping

  const ranges: { start: number; end: number }[] = []
  const occupied = new Array(text.length).fill(false)
  for (const term of sources) {
    // Escape regex metacharacters in the term.
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(escaped, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const start = m.index
      const end = start + term.length
      // Skip if any position in this range is already occupied.
      let overlap = false
      for (let i = start; i < end; i++) {
        if (occupied[i]) {
          overlap = true
          break
        }
      }
      if (!overlap) {
        for (let i = start; i < end; i++) occupied[i] = true
        ranges.push({ start, end })
      }
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }
  return ranges
}

/**
 * Suggest autocomplete terms for the translation field: returns target
 * values from active glossaries whose `source` matches the current OCR text
 * (so the user can quickly reuse an established translation), plus targets
 * that start with the current word being typed.
 */
export function suggestAutocompleteTerms(
  typedWord: string,
  glossaries: Glossary[],
  activeGlossaryIds: string[],
): string[] {
  if (!typedWord) return []
  const entries = collectActiveEntries(glossaries, activeGlossaryIds)
  const lower = typedWord.toLowerCase()
  const matches = new Set<string>()
  for (const e of entries) {
    if (e.target.toLowerCase().startsWith(lower) && e.target.trim()) {
      matches.add(e.target.trim())
    }
  }
  return Array.from(matches).slice(0, 8)
}
