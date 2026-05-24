-- Adds user-configured display/AI language preference.
-- Codes mirror the supported i18n locales in lib/i18n.ts.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS language_preference text NOT NULL DEFAULT 'en';

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_language_preference_check;

ALTER TABLE users
  ADD CONSTRAINT users_language_preference_check
  CHECK (language_preference IN (
    'en', 'ar', 'bn', 'es', 'fr', 'hi', 'ja', 'pt', 'ru', 'zh-Hans', 'zh-Hant'
  ));
