'use client'

import { BookPlusIcon, ClipboardCopyIcon, Languages, LoaderCircleIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { DraftTextarea } from '@/components/ui/draft-textarea'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useCurrentPage, useTextNodes, type TextNodeEntry } from '@/hooks/useCurrentPage'
import { getConfig, startPipeline, useGetCurrentLlm } from '@/lib/api/default/default'
import { collectActiveEntries, findTermRanges, getGlossaryForPrompt } from '@/lib/glossary-utils'
import { fetchApi } from '@/lib/api/fetch'
import type { TextDataPatch } from '@/lib/api/schemas'
import { applyOp, invalidateScene, queueAutoRender, reorderPageTextNodes } from '@/lib/io/scene'
import { ops } from '@/lib/ops'
import { copyToClipboard } from '@/lib/utils'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { useGlossariesStore } from '@/lib/stores/glossariesStore'
import { useJobsStore } from '@/lib/stores/jobsStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { useSelectionStore } from '@/lib/stores/selectionStore'

export function TextBlocksPanel() {
  const { t } = useTranslation()
  const page = useCurrentPage()
  const textNodes = useTextNodes()
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(
        '[reorder] Text nodes order:',
        textNodes.map((n) => n.id),
      )
    }
  }, [textNodes])
  const selectedIds = useSelectionStore((s) => s.nodeIds)
  const select = useSelectionStore((s) => s.select)
  const clearSelection = useSelectionStore((s) => s.clear)
  const { data: llm } = useGetCurrentLlm()
  const llmReady = llm?.status === 'ready'
  const isProcessing = useJobsStore((s) =>
    Object.values(s.jobs).some((j) => j.status === 'running'),
  )
  const readingOrder = useEditorUiStore((s) => s.readingOrder)
  const setReadingOrder = useEditorUiStore((s) => s.setReadingOrder)
  const glossaries = useGlossariesStore((s) => s.glossaries)
  const activeGlossaryIds = useGlossariesStore((s) => s.activeGlossaryIds)

  // Autocomplete terms for the translation field = target values of active glossaries.
  const autocompleteTerms = useMemo(
    () => collectActiveEntries(glossaries, activeGlossaryIds).map((e) => e.target).filter(Boolean),
    [glossaries, activeGlossaryIds],
  )

  // "Add to glossary" — adds to the first active glossary (or creates one if none active).
  const addToGlossary = (source: string) => {
    const state = useGlossariesStore.getState()
    let targetId = state.activeGlossaryIds[0]
    if (!targetId) {
      if (state.glossaries.length === 0) {
        targetId = state.addGlossary(t('glossary.defaultName')).id
        state.toggleActive(targetId)
      } else {
        targetId = state.glossaries[0].id
      }
    }
    useGlossariesStore.getState().addEntry(targetId, source, '')
  }

  // Sort text nodes by the active reading order so the panel always reflects it.
  // `rtl`/`ltr` sort geometrically (top-to-bottom, then right-to-left /
  // left-to-right); `custom` preserves the scene order (set by drag-reorder
  // and the backend ReorderNodes op).
  const orderedNodes = useMemo(() => {
    if (readingOrder === 'ltr') {
      return [...textNodes].sort(
        (a, b) =>
          a.transform.y === b.transform.y
            ? a.transform.x - b.transform.x
            : a.transform.y - b.transform.y,
      )
    }
    if (readingOrder === 'rtl') {
      return [...textNodes].sort(
        (a, b) =>
          a.transform.y === b.transform.y
            ? b.transform.x - a.transform.x
            : a.transform.y - b.transform.y,
      )
    }
    return textNodes
  }, [textNodes, readingOrder])

  // Drag-reorder state (custom order).
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const handleReorder = async (fromId: string, toId: string) => {
    if (!page || fromId === toId) return
    const order = orderedNodes.map((n) => n.id)
    const from = order.indexOf(fromId)
    const to = order.indexOf(toId)
    if (from < 0 || to < 0) return
    const next = [...order]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    // Persist as the new custom order.
    await applyOp(ops.reorderNodes(page.id, next, order))
    setReadingOrder('custom')
    await invalidateScene()
    queueAutoRender(page.id)
  }

  if (!page) {
    return (
      <div className='flex flex-1 items-center justify-center text-xs text-muted-foreground'>
        {t('textBlocks.emptyPrompt')}
      </div>
    )
  }

  const selectedIndex = orderedNodes.findIndex((n) => selectedIds.has(n.id))
  const accordionValue = selectedIndex >= 0 ? selectedIndex.toString() : ''

  const patchText = async (nodeId: string, patch: TextDataPatch) => {
    await applyOp(
      ops.updateNode(page.id, nodeId, {
        data: { text: patch } as never,
      }),
    )
    queueAutoRender(page.id)
  }

  const removeNode = async (nodeId: string) => {
    const node = page.nodes[nodeId]
    if (!node) return
    const idx = Object.keys(page.nodes).indexOf(nodeId)
    await applyOp(ops.removeNode(page.id, nodeId, node, idx < 0 ? 0 : idx))
    clearSelection()
    queueAutoRender(page.id)
  }

  const generate = async (nodeId: string) => {
    if (!page) return
    const cfg = await getConfig()
    const translator = cfg.pipeline?.translator || 'llm'
    const renderer = cfg.pipeline?.renderer || 'koharu-renderer'
    const editor = useEditorUiStore.getState()
    const prefs = usePreferencesStore.getState()
    // Keep rendering page-scoped, but constrain translation to the clicked block.
    await startPipeline({
      steps: [translator, renderer],
      pages: [page.id],
      textNodeIds: [nodeId],
      targetLanguage: editor.selectedLanguage,
      systemPrompt: prefs.customSystemPrompt,
      glossary: getGlossaryForPrompt(),
      defaultFont: prefs.defaultFont,
      readingOrder: editor.readingOrder === 'custom' ? undefined : editor.readingOrder,
    })
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col' data-testid='panels-textblocks'>
      <div className='flex items-center justify-between border-b border-border px-2 py-1.5 text-xs font-medium text-muted-foreground'>
        <span data-testid='textblocks-count' data-count={orderedNodes.length}>
          {t('textBlocks.title', { count: orderedNodes.length })}
        </span>
        <div className='flex items-center gap-1.5'>
          <span className='font-normal uppercase opacity-50'>{t('textBlocks.readingOrder')}:</span>
          <Select
            value={readingOrder}
            onValueChange={async (val: 'rtl' | 'ltr' | 'custom') => {
              if (process.env.NODE_ENV !== 'production') {
                console.debug('[reorder] Changing reading order to:', val)
              }

              if (val === 'custom') {
                setReadingOrder(val)
                return
              }

              try {
                await reorderPageTextNodes(page.id, val)
                setReadingOrder(val)
              } catch (err) {
                console.error('[reorder] Failed to reorder text nodes:', err)
                useEditorUiStore.getState().showError(String(err))
              }
            }}
          >
            <SelectTrigger
              className='h-5 w-32 gap-1 border-none bg-transparent px-1.5 text-[10px] font-semibold uppercase hover:bg-accent focus:ring-0'
              aria-label={t('textBlocks.readingOrder')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='rtl' className='text-[10px] font-semibold'>
                {t('textBlocks.readingOrderRtl')}
              </SelectItem>
              <SelectItem value='ltr' className='text-[10px] font-semibold'>
                {t('textBlocks.readingOrderLtr')}
              </SelectItem>
              <SelectItem value='custom' className='text-[10px] font-semibold'>
                {t('textBlocks.readingOrderCustom')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <ScrollArea
        key={page.id}
        className='min-h-0 flex-1'
        viewportClassName='pb-1'
        data-testid='textblocks-scroll'
      >
        <div className='p-2'>
          {orderedNodes.length === 0 ? (
            <p className='rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground'>
              {t('textBlocks.none')}
            </p>
          ) : (
            <Accordion
              data-testid='textblocks-accordion'
              type='single'
              collapsible
              value={accordionValue}
              onValueChange={(value) => {
                if (!value) {
                  clearSelection()
                  return
                }
                const idx = Number(value)
                const node = textNodes[idx]
                if (node) select(node.id, false)
              }}
              className='flex flex-col gap-1'
            >
              {orderedNodes.map((node, index) => (
                <div
                  key={node.id}
                  draggable={readingOrder === 'custom'}
                  onDragStart={(e) => {
                    if (readingOrder !== 'custom') return
                    setDraggedId(node.id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(e) => {
                    if (readingOrder !== 'custom' || !draggedId) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    setDragOverId(node.id)
                  }}
                  onDrop={(e) => {
                    if (readingOrder !== 'custom' || !draggedId) return
                    e.preventDefault()
                    const from = draggedId
                    setDraggedId(null)
                    setDragOverId(null)
                    void handleReorder(from, node.id)
                  }}
                  onDragEnd={() => {
                    setDraggedId(null)
                    setDragOverId(null)
                  }}
                  className={
                    dragOverId === node.id && draggedId && draggedId !== node.id
                      ? 'ring-2 ring-primary rounded-md'
                      : ''
                  }
                >
                  <BlockCard
                    node={node}
                    index={index}
                    selected={selectedIds.has(node.id)}
                    onToggleSelect={() => select(node.id, true)}
                    onPatch={(patch) => void patchText(node.id, patch)}
                    onDelete={() => void removeNode(node.id)}
                    onGenerate={() => void generate(node.id)}
                    processing={isProcessing}
                    llmReady={llmReady}
                    ocrHighlights={
                      node.data.text
                        ? findTermRanges(node.data.text, glossaries, activeGlossaryIds)
                        : undefined
                    }
                    autocompleteTerms={autocompleteTerms}
                    onAddToGlossary={(src) => addToGlossary(src)}
                  />
                </div>
              ))}
            </Accordion>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

type BlockCardProps = {
  node: TextNodeEntry
  index: number
  selected: boolean
  onToggleSelect: () => void
  onPatch: (patch: TextDataPatch) => void
  onDelete: () => void
  onGenerate: () => void
  processing: boolean
  llmReady: boolean
  /** Glossary-term highlight ranges for the OCR field. */
  ocrHighlights?: { start: number; end: number }[]
  /** Autocomplete suggestions for the translation field. */
  autocompleteTerms?: string[]
  /** Called when the user adds the selected OCR text to the glossary. */
  onAddToGlossary?: (source: string) => void
}

function BlockCard({
  node,
  index,
  selected,
  onToggleSelect,
  onPatch,
  onDelete,
  onGenerate,
  processing,
  llmReady,
  ocrHighlights,
  autocompleteTerms,
  onAddToGlossary,
}: BlockCardProps) {
  const { t } = useTranslation()
  const data = node.data
  const hasOcr = !!data.text?.trim()
  const hasTranslation = !!data.translation?.trim()
  const preview = data.translation?.trim() || data.text?.trim()

  // Ref to the OCR textarea for "add selection to glossary".
  const ocrRef = useRef<HTMLTextAreaElement | null>(null)
  const [addingTerm, setAddingTerm] = useState(false)
  const [termTarget, setTermTarget] = useState('')

  const handleAddTerm = () => {
    if (!ocrRef.current) return
    const el = ocrRef.current
    const sel = el.value.substring(el.selectionStart ?? 0, el.selectionEnd ?? 0).trim()
    const source = sel || (data.text ?? '').trim()
    if (!source || !onAddToGlossary) return
    onAddToGlossary(source)
    setTermTarget('')
    setAddingTerm(false)
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <motion.div
          data-testid={`textblock-card-${index}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, delay: index * 0.03 }}
        >
          <AccordionItem
        value={index.toString()}
        data-selected={selected}
        className='overflow-hidden rounded-md bg-card/90 text-xs ring-1 ring-border data-[selected=true]:ring-primary'
      >
        <AccordionTrigger
          onClick={(e) => {
            if (e.shiftKey || e.ctrlKey || e.metaKey) {
              e.preventDefault()
              e.stopPropagation()
              onToggleSelect()
            }
          }}
          className='flex w-full cursor-pointer items-center gap-1.5 px-2 py-1.5 text-left transition outline-none hover:no-underline data-[state=open]:bg-accent [&>svg]:hidden'
        >
          <span
            className={`shrink-0 rounded-md px-1.5 py-0.5 text-center text-[10px] font-medium text-white tabular-nums ${
              selected ? 'bg-primary' : 'bg-muted-foreground/60'
            }`}
            style={{ minWidth: '1.5rem' }}
          >
            {index + 1}
          </span>
          <div className='flex min-w-0 flex-1 items-center gap-1'>
            <span
              className={`shrink-0 rounded-sm px-1 py-0.5 text-[9px] font-medium uppercase ${
                hasOcr ? 'bg-primary/70 text-white' : 'bg-muted text-muted-foreground/50'
              }`}
            >
              {t('textBlocks.ocrBadge')}
            </span>
            <span
              className={`shrink-0 rounded-sm px-1 py-0.5 text-[9px] font-medium uppercase ${
                hasTranslation ? 'bg-primary/70 text-white' : 'bg-muted text-muted-foreground/50'
              }`}
            >
              {t('textBlocks.translationBadge')}
            </span>
            {preview && (
              <p className='line-clamp-1 min-w-0 flex-1 text-xs text-muted-foreground'>{preview}</p>
            )}
          </div>
        </AccordionTrigger>
        <AccordionContent className='px-2 pt-1.5 pb-2 shadow-[inset_0_1px_0_0_var(--color-border)]'>
          <div className='space-y-1.5'>
            <div className='flex flex-col gap-0.5'>
              <div className='flex items-center justify-between'>
                <span className='text-[10px] text-muted-foreground'>
                  {t('textBlocks.ocrLabel')}
                </span>
                {onAddToGlossary && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant='ghost'
                        size='icon-xs'
                        className='size-5'
                        disabled={!hasOcr}
                        onClick={() => {
                          const el = ocrRef.current
                          if (el) {
                            const sel = el.value.substring(el.selectionStart ?? 0, el.selectionEnd ?? 0).trim()
                            if (sel) {
                              onAddToGlossary(sel)
                            } else {
                              setAddingTerm((v) => !v)
                            }
                          } else {
                            setAddingTerm((v) => !v)
                          }
                        }}
                      >
                        <BookPlusIcon className='size-3' />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side='left' sideOffset={4}>
                      {t('glossary.addFromBlock')}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              <DraftTextarea
                ref={ocrRef}
                data-testid={`textblock-ocr-${index}`}
                value={data.text ?? ''}
                placeholder={t('textBlocks.addOcrPlaceholder')}
                rows={2}
                onValueChange={(value) => onPatch({ text: value })}
                highlights={ocrHighlights}
                className='min-h-0 resize-none px-1.5 py-1 text-xs'
              />
              {addingTerm && (
                <div className='flex items-center gap-1'>
                  <Input
                    autoFocus
                    value={termTarget}
                    onChange={(e) => setTermTarget(e.target.value)}
                    placeholder={t('glossary.addFromBlockPrompt', { source: (data.text ?? '').trim().slice(0, 20) })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && termTarget.trim()) handleAddTerm()
                      else if (e.key === 'Escape') setAddingTerm(false)
                    }}
                    className='h-6 px-1.5 text-[11px]'
                  />
                  <Button size='icon-xs' className='size-6 shrink-0' onClick={handleAddTerm} disabled={!termTarget.trim()}>
                    <PlusIcon className='size-3' />
                  </Button>
                </div>
              )}
            </div>
            <div className='flex flex-col gap-0.5'>
              <div className='flex items-center justify-between'>
                <span className='text-[10px] text-muted-foreground'>
                  {t('textBlocks.translationLabel')}
                </span>
                <div className='flex items-center gap-0.5'>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        data-testid={`textblock-delete-${index}`}
                        aria-label={t('workspace.deleteBlock')}
                        variant='ghost'
                        size='icon-xs'
                        disabled={processing}
                        onClick={onDelete}
                        className='size-5 text-destructive hover:text-destructive'
                      >
                        <Trash2Icon className='size-3' />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side='left' sideOffset={4}>
                      {t('workspace.deleteBlock')}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        data-testid={`textblock-generate-${index}`}
                        aria-label={t('llm.generateTooltip')}
                        variant='ghost'
                        size='icon-xs'
                        disabled={!llmReady || processing}
                        onClick={onGenerate}
                        className='size-5'
                      >
                        {processing ? (
                          <LoaderCircleIcon className='size-3 animate-spin' />
                        ) : (
                          <Languages className='size-3' />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side='left' sideOffset={4}>
                      {t('llm.generateTooltip')}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <DraftTextarea
                data-testid={`textblock-translation-${index}`}
                value={data.translation ?? ''}
                placeholder={t('textBlocks.addTranslationPlaceholder')}
                rows={2}
                onValueChange={(value) => onPatch({ translation: value })}
                autocompleteTerms={autocompleteTerms}
                className='min-h-0 resize-none px-1.5 py-1 text-xs'
              />
            </div>
          </div>
        </AccordionContent>
          </AccordionItem>
        </motion.div>
      </ContextMenuTrigger>
      <ContextMenuContent className='min-w-44'>
        <ContextMenuItem
          disabled={!llmReady || processing}
          onSelect={() => onGenerate()}
        >
          <Languages className='mr-2 size-3.5' />
          {t('llm.generateTooltip')}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasOcr}
          onSelect={() => onAddToGlossary?.(data.text ?? '')}
        >
          <BookPlusIcon className='mr-2 size-3.5' />
          {t('glossary.addFromBlock')}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasTranslation}
          onSelect={() => void copyToClipboard(data.translation ?? '')}
        >
          <ClipboardCopyIcon className='mr-2 size-3.5' />
          {t('common.copyTranslation')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant='destructive' onSelect={onDelete}>
          <Trash2Icon className='mr-2 size-3.5' />
          {t('workspace.deleteBlock')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
