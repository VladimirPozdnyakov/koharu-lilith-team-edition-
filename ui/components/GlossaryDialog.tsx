'use client'

import {
  BookPlusIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Glossary } from '@/lib/stores/glossariesStore'
import { useGlossariesStore } from '@/lib/stores/glossariesStore'
import {
  exportUserData,
  exportUserDataCollection,
  importUserData,
} from '@/lib/io/userDataIo'
import { cn } from '@/lib/utils'

function sanitizeFileName(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '-')
  return cleaned.length > 0 ? cleaned : 'glossary'
}

export function GlossaryDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const glossaries = useGlossariesStore((s) => s.glossaries)
  const activeGlossaryIds = useGlossariesStore((s) => s.activeGlossaryIds)
  const addGlossary = useGlossariesStore((s) => s.addGlossary)
  const removeGlossary = useGlossariesStore((s) => s.removeGlossary)
  const duplicateGlossary = useGlossariesStore((s) => s.duplicateGlossary)
  const toggleActive = useGlossariesStore((s) => s.toggleActive)
  const addEntry = useGlossariesStore((s) => s.addEntry)
  const removeEntry = useGlossariesStore((s) => s.removeEntry)
  const updateEntry = useGlossariesStore((s) => s.updateEntry)
  const importGlossaries = useGlossariesStore((s) => s.importGlossaries)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newSrc, setNewSrc] = useState('')
  const [newTgt, setNewTgt] = useState('')

  // Auto-select the first glossary when opening / when current selection removed.
  const effectiveSelectedId = useMemo(() => {
    if (selectedId && glossaries.some((g) => g.id === selectedId)) return selectedId
    return glossaries[0]?.id ?? null
  }, [selectedId, glossaries])

  const selected = glossaries.find((g) => g.id === effectiveSelectedId) ?? null

  const handleImport = async () => {
    const incoming = await importUserData<Glossary[]>()
    if (!incoming || !Array.isArray(incoming)) return
    importGlossaries(incoming)
  }

  const handleExportOne = async (g: Glossary) => {
    await exportUserData(g, sanitizeFileName(g.name))
  }

  const handleExportAll = async () => {
    if (glossaries.length === 0) return
    await exportUserDataCollection(glossaries, 'glossaries')
  }

  const handleAddEntry = () => {
    if (!selected) return
    const src = newSrc.trim()
    const tgt = newTgt.trim()
    if (!src || !tgt) return
    addEntry(selected.id, src, tgt)
    setNewSrc('')
    setNewTgt('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex h-[560px] max-h-[88vh] w-[720px] max-w-[94vw] flex-col gap-0 overflow-hidden p-0'>
        <DialogTitle className='sr-only'>{t('glossary.title')}</DialogTitle>
        <DialogDescription className='sr-only'>{t('glossary.title')}</DialogDescription>

        {/* Toolbar */}
        <div className='flex items-center justify-between border-b border-border px-4 py-3'>
          <span className='text-sm font-medium'>{t('glossary.title')}</span>
          <div className='flex items-center gap-1'>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant='outline' size='icon-sm' className='size-7' aria-label={t('glossary.newGlossary')} onClick={() => addGlossary(t('glossary.defaultName'))}>
                  <BookPlusIcon className='size-3.5' />
                </Button>
              </TooltipTrigger>
              <TooltipContent side='bottom'>{t('glossary.newGlossary')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='outline'
                  size='icon-sm'
                  className='size-7'
                  disabled={glossaries.length === 0}
                  aria-label={t('glossary.exportAll')}
                  onClick={() => void handleExportAll()}
                >
                  <DownloadIcon className='size-3.5' />
                </Button>
              </TooltipTrigger>
              <TooltipContent side='bottom'>{t('glossary.exportAll')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant='outline' size='icon-sm' className='size-7' aria-label={t('glossary.import')} onClick={() => void handleImport()}>
                  <UploadIcon className='size-3.5' />
                </Button>
              </TooltipTrigger>
              <TooltipContent side='bottom'>{t('glossary.import')}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className='flex min-h-0 flex-1'>
          {/* Glossary list */}
          <div className='flex w-[200px] shrink-0 flex-col border-r border-border'>
            <ScrollArea className='min-h-0 flex-1'>
              {glossaries.length === 0 ? (
                <p className='px-3 py-6 text-center text-xs text-muted-foreground'>
                  {t('glossary.empty')}
                </p>
              ) : (
                <ul>
                  {glossaries.map((g) => {
                    const active = activeGlossaryIds.includes(g.id)
                    const isSel = g.id === effectiveSelectedId
                    return (
                      <li
                        key={g.id}
                        role='button'
                        tabIndex={0}
                        aria-label={g.name}
                        className={cn(
                          'group flex items-center gap-1.5 px-2 py-1.5 text-xs cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                          isSel ? 'bg-accent' : 'hover:bg-accent/50',
                        )}
                        onClick={() => setSelectedId(g.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setSelectedId(g.id)
                          }
                        }}
                      >
                        <button
                          type='button'
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleActive(g.id)
                          }}
                          className={cn(
                            'flex size-4 shrink-0 items-center justify-center rounded border',
                            active
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border bg-transparent',
                          )}
                          aria-label={active ? t('glossary.deactivate') : t('glossary.activate')}
                        >
                          {active && <CheckIcon className='size-3' />}
                        </button>
                        <span className='flex-1 truncate'>{g.name}</span>
                        <span className='shrink-0 text-[10px] text-muted-foreground'>
                          {g.entries.length}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </ScrollArea>
          </div>

          {/* Entries of selected glossary */}
          <div className='flex min-w-0 flex-1 flex-col'>
            {selected ? (
              <>
                <div className='flex items-center justify-between gap-2 border-b border-border px-3 py-2'>
                  <span className='truncate text-xs font-medium'>{selected.name}</span>
                  <div className='flex shrink-0 items-center gap-0.5'>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant='ghost' size='icon-xs' className='size-6' aria-label={t('glossary.exportOne')} onClick={() => void handleExportOne(selected)}>
                          <DownloadIcon className='size-3.5' />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side='bottom'>{t('glossary.exportOne')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant='ghost' size='icon-xs' className='size-6' aria-label={t('glossary.duplicate')} onClick={() => duplicateGlossary(selected.id)}>
                          <CopyIcon className='size-3.5' />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side='bottom'>{t('glossary.duplicate')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant='ghost'
                          size='icon-xs'
                          className='size-6 text-destructive hover:text-destructive'
                          aria-label={t('glossary.delete')}
                          onClick={() => {
                            removeGlossary(selected.id)
                            setSelectedId(null)
                          }}
                        >
                          <Trash2Icon className='size-3.5' />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side='bottom'>{t('glossary.delete')}</TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                <ScrollArea className='min-h-0 flex-1'>
                  <table className='w-full text-xs'>
                    <thead className='sticky top-0 bg-card text-[10px] font-medium text-muted-foreground uppercase'>
                      <tr>
                        <th className='px-2 py-1.5 text-left'>{t('glossary.source')}</th>
                        <th className='px-2 py-1.5 text-left'>{t('glossary.target')}</th>
                        <th className='w-8' />
                      </tr>
                    </thead>
                    <tbody>
                      {selected.entries.length === 0 ? (
                        <tr>
                          <td colSpan={3} className='px-2 py-6 text-center text-muted-foreground'>
                            {t('glossary.noEntries')}
                          </td>
                        </tr>
                      ) : (
                        selected.entries.map((e, i) => (
                          <tr key={i} className='border-t border-border align-top'>
                            <td className='px-1.5 py-1'>
                              <Input
                                value={e.source}
                                onChange={(ev) => updateEntry(selected.id, i, { source: ev.target.value })}
                                className='h-7 px-1.5 text-xs'
                              />
                            </td>
                            <td className='px-1.5 py-1'>
                              <Input
                                value={e.target}
                                onChange={(ev) => updateEntry(selected.id, i, { target: ev.target.value })}
                                className='h-7 px-1.5 text-xs'
                              />
                            </td>
                            <td className='px-1 py-1 text-center'>
                              <Button
                                variant='ghost'
                                size='icon-xs'
                                className='size-6 text-destructive hover:text-destructive'
                                aria-label={t('common.delete')}
                                onClick={() => removeEntry(selected.id, i)}
                              >
                                <Trash2Icon className='size-3' />
                              </Button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </ScrollArea>

                {/* Add new entry */}
                <div className='flex items-center gap-1.5 border-t border-border px-2 py-2'>
                  <Input
                    value={newSrc}
                    onChange={(e) => setNewSrc(e.target.value)}
                    placeholder={t('glossary.source')}
                    className='h-7 flex-1 px-2 text-xs'
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddEntry()
                    }}
                  />
                  <Input
                    value={newTgt}
                    onChange={(e) => setNewTgt(e.target.value)}
                    placeholder={t('glossary.target')}
                    className='h-7 flex-1 px-2 text-xs'
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddEntry()
                    }}
                  />
                  <Button size='icon-sm' className='size-7 shrink-0' aria-label={t('glossary.addTerm')} onClick={handleAddEntry} disabled={!newSrc.trim() || !newTgt.trim()}>
                    <PlusIcon className='size-3.5' />
                  </Button>
                </div>
              </>
            ) : (
              <div className='flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground'>
                {t('glossary.selectOrCreate')}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
