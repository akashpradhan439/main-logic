-- Add bio + interests fields to users table for AI connection suggestions
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS interests text[] NOT NULL DEFAULT '{}';
