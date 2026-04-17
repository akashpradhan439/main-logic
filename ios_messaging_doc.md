# iOS Messaging API Documentation (Phase 1)

This document details the messaging-related APIs for the iOS client, covering authentication, conversation management, message history, and real-time communication via WebSockets.

## 🔐 Authentication (WebSocket Token)

To establish a WebSocket connection or SSE stream, you first need a short-lived WebSocket token. This avoids passing your primary JWT in URL query parameters.

### POST `/messaging/ws-token`

**Headers:**
- `Authorization: Bearer <JWT_ACCESS_TOKEN>`

**Response (200 OK):**
```json
{
  "success": true,
  "token": "SHORT_LIVED_WS_TOKEN"
}
```

---

## 💬 Conversations

### Create or Get Conversation
Initiates a 1:1 conversation with another user. If a conversation already exists, it returns the existing one.

**POST `/messaging/conversations`**

**Headers:**
- `Authorization: Bearer <JWT_ACCESS_TOKEN>`

**Body:**
```json
{
  "otherUserId": "UUID_OF_THE_OTHER_USER"
}
```

**Response (201 Created or 200 OK):**
```json
{
  "success": true,
  "conversation": {
    "id": "CONVERSATION_UUID",
    "otherUserId": "OTHER_USER_UUID",
    "createdAt": "ISO8601_TIMESTAMP",
    "updatedAt": "ISO8601_TIMESTAMP"
  }
}
```

### List Conversations
Returns a list of all conversations for the authenticated user, including the last message in each.

**GET `/messaging/conversations`**

**Headers:**
- `Authorization: Bearer <JWT_ACCESS_TOKEN>`

**Response (200 OK):**
```json
{
  "success": true,
  "conversations": [
    {
      "id": "CONVERSATION_UUID",
      "otherUserId": "OTHER_USER_UUID",
      "otherUserFirstName": "John",
      "otherUserLastName": "Doe",
      "createdAt": "ISO8601_TIMESTAMP",
      "updatedAt": "ISO8601_TIMESTAMP",
      "lastMessage": {
        "id": "MESSAGE_UUID",
        "envelope": "BASE64_ENCODED_PROTOBUF_ENVELOPE",
        "senderId": "SENDER_UUID",
        "createdAt": "ISO8601_TIMESTAMP",
        "attachmentUrl": null,
        "attachmentType": null
      }
    }
  ]
}
```

---

## 📜 Message History

### Get Messages
Fetches paginated messages for a specific conversation.

**GET `/messaging/conversations/:id/messages`**

**Parameters:**
- `cursor`: (Query, Optional) The `createdAt` timestamp of the last message from the previous page to fetch older messages.
- `limit`: (Query, Optional, Default: 20) Number of messages to return.

**Headers:**
- `Authorization: Bearer <JWT_ACCESS_TOKEN>`

**Response (200 OK):**
```json
{
  "success": true,
  "messages": [
    {
      "id": "MESSAGE_UUID",
      "conversation_id": "CONVERSATION_UUID",
      "sender_id": "SENDER_UUID",
      "envelope": "BASE64_ENCODED_PROTOBUF_ENVELOPE",
      "attachment_url": null,
      "attachment_type": null,
      "created_at": "ISO8601_TIMESTAMP"
    }
  ],
  "nextCursor": "ISO8601_TIMESTAMP_FOR_NEXT_PAGE"
}
```

---

## ⚡ Real-time Messaging (WebSocket)

**The WebSocket connection is the single source of truth for all real-time events.** You should establish **one single, persistent connection** for the entire app session. This connection is **not per-conversation**. All messages and conversation updates are multiplexed through this same socket.

### Conversation Lifecycle
When a user opens a specific conversation in the UI:
1.  **Do NOT** open a new WebSocket.
2.  **Fetch History**: Call `GET /messaging/conversations/:id/messages` via REST to load existing messages.
3.  **Real-time Updates**: Listen to the existing **global** WebSocket. New messages and updates for *any* conversation will arrive there; your client-side logic should route them to the correct chat view or update the inbox list based on the `type` and `conversationId`.

**Endpoint:** `GET /messaging/ws?token=<WS_TOKEN>`

### Incoming Event Types (Server -> Client)

#### 1. New Message (`new_message`)
Broadcasted when a new message is received in any conversation. Use this to update an active chat view or the "last message" in your inbox.

```json
{
  "type": "new_message",
  "messageId": "MESSAGE_UUID",
  "conversationId": "CONVERSATION_UUID",
  "senderId": "SENDER_UUID",
  "envelope": {
    "type": "Buffer",
    "data": [10, 34, 18, ...]
  },
  "attachmentUrl": null,
  "attachmentType": null,
  "createdAt": "ISO8601_TIMESTAMP"
}
```

#### 2. Conversation Created (`conversation_created`)
Broadcasted when a new conversation is initiated with you. Use this to add a new entry to your inbox list.

```json
{
  "type": "conversation_created",
  "conversationId": "CONVERSATION_UUID"
}
```

#### 3. Message Acknowledgment (`message_ack`)
Sent after the server successfully receives and persists an outgoing message:

```json
{
  "type": "message_ack",
  "messageId": "MESSAGE_UUID",
  "conversationId": "CONVERSATION_UUID",
  "createdAt": "ISO8601_TIMESTAMP"
}
```

#### 4. Error (`error`)
The server may send error messages if validation or security checks fail:

```json
{
  "type": "error",
  "message": "Localized error message"
}
```

---

## 📻 Real-time Inbox Updates (SSE - Optional)

For lightweight use cases where you only need conversation list updates without full WebSocket capabilities, you can use Server-Sent Events. However, the **WebSocket is recommended** as it receives all the same events.

**GET `/messaging/conversations/stream?token=<WS_TOKEN>`**

### Outgoing Message (Client -> Server)
To send a message, send a JSON object over the WebSocket:

```json
{
  "type": "send_message",
  "conversationId": "CONVERSATION_UUID",
  "envelope": {
    "header": {
      "dhPublicKey": "BASE64_ENCODED_PUBLIC_KEY",
      "n": 0,
      "pn": 0
    },
    "ciphertext": "BASE64_ENCODED_CIPHERTEXT"
  },
  "attachmentUrl": null,
  "attachmentType": null
}
```

### Incoming Message (Server -> Client)
The server broadcasts new messages to participants. Note that `envelope` in the real-time broadcast is the binary Protobuf-encoded envelope, which Node.js serializes to a JSON object when using `JSON.stringify`.

```json
{
  "type": "new_message",
  "messageId": "MESSAGE_UUID",
  "conversationId": "CONVERSATION_UUID",
  "senderId": "SENDER_UUID",
  "envelope": {
    "type": "Buffer",
    "data": [10, 34, 18, ...]
  },
  "attachmentUrl": null,
  "attachmentType": null,
  "createdAt": "ISO8601_TIMESTAMP"
}
```

### Message Acknowledgment (Server -> Client)
Sent after the server successfully receives and persists an outgoing message:

```json
{
  "type": "message_ack",
  "messageId": "MESSAGE_UUID",
  "conversationId": "CONVERSATION_UUID",
  "createdAt": "ISO8601_TIMESTAMP"
}
```


## 📱 Swift WebSocket Example

Below is a robust implementation using `URLSessionWebSocketTask`.

```swift
import Foundation

enum MessagingError: Error {
    case connectionFailed
    case authenticationError
}

class MessagingClient: NSObject, URLSessionWebSocketDelegate {
    private var webSocket: URLSessionWebSocketTask?
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    /// Connects to the global messaging WebSocket.
    /// This should be called once when the app starts or the user logs in.
    func connect(wsToken: String) {
        let url = URL(string: "wss://api.yourdomain.com/messaging/ws?token=\(wsToken)")!
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: OperationQueue())
        webSocket = session.webSocketTask(with: url)
        webSocket?.resume()

        receiveMessage()
    }

    func disconnect() {
        webSocket?.cancel(with: .goingAway, reason: nil)
    }

    private func receiveMessage() {
        webSocket?.receive { [weak self] result in
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self?.handleIncomingJSON(text)
                case .data(let data):
                    print("Received binary data: \(data)")
                @unknown default:
                    break
                }
                self?.receiveMessage() // Listen for next message
            case .failure(let error):
                print("WebSocket error: \(error)")
            }
        }
    }

    private func handleIncomingJSON(_ jsonString: String) {
        guard let data = jsonString.data(using: .utf8) else { return }
        // Parse your custom message types here
        print("Received: \(jsonString)")
    }

    func sendMessage(conversationId: String, ciphertext: Data, publicKey: Data) {
        // The server expects dhPublicKey and ciphertext.
        // If sending as JSON, these should be base64 strings or arrays.
        let payload: [String: Any] = [
            "type": "send_message",
            "conversationId": conversationId,
            "envelope": [
                "header": [
                    "dhPublicKey": publicKey.base64EncodedString(),
                    "n": 0,
                    "pn": 0
                ],
                "ciphertext": ciphertext.base64EncodedString()
            ],
            "attachmentUrl": NSNull(),
            "attachmentType": NSNull()
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let jsonString = String(data: data, encoding: .utf8) else { return }

        webSocket?.send(.string(jsonString)) { error in
            if let error = error {
                print("Send error: \(error)")
            }
        }
    }

    // URLSessionWebSocketDelegate methods
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        print("WebSocket Connected")
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        print("WebSocket Disconnected")
    }
}
```
