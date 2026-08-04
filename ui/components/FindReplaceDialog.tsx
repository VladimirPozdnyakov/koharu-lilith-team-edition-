'use client'

import { CaseSensitiveIcon, ReplaceIcon, SearchIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { getGetSceneJsonQueryKey } from '@/lib/api/default/default'
import type { Op, SceneSnapshot } from '@/lib/api/schemas'
import { applyOp, invalidateScene, queueAutoRender } from '@/lib/io/scene'
import { ops } from '@/lib/ops'
import { queryClient } from '@/lib/queryClient'

type Match = {
  pageId: string
  nodeId: string
  /** "translation" | "text" (OCR) */
  field: 'translation' | 'text'
  /** the matched occurrence's start index within the field value */
  index: number
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Scan the whole project for occurrences of `query`. */
function findMatches(
  query: string,
  { caseSensitive, includeOcr }: { caseSensitive: boolean; includeOcr: boolean },
): Match[] {
  if (!query) return []
  const snap = queryClient.getQueryData<SceneSnapshot>(getGetSceneJsonQueryKey())
  const pages = snap?.scene?.pages
  if (!pages) return []
  const flags = caseSensitive ? 'g' : 'gi'
  const re = new RegExp(escapeRegExp(query), flags)
  const out: Match[] = []
  for (const [pageId, page] of Object.entries(pages)) {
    for (const [nodeId, node] of Object.entries(page.nodes)) {
      if (!node || !('text' in node.kind)) continue
      const data = node.kind.text
      const translation = data.translation ?? ''
      if (translation) {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(translation)) !== null) {
          out.push({ pageId, nodeId, field: 'translation', index: m.index })
          if (m.index === re.lastIndex) re.lastIndex++ // avoid zero-length loop
        }
      }
      if (includeOcr) {
        const text = data.text ?? ''
        if (text) {
          re.lastIndex = 0
          let m: RegExpExecArray | null
          while ((m = re.exec(text)) !== null) {
            out.push({ pageId, nodeId, field: 'text', index: m.index })
            if (m.index === re.lastIndex) re.lastIndex++
          }
        }
      }
    }
  }
  return out
}

export function FindReplaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [includeOcr, setIncludeOcr] = useState(false)
  const [applying, setApplying] = useState(false)

  const matches = useMemo(
    () => findMatches(find, { caseSensitive, includeOcr }),
    [find, caseSensitive, includeOcr],
  )

  // Pages touched (for re-render after replace).
  const touchedPages = useMemo(() => new Set(matches.map((m) => m.pageId)), [matches])

  const canReplace = matches.length > 0 && !applying

  const handleReplaceAll = async () => {
    if (!canReplace) return
    setApplying(true)
    try {
      // Group matches by (pageId, nodeId, field) to build per-node replacement text.
      const byNode = new Map<string, { pageId: string; nodeId: string; field: 'translation' | 'text'; indices: number[] }>()
      for (const m of matches) {
        const key = `${m.pageId}:${m.nodeId}:${m.field}`
        const entry = byNode.get(key)
        if (entry) entry.indices.push(m.index)
        else byNode.set(key, { pageId: m.pageId, nodeId: m.nodeId, field: m.field, indices: [m.index] })
      }

      // Read current values fresh from the cache.
      const snap = queryClient.getQueryData<SceneSnapshot>(getGetSceneJsonQueryKey())
      const pages = snap?.scene?.pages

      const flags = caseSensitive ? 'g' : 'gi'
      const re = new RegExp(escapeRegExp(find), flags)
      const inner: Op[] = []
      for (const { pageId, nodeId, field } of byNode.values()) {
        const page = pages?.[pageId]
        const node = page?.nodes?.[nodeId]
        if (!page || !node || !('text' in node.kind)) continue
        const original = (field === 'translation' ? node.kind.text.translation : node.kind.text.text) ?? ''
        re.lastIndex = 0
        const next = original.replace(re, replace)
        if (next === original) continue
        inner.push(ops.updateText(pageId, nodeId, { [field]: next }))
      }

      if (inner.length > 0) {
        await applyOp(ops.batch(t('findReplace.batchLabel'), inner))
        for (const pageId of touchedPages) queueAutoRender(pageId)
        await invalidateScene()
      }
      onOpenChange(false)
    } finally {
      setApplying(false)
    }
  }

  // Reset state when closed.
  useEffect(() => {
    if (!open) {
      setFind('')
      setReplace('')
      setApplying(false)
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex w-[440px] max-w-[92vw] flex-col gap-4 p-5'>
        <DialogTitle className='text-sm'>{t('findReplace.title')}</DialogTitle>
        <DialogDescription className='sr-only'>{t('findReplace.title')}</DialogDescription>

        <div className='flex flex-col gap-3'>
          <div className='flex items-center gap-2'>
            <SearchIcon className='size-4 shrink-0 text-muted-foreground' aria-hidden='true' />
            <Input
              autoFocus
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder={t('findReplace.findPlaceholder')}
              aria-label={t('findReplace.findPlaceholder')}
              className='h-8'
            />
          </div>
          <div className='flex items-center gap-2'>
            <ReplaceIcon className='size-4 shrink-0 text-muted-foreground' aria-hidden='true' />
            <Input
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
              placeholder={t('findReplace.replacePlaceholder')}
              aria-label={t('findReplace.replacePlaceholder')}
              className='h-8'
            />
          </div>

          <div className='flex items-center gap-4'>
            <label className='flex items-center gap-2 text-xs text-muted-foreground'>
              <Switch
                checked={caseSensitive}
                onCheckedChange={setCaseSensitive}
                aria-label={t('findReplace.caseSensitive')}
              />
              <CaseSensitiveIcon className='size-3.5' aria-hidden='true' />
              {t('findReplace.caseSensitive')}
            </label>
            <label className='flex items-center gap-2 text-xs text-muted-foreground'>
              <Switch
                checked={includeOcr}
                onCheckedChange={setIncludeOcr}
                aria-label={t('findReplace.includeOcr')}
              />
              {t('findReplace.includeOcr')}
            </label>
          </div>

          <p className='text-xs text-muted-foreground' role='status' aria-live='polite'>
            {matches.length > 0
              ? t('findReplace.matchesFound', { count: matches.length })
              : find
                ? t('findReplace.noMatches')
                : t('findReplace.typeToSearch')}
          </p>
        </div>

        <div className='flex justify-end gap-2'>
          <Button variant='outline' size='sm' onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            size='sm'
            disabled={!canReplace}
            onClick={() => void handleReplaceAll()}
          >
            {applying ? t('findReplace.replacing') : t('findReplace.replaceAll')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
