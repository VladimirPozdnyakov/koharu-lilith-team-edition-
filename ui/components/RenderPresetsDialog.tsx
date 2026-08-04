'use client'

import {
  CopyIcon,
  DownloadIcon,
  PencilIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react'
import { useState } from 'react'
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
import type { RenderPreset } from '@/lib/stores/renderPresetsStore'
import { useRenderPresetsStore } from '@/lib/stores/renderPresetsStore'
import {
  exportUserData,
  exportUserDataCollection,
  importUserData,
} from '@/lib/io/userDataIo'

function sanitizeFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '-')
  return cleaned.length > 0 ? cleaned : 'preset'
}

export function RenderPresetsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const presets = useRenderPresetsStore((s) => s.presets)
  const updatePreset = useRenderPresetsStore((s) => s.updatePreset)
  const removePreset = useRenderPresetsStore((s) => s.removePreset)
  const duplicatePreset = useRenderPresetsStore((s) => s.duplicatePreset)
  const importPresets = useRenderPresetsStore((s) => s.importPresets)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  const commitRename = (id: string) => {
    const name = draftName.trim()
    if (name) updatePreset(id, { name })
    setEditingId(null)
    setDraftName('')
  }

  const handleImport = async () => {
    const incoming = await importUserData<RenderPreset[]>()
    if (!incoming || !Array.isArray(incoming)) return
    importPresets(incoming)
  }

  const handleExportOne = async (preset: RenderPreset) => {
    await exportUserData(preset, sanitizeFileName(preset.name))
  }

  const handleExportAll = async () => {
    if (presets.length === 0) return
    await exportUserDataCollection(presets, 'render-presets')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex h-[480px] max-h-[85vh] w-[520px] max-w-[92vw] flex-col gap-0 overflow-hidden p-0'>
        <DialogTitle className='sr-only'>{t('render.presetManage')}</DialogTitle>
        <DialogDescription className='sr-only'>{t('render.presetManageDescription')}</DialogDescription>

        <div className='flex items-center justify-between border-b border-border px-4 py-3'>
          <span className='text-sm font-medium'>{t('render.presetManage')}</span>
          <div className='flex items-center gap-1'>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='outline'
                  size='icon-sm'
                  className='size-7'
                  disabled={presets.length === 0}
                  aria-label={t('render.presetExportAll')}
                  onClick={() => void handleExportAll()}
                >
                  <DownloadIcon className='size-3.5' />
                </Button>
              </TooltipTrigger>
              <TooltipContent side='bottom'>{t('render.presetExportAll')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='outline'
                  size='icon-sm'
                  className='size-7'
                  aria-label={t('render.presetImport')}
                  onClick={() => void handleImport()}
                >
                  <UploadIcon className='size-3.5' />
                </Button>
              </TooltipTrigger>
              <TooltipContent side='bottom'>{t('render.presetImport')}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <ScrollArea className='min-h-0 flex-1'>
          {presets.length === 0 ? (
            <div className='flex h-full items-center justify-center px-6 py-12 text-center text-sm text-muted-foreground'>
              {t('render.presetEmpty')}
            </div>
          ) : (
            <ul className='divide-y divide-border'>
              {presets.map((preset) => (
                <li
                  key={preset.id}
                  className='flex items-center gap-2 px-4 py-2'
                >
                  {editingId === preset.id ? (
                    <Input
                      autoFocus
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(preset.id)
                        else if (e.key === 'Escape') {
                          setEditingId(null)
                          setDraftName('')
                        }
                      }}
                      onBlur={() => commitRename(preset.id)}
                      className='h-7 flex-1 text-sm'
                    />
                  ) : (
                    <span className='flex-1 truncate text-sm'>{preset.name}</span>
                  )}

                  <div className='flex shrink-0 items-center gap-0.5'>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant='ghost'
                          size='icon-xs'
                          className='size-6'
                          aria-label={t('render.presetExportOne')}
                          onClick={() => void handleExportOne(preset)}
                        >
                          <DownloadIcon className='size-3.5' />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side='bottom'>{t('render.presetExportOne')}</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant='ghost'
                          size='icon-xs'
                          className='size-6'
                          aria-label={t('render.presetRename')}
                          onClick={() => {
                            setEditingId(preset.id)
                            setDraftName(preset.name)
                          }}
                        >
                          <PencilIcon className='size-3.5' />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side='bottom'>{t('render.presetRename')}</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant='ghost'
                          size='icon-xs'
                          className='size-6'
                          aria-label={t('render.presetDuplicate')}
                          onClick={() => duplicatePreset(preset.id)}
                        >
                          <CopyIcon className='size-3.5' />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side='bottom'>{t('render.presetDuplicate')}</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant='ghost'
                          size='icon-xs'
                          className='size-6 text-destructive hover:text-destructive'
                          aria-label={t('render.presetDelete')}
                          onClick={() => removePreset(preset.id)}
                        >
                          <Trash2Icon className='size-3.5' />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side='bottom'>{t('render.presetDelete')}</TooltipContent>
                    </Tooltip>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
