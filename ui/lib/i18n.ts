'use client'

import i18n, { type Resource } from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import LocalStorageBackend from 'i18next-localstorage-backend'
import { initReactI18next } from 'react-i18next'

import enUS from '@/public/locales/en-US/translation.json'
import ruRU from '@/public/locales/ru-RU/translation.json'

export const resources = {
  'en-US': { translation: enUS },
  'ru-RU': { translation: ruRU },
} satisfies Resource

export type SupportedLanguage = keyof typeof resources

export const supportedLanguages = Object.keys(resources) as SupportedLanguage[]

i18n
  .use(LocalStorageBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en-US',
    interpolation: {
      escapeValue: false, // not needed for react as it escapes by default
    },
    react: {
      useSuspense: false,
    },
  })

export default i18n
