import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Copy text to the clipboard. No-op if the clipboard API is unavailable. */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text)
    }
  } catch {
    // Silently ignore clipboard errors — not critical.
  }
}
