-- C2: The original constraint requires content or attachment_url, but E2EE messages
-- store ciphertext in the envelope column and leave content NULL. Update to allow
-- an envelope to satisfy the constraint.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS chk_message_has_content;

ALTER TABLE messages
  ADD CONSTRAINT chk_message_has_content
  CHECK (
    content        IS NOT NULL OR
    attachment_url IS NOT NULL OR
    envelope       IS NOT NULL
  );
