'use client'

import * as React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Textarea } from '@/components/ui/textarea'

export type HighlightRange = { start: number; end: number }

export type DraftTextareaProps = Omit<
  React.ComponentProps<typeof Textarea>,
  'value' | 'onChange'
> & {
  value: string
  onValueChange: (value: string) => void
  /** Ranges to highlight in the text (glossary terms). */
  highlights?: HighlightRange[]
  /** Autocomplete suggestions; if non-empty, a popover is shown while typing. */
  autocompleteTerms?: string[]
  /** Called when the user picks an autocomplete suggestion. */
  onAutocompletePick?: (value: string) => void
}

/**
 * A textarea with IME-safe draft buffering, optional glossary-term
 * highlighting (transparent textarea over a mirrored `<mark>` layer), and
 * optional caret-anchored autocomplete.
 *
 * Forwards its ref to the underlying `<textarea>` so callers can read
 * `selectionStart` / `selectionEnd` (used by "add to glossary from block").
 */
export const DraftTextarea = React.forwardRef<
  HTMLTextAreaElement,
  DraftTextareaProps
>(function DraftTextarea(
  {
    value,
    onValueChange,
    onFocus,
    onBlur,
    onCompositionStart,
    onCompositionEnd,
    highlights,
    autocompleteTerms,
    onAutocompletePick,
    className,
    ...props
  },
  forwardedRef,
) {
  const [draftValue, setDraftValue] = useState(value)
  const isFocusedRef = useRef(false)
  const isComposingRef = useRef(false)
  const pendingCommitRef = useRef<string | null>(null)

  const innerRef = useRef<HTMLTextAreaElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const setRef = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node
      if (typeof forwardedRef === 'function') forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    },
    [forwardedRef],
  )

  const commitValue = (nextValue: string) => {
    pendingCommitRef.current = null
    onValueChange(nextValue)
  }

  useEffect(() => {
    lastExternalValueRef.current = value
    if (isFocusedRef.current || isComposingRef.current) return
    setDraftValue(value)
  }, [value])

  // --- Highlight overlay rendering ----------------------------------------
  const hasHighlights = highlights && highlights.length > 0

  // Build the highlighted HTML segments from draftValue + highlights.
  const overlayHtml = React.useMemo(() => {
    if (!hasHighlights) return ''
    const sorted = [...highlights].sort((a, b) => a.start - b.start)
    const parts: string[] = []
    let cursor = 0
    for (const range of sorted) {
      if (range.start < cursor || range.end > draftValue.length || range.end <= range.start) continue
      if (range.start > cursor) parts.push(escapeHtml(draftValue.slice(cursor, range.start)))
      parts.push(`<mark class="draft-highlight">${escapeHtml(draftValue.slice(range.start, range.end))}</mark>`)
      cursor = range.end
    }
    if (cursor < draftValue.length) parts.push(escapeHtml(draftValue.slice(cursor)))
    // Trailing newline keeps the overlay height matched to the textarea.
    return parts.join('') + (draftValue.endsWith('\n') ? '\u200b' : '')
  }, [draftValue, highlights, hasHighlights])

  // Keep overlay scroll in sync with textarea scroll.
  const syncScroll = () => {
    if (overlayRef.current && innerRef.current) {
      overlayRef.current.scrollTop = innerRef.current.scrollTop
      overlayRef.current.scrollLeft = innerRef.current.scrollLeft
    }
  }

  // --- Autocomplete --------------------------------------------------------
  const [showSuggest, setShowSuggest] = useState(false)
  const [currentWord, setCurrentWord] = useState('')

  const suggestions = React.useMemo(() => {
    if (!autocompleteTerms || !autocompleteTerms.length || !currentWord) return []
    const lower = currentWord.toLowerCase()
    const seen = new Set<string>()
    const out: string[] = []
    for (const term of autocompleteTerms) {
      const t = term.trim()
      if (t && t.toLowerCase().startsWith(lower) && !seen.has(t)) {
        seen.add(t)
        out.push(t)
        if (out.length >= 8) break
      }
    }
    return out
  }, [autocompleteTerms, currentWord])

  const replaceCurrentWord = (replacement: string) => {
    const el = innerRef.current
    if (!el) return
    const before = draftValue.slice(0, el.selectionStart)
    const after = draftValue.slice(el.selectionEnd)
    const wordStart = before.search(/[\S]+$/)
    const start = wordStart === -1 ? before.length : wordStart
    const next = before.slice(0, start) + replacement + after
    setDraftValue(next)
    commitValue(next)
    setShowSuggest(false)
    onAutocompletePick?.(replacement)
    // Place caret after the inserted word.
    requestAnimationFrame(() => {
      const pos = start + replacement.length
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  const updateCurrentWord = () => {
    const el = innerRef.current
    if (!el || !autocompleteTerms || !autocompleteTerms.length) {
      setShowSuggest(false)
      return
    }
    const before = draftValue.slice(0, el.selectionStart)
    const m = before.match(/[\S]+$/)
    const word = m ? m[0] : ''
    setCurrentWord(word)
    setShowSuggest(word.length >= 2)
  }

  const lastExternalValueRef = useRef(value)

  useLayoutEffect(() => {
    syncScroll()
  })

  return (
    <div className='relative'>
      {hasHighlights && (
        <div
          ref={overlayRef}
          aria-hidden
          className='pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-2 text-base md:text-sm'
          // Match textarea font metrics; text color transparent.
          dangerouslySetInnerHTML={{ __html: overlayHtml }}
        />
      )}
      <Textarea
        {...props}
        ref={setRef}
        value={draftValue}
        className={className}
        // Transparent text so the overlay shows through; caret stays visible.
        style={{
          ...(hasHighlights ? { color: 'transparent', caretColor: 'currentColor' } : {}),
          ...props.style,
        }}
        onFocus={(event) => {
          isFocusedRef.current = true
          onFocus?.(event)
        }}
        onBlur={(event) => {
          if (pendingCommitRef.current !== null) commitValue(pendingCommitRef.current)
          isComposingRef.current = false
          isFocusedRef.current = false
          // Delay hiding suggestions so a click on a suggestion still fires.
          setTimeout(() => setShowSuggest(false), 150)
          onBlur?.(event)
        }}
        onCompositionStart={(event) => {
          isComposingRef.current = true
          onCompositionStart?.(event)
        }}
        onCompositionEnd={(event) => {
          isComposingRef.current = false
          const committedValue = event.currentTarget.value
          setDraftValue(committedValue)
          commitValue(committedValue)
          onCompositionEnd?.(event)
        }}
        onChange={(event) => {
          const nextValue = event.target.value
          setDraftValue(nextValue)
          if (isComposingRef.current) {
            pendingCommitRef.current = nextValue
          } else {
            commitValue(nextValue)
          }
          updateCurrentWord()
          syncScroll()
        }}
        onKeyUp={updateCurrentWord}
        onClick={updateCurrentWord}
        onKeyDown={(event) => {
          if (showSuggest && suggestions.length > 0) {
            if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
              event.preventDefault()
              replaceCurrentWord(suggestions[0])
              return
            }
            if (event.key === 'Escape') {
              setShowSuggest(false)
              return
            }
          }
          props.onKeyDown?.(event)
        }}
        onScroll={syncScroll}
      />
      {showSuggest && suggestions.length > 0 && (
        <div className='absolute left-2 top-full z-50 mt-0.5 min-w-40 rounded-md border border-border bg-popover p-0.5 text-xs shadow-md'>
          {suggestions.map((s) => (
            <button
              key={s}
              type='button'
              onMouseDown={(e) => {
                // Prevent blur before click.
                e.preventDefault()
              }}
              onClick={() => replaceCurrentWord(s)}
              className='block w-full truncate rounded px-2 py-1 text-left hover:bg-accent'
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
