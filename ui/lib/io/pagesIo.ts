'use client'

import { getGetSceneJsonQueryKey } from '@/lib/api/default/default'
import type { SceneSnapshot } from '@/lib/api/schemas'
import { textNodesOf } from '@/hooks/useCurrentPage'
import { openImageFiles, openImageFolder, openKhrFile } from '@/lib/io/openFiles'
import { saveBlob } from '@/lib/io/saveBlob'
import { exportProject, uploadKhrArchive, uploadPages, uploadPagesByPaths } from '@/lib/io/scene'
import { queryClient } from '@/lib/queryClient'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'

/**
 * Platform-neutral image import. `openImageFiles` / `openImageFolder` return
 * `File[]` on both Tauri and the web; the upload + scene invalidation lives
 * in `lib/io/scene.ts` on top of the orval-generated `createPages` mutation.
 */
export async function importPages(
  mode: 'replace' | 'append',
  source: 'files' | 'folder',
): Promise<void> {
  const picked = source === 'folder' ? await openImageFolder() : await openImageFiles()
  const replace = mode === 'replace'
  if (picked.kind === 'paths') {
    if (picked.paths.length === 0) return
    await uploadPagesByPaths(picked.paths, replace)
    return
  }
  if (picked.files.length === 0) return
  await uploadPages(picked.files, replace)
}

/**
 * Import a `.khr` archive. Works on both desktop and web: the archive file
 * is picked via the cross-platform `openKhrFile`, and the destination is
 * allocated server-side so the client never needs to touch the filesystem.
 */
export async function importKhrFile(): Promise<void> {
  const file = await openKhrFile()
  if (!file) return
  await uploadKhrArchive(file)
}

// ---------------------------------------------------------------------------
// Export (server returns bytes; saveBlob dispatches Tauri-dialog / web-FS)
// ---------------------------------------------------------------------------

const exportExtension: Record<'khr' | 'psd' | 'rendered' | 'inpainted', string> = {
  khr: 'khr',
  psd: 'zip',
  rendered: 'zip',
  inpainted: 'zip',
}

/** Sanitise an arbitrary project name for use as a filename stem. */
function sanitiseBaseName(name: string | undefined | null): string {
  const cleaned = (name ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
  return cleaned.length > 0 ? cleaned : 'koharu-export'
}

/** Read the current project name from React Query's cached scene snapshot. */
function currentProjectName(): string | undefined {
  const snap = queryClient.getQueryData<SceneSnapshot>(getGetSceneJsonQueryKey())
  return snap?.scene.project?.name ?? undefined
}

export async function exportCurrentProjectAs(
  format: 'khr' | 'psd' | 'rendered' | 'inpainted',
  pages?: string[],
): Promise<void> {
  try {
    const defaultFont = usePreferencesStore.getState().defaultFont
    const { blob, filename } = await exportProject({ format, pages, defaultFont })
    const base = sanitiseBaseName(currentProjectName())
    // Prefer the server's Content-Disposition filename (matches the actual
    // bytes — a raw PNG/PSD for single-file responses, a zip for multi).
    // Fall back to our guess only if the header is missing/unparseable.
    const defaultName = filename ?? `${base}.${exportExtension[format]}`
    await saveBlob(blob, defaultName)
  } catch (err) {
    console.error('Export failed:', err)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Text export (client-side: OCR + translation are already in scene state)
// ---------------------------------------------------------------------------

/**
 * Build a `.txt` body for the given pages: each text block rendered as
 * `[index] <OCR> → <translation>`, blocks joined by newlines, pages
 * separated by a `— Страница N —` header. Empty blocks (no OCR and no
 * translation) are skipped.
 */
function buildTextExport(pages: { name?: string; blocks: { ocr?: string; translation?: string }[] }[]): string {
  const sections: string[] = []
  const multiple = pages.length > 1
  pages.forEach((page, pageIdx) => {
    const lines: string[] = []
    if (multiple) {
      const title = (page.name ?? `Страница ${pageIdx + 1}`).trim()
      lines.push(`— ${title} —`, '')
    }
    let blockNo = 0
    for (const block of page.blocks) {
      const ocr = (block.ocr ?? '').trim()
      const translation = (block.translation ?? '').trim()
      if (!ocr && !translation) continue
      blockNo += 1
      if (ocr && translation) lines.push(`[${blockNo}] ${ocr} → ${translation}`)
      else if (translation) lines.push(`[${blockNo}] ${translation}`)
      else lines.push(`[${blockNo}] ${ocr}`)
    }
    // Only include pages that actually have text; keep the page header order.
    if (lines.some((l) => l.length > 0 && !l.startsWith('—'))) sections.push(lines.join('\n'))
  })
  return sections.join('\n\n')
}

/**
 * Collect text blocks (OCR + translation) for a filtered set of pages,
 * read straight from the cached scene snapshot.
 */
function collectPages(pageIds?: string[]): { name?: string; blocks: { ocr?: string; translation?: string }[] }[] {
  const snap = queryClient.getQueryData<SceneSnapshot>(getGetSceneJsonQueryKey())
  const pagesMap = snap?.scene?.pages
  if (!pagesMap) return []
  const wanted = pageIds ? new Set(pageIds) : null
  return Object.values(pagesMap)
    .filter((page) => !wanted || wanted.has(page.id))
    .map((page) => {
      const nodes = textNodesOf(page)
      // Order by reading position (top-to-bottom, left-to-right) so the export
      // follows the natural flow of the page.
      nodes.sort((a, b) =>
        a.transform.y === b.transform.y
          ? a.transform.x - b.transform.x
          : a.transform.y - b.transform.y,
      )
      return {
        name: page.name,
        blocks: nodes.map((n) => ({
          ocr: n.data.text ?? undefined,
          translation: n.data.translation ?? undefined,
        })),
      }
    })
}

/**
 * Export OCR text + translation to a `.txt` file. With no `pageIds`, exports
 * every page of the current project; otherwise only the listed pages.
 */
export async function exportCurrentProjectAsText(pageIds?: string[]): Promise<void> {
  try {
    const pages = collectPages(pageIds)
    const body = buildTextExport(pages)
    const base = sanitiseBaseName(currentProjectName())
    const suffix = pageIds && pageIds.length === 1 ? '-page' : ''
    await saveBlob(new Blob([body], { type: 'text/plain;charset=utf-8' }), `${base}${suffix}.txt`)
  } catch (err) {
    console.error('Text export failed:', err)
    throw err
  }
}

