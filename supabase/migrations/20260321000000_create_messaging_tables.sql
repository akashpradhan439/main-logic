-- Conversations table for 1:1 messaging between connected users
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_one uuid NOT NULL,
  participant_two uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_conversation_pair UNIQUE (participant_one, participant_two),
  CONSTRAINT chk_participant_order CHECK (participant_one < participant_two)
);

-- Index for listing a user's conversations sorted by most recent activity
CREATE INDEX IF NOT EXISTS idx_conversations_participant_one
  ON conversations (participant_one, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_participant_two
  ON conversations (participant_two, updated_at DESC);

-- Messages table for individual messages within a conversation
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL,
  content text,
  attachment_url text,
  attachment_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_message_has_content CHECK (content IS NOT NULL OR attachment_url IS NOT NULL)
);

-- Index for paginated message history within a conversation
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at DESC);

-- Index for sender lookups
CREATE INDEX IF NOT EXISTS idx_messages_sender
  ON messages (sender_id, created_at DESC);
