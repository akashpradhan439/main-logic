CREATE TABLE IF NOT EXISTS assistant_messages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content     text        NOT NULL,
  metadata    jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assistant_messages_user_created
  ON assistant_messages (user_id, created_at DESC);
