# Messaging API Documentation

All messaging endpoints require a valid JWT `Authorization: Bearer <token>` header, except for the WebSocket handshake which uses a dedicated short-lived token.

---

## 🔐 Authentication & Security

### POST `/messaging/ws-token`
Generates a short-lived token for WebSocket authentication to prevent exposing the main JWT in URLs/logs.

**Success (200 OK)**
```json
{
  "success": true,
  "token": "eyJhbG..." // Valid for 60 seconds
}
```

**Failure (401 Unauthorized)**
```json
{ "success": false, "error": "Authentication required" }
```

---

## 💬 Conversations

### POST `/messaging/conversations`
Initiates or retrieves a 1:1 conversation with another user.

**Request Body**
```json
{ "otherUserId": "uuid-of-recipient" }
```

**Success (201 Created / 200 OK)**
```json
{
  "success": true,
  "conversation": {
    "id": "conv-uuid",
    "participant_one": "uuid-1",
    "participant_two": "uuid-2",
    "created_at": "ISO-TIMESTAMP",
    "updated_at": "ISO-TIMESTAMP"
  }
}
```

**Failure (403 Forbidden - Blocked or Not Connected)**
```json
{ "success": false, "error": "You must be connected with this user to message them" }
```

---

### GET `/messaging/conversations`
Returns a list of all conversations involving the authenticated user.

**Success (200 OK)**
```json
{
  "success": true,
  "conversations": [
    {
      "id": "conv-uuid",
      "otherUserId": "recipient-uuid",
      "createdAt": "ISO-TIMESTAMP",
      "updatedAt": "ISO-TIMESTAMP"
    }
  ]
}
```

---

## 📜 Message History

### GET `/messaging/conversations/:id/messages`
Fetches paginated messages using cursor-based pagination.

**Query Parameters**
- `cursor`: (Optional) ISO timestamp of the last message received to fetch older messages.
- [limit](file:///c:/Users/akash/OneDrive/Desktop/main-logic/tests/connections-qr-scan.test.ts#74-81): (Optional, default: 20, max: 100) Number of messages to return.

**Success (200 OK)**
```json
{
  "success": true,
  "messages": [
    {
      "id": "msg-uuid",
      "conversation_id": "conv-uuid",
      "sender_id": "user-uuid",
      "content": "Hello world!",
      "attachment_url": null,
      "attachment_type": null,
      "created_at": "ISO-TIMESTAMP"
    }
  ],
  "nextCursor": "ISO-TIMESTAMP-OF-LAST-ITEM"
}
```

**Failure (403 Forbidden - Not a participant or Blocked)**
```json
{ "success": false, "error": "You cannot view messages for this conversation" }
```

---

## ⚡ Real-time (WebSocket)

### GET `/messaging/ws?token=<wsToken>`
Establishes a WebSocket connection for real-time messaging.

**Handshake**
- `token`: Short-lived token obtained via `POST /messaging/ws-token`.

**Incoming (Client -> Server)**
```json
{
  "type": "send_message",
  "conversationId": "uuid",
  "content": "Message text",
  "attachmentUrl": "https://...", // Optional
  "attachmentType": "image/png" // Optional
}
```

**Outgoing (Server -> Client)**
- `type: "new_message"`: When a new message arrives.
- `type: "message_ack"`: Acknowledgment for a message sent by the client.
- `type: "error"`: Validation or security error.

**Error Example (Blocked while connected)**
```json
{
  "type": "error",
  "message": "You cannot send messages to this user"
}
```

---

## 📻 Real-time Conversation Updates (SSE)

### GET `/messaging/conversations/stream?token=<wsToken>`
Stays connected to receive real-time updates when the conversation list changes.

**Handshake**
- `token`: Short-lived token obtained via `POST /messaging/ws-token`.

**Events**
- `type: "conversation_updated"`: Sent when a new message arrives in any conversation or a new conversation is created.

**Payload Example**
```json
{ "type": "conversation_updated" }
```
