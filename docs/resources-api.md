# Resources API

**Base URL:** `/api/v1/resources`
**Authentication:** All endpoints require a valid JWT access token.

```
Authorization: Bearer <access_token>
```

---

## Resource object

Every endpoint that returns a resource (or list of resources) uses this shape:

```json
{
  "id": "uuid",
  "type": "document | textbook | image | audio | video | link",
  "title": "string",
  "description": "string | null",
  "fieldId": "uuid | null",
  "fileUrl": "string | null",
  "fileName": "string | null",
  "fileSize": "number | null",
  "mimeType": "string | null",
  "externalUrl": "string | null",
  "isProcessed": "boolean",
  "tags": ["string"],
  "createdAt": "ISO 8601 timestamp",
  "updatedAt": "ISO 8601 timestamp"
}
```

### Resource types

| `type` | Description | Accepted MIME types |
|--------|-------------|---------------------|
| `document` | PDF, Word, Excel, PowerPoint, plain text, CSV | `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/vnd.ms-powerpoint`, `application/vnd.openxmlformats-officedocument.presentationml.presentation`, `text/plain`, `text/csv`, `application/csv` |
| `textbook` | PDF or Word textbook | `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `text/plain` |
| `image` | Images | `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/svg+xml` |
| `audio` | Audio recordings | `audio/mpeg`, `audio/mp3`, `audio/wav`, `audio/ogg`, `audio/mp4`, `audio/webm`, `audio/aac`, `audio/flac` |
| `video` | Video files | `video/mp4`, `video/mpeg`, `video/webm`, `video/ogg`, `video/quicktime`, `video/x-msvideo` |
| `link` | External URL — no file upload required | — |

**Maximum file size:** 50 MB for all types.

---

## Endpoints

### 1. Upload / create a resource

```
POST /api/v1/resources
Content-Type: multipart/form-data
```

Creates a new resource. File-based types (`document`, `textbook`, `image`, `audio`, `video`) require a `file` part. The `link` type requires `externalUrl` instead.

#### Request — multipart/form-data fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string (enum) | Yes | One of: `document`, `textbook`, `image`, `audio`, `video`, `link` |
| `title` | string | Yes | Display name for the resource |
| `file` | file | Conditional | Required for all types except `link` |
| `externalUrl` | string (URL) | Required when `type = link` | Fully-qualified URL |
| `description` | string | No | Optional description |
| `fieldId` | UUID | No | Attach the resource to a field |
| `tags` | JSON array string or repeated field | No | e.g. `["physics","notes"]` |

#### Example — upload a PDF

```bash
curl -X POST https://api.example.com/api/v1/resources \
  -H "Authorization: Bearer <token>" \
  -F "type=document" \
  -F "title=Lecture Notes Week 3" \
  -F "description=Covers chapters 5–7" \
  -F "fieldId=3fa85f64-5717-4562-b3fc-2c963f66afa6" \
  -F 'tags=["physics","week3"]' \
  -F "file=@/path/to/lecture-notes.pdf"
```

#### Example — add an external link

```bash
curl -X POST https://api.example.com/api/v1/resources \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: multipart/form-data" \
  -F "type=link" \
  -F "title=Khan Academy - Kinematics" \
  -F "externalUrl=https://www.khanacademy.org/science/physics/one-dimensional-motion"
```

#### Response `201 Created`

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "type": "document",
  "title": "Lecture Notes Week 3",
  "description": "Covers chapters 5–7",
  "fieldId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "fileUrl": "https://res.cloudinary.com/cognix/raw/upload/v1714900000/cognix/resources/1714900000-lecture-notes.pdf",
  "fileName": "lecture-notes.pdf",
  "fileSize": 204800,
  "mimeType": "application/pdf",
  "externalUrl": null,
  "isProcessed": false,
  "tags": ["physics", "week3"],
  "createdAt": "2026-05-11T10:00:00.000Z",
  "updatedAt": "2026-05-11T10:00:00.000Z"
}
```

#### Error responses

| Status | Code | When |
|--------|------|------|
| `400` | `Bad Request` | File exceeds 50 MB |
| `400` | `Bad Request` | MIME type not allowed for the given `type` |
| `400` | `Bad Request` | `externalUrl` missing for `link` type |
| `400` | `Bad Request` | `externalUrl` is not a valid URL |
| `400` | `Bad Request` | File missing for a non-`link` type |
| `401` | `Unauthorized` | Missing or invalid JWT |

---

### 2. List resources

```
GET /api/v1/resources
```

Returns a paginated list of the authenticated user's resources. Supports filtering and full-text search.

#### Query parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer ≥ 1 | `1` | Page number |
| `limit` | integer 1–100 | `10` | Items per page |
| `type` | string (enum) | — | Filter by resource type |
| `fieldId` | UUID | — | Filter by field |
| `search` | string | — | Case-insensitive search across `title` and `description` |
| `tag` | string | — | Filter by a single tag (exact match, case-insensitive) |

#### Example

```bash
curl "https://api.example.com/api/v1/resources?type=document&fieldId=3fa85f64-5717-4562-b3fc-2c963f66afa6&page=1&limit=20" \
  -H "Authorization: Bearer <token>"
```

#### Response `200 OK`

```json
{
  "data": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "type": "document",
      "title": "Lecture Notes Week 3",
      "description": "Covers chapters 5–7",
      "fieldId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "fileUrl": "https://res.cloudinary.com/...",
      "fileName": "lecture-notes.pdf",
      "fileSize": 204800,
      "mimeType": "application/pdf",
      "externalUrl": null,
      "isProcessed": false,
      "tags": ["physics", "week3"],
      "createdAt": "2026-05-11T10:00:00.000Z",
      "updatedAt": "2026-05-11T10:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 47,
    "totalPages": 3
  }
}
```

---

### 3. Get a single resource

```
GET /api/v1/resources/:id
```

#### Path parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Resource ID |

#### Example

```bash
curl "https://api.example.com/api/v1/resources/a1b2c3d4-e5f6-7890-abcd-ef1234567890" \
  -H "Authorization: Bearer <token>"
```

#### Response `200 OK`

Returns the [Resource object](#resource-object).

#### Error responses

| Status | When |
|--------|------|
| `404` | Resource not found or does not belong to the user |
| `401` | Missing or invalid JWT |

---

### 4. Update a resource

```
PATCH /api/v1/resources/:id
Content-Type: application/json
```

Updates `title`, `description`, `fieldId`, or `tags`. File replacement is not supported via this endpoint.

#### Path parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Resource ID |

#### Request body (all fields optional)

```json
{
  "title": "Updated title",
  "description": "Updated description",
  "fieldId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "tags": ["updated-tag", "new-tag"]
}
```

> **Note on `tags`:** Providing `tags` replaces the entire tag set. Send an empty array `[]` to remove all tags. Omit the field entirely to leave tags unchanged.

#### Example

```bash
curl -X PATCH "https://api.example.com/api/v1/resources/a1b2c3d4-e5f6-7890-abcd-ef1234567890" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"title": "Lecture Notes Week 3 (Revised)", "tags": ["physics", "week3", "revised"]}'
```

#### Response `200 OK`

Returns the updated [Resource object](#resource-object).

#### Error responses

| Status | When |
|--------|------|
| `404` | Resource not found or does not belong to the user |
| `400` | Validation error on request body |
| `401` | Missing or invalid JWT |

---

### 5. Delete a resource

```
DELETE /api/v1/resources/:id
```

Permanently deletes the resource and its associated file from cloud storage.

#### Path parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Resource ID |

#### Example

```bash
curl -X DELETE "https://api.example.com/api/v1/resources/a1b2c3d4-e5f6-7890-abcd-ef1234567890" \
  -H "Authorization: Bearer <token>"
```

#### Response `200 OK`

```json
{
  "message": "Resource deleted successfully"
}
```

#### Error responses

| Status | When |
|--------|------|
| `404` | Resource not found or does not belong to the user |
| `401` | Missing or invalid JWT |

---

### 6. Get resources by field

```
GET /api/v1/resources/field/:fieldId
```

Returns a paginated list of resources attached to a specific field.

#### Path parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `fieldId` | UUID | Field ID |

#### Query parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer ≥ 1 | `1` | Page number |
| `limit` | integer ≥ 1 | `20` | Items per page |

#### Example

```bash
curl "https://api.example.com/api/v1/resources/field/3fa85f64-5717-4562-b3fc-2c963f66afa6?page=1&limit=20" \
  -H "Authorization: Bearer <token>"
```

#### Response `200 OK`

```json
{
  "data": [ /* Resource objects */ ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 12,
    "totalPages": 1
  }
}
```

---

### 7. Get resource statistics

```
GET /api/v1/resources/stats
```

Returns a count of the user's resources broken down by type.

#### Example

```bash
curl "https://api.example.com/api/v1/resources/stats" \
  -H "Authorization: Bearer <token>"
```

#### Response `200 OK`

```json
{
  "total": 23,
  "byType": {
    "document": 10,
    "image": 5,
    "audio": 3,
    "video": 2,
    "link": 2,
    "textbook": 1
  }
}
```

---

### 8. Get all tags

```
GET /api/v1/resources/tags
```

Returns all tags used by the authenticated user's resources, ordered by frequency.

#### Example

```bash
curl "https://api.example.com/api/v1/resources/tags" \
  -H "Authorization: Bearer <token>"
```

#### Response `200 OK`

```json
[
  { "tag": "physics", "count": 8 },
  { "tag": "week3",   "count": 5 },
  { "tag": "revised", "count": 2 }
]
```

---

### 9. Get resources for AI context (RAG)

```
GET /api/v1/resources/rag
```

Returns a lightweight representation of the user's resources for use as AI context. Includes `extracted_content` where available.

#### Query parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `fieldId` | UUID | Optional — filter to a specific field |

#### Example

```bash
curl "https://api.example.com/api/v1/resources/rag?fieldId=3fa85f64-5717-4562-b3fc-2c963f66afa6" \
  -H "Authorization: Bearer <token>"
```

#### Response `200 OK`

```json
[
  {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "type": "document",
    "title": "Lecture Notes Week 3",
    "description": "Covers chapters 5–7",
    "content": "Chapter 5: Kinematics...",
    "url": null
  },
  {
    "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    "type": "link",
    "title": "Khan Academy - Kinematics",
    "description": null,
    "content": null,
    "url": "https://www.khanacademy.org/science/physics/one-dimensional-motion"
  }
]
```

> `content` is `null` until the resource has been processed by the AI pipeline (`isProcessed: true`).

---

## Common error shape

All error responses follow this structure:

```json
{
  "statusCode": 400,
  "message": "Unsupported file type \"application/zip\" for resource type \"document\". Allowed: application/pdf, ...",
  "error": "Bad Request"
}
```

---

## File upload notes

- Files are uploaded directly as `multipart/form-data` — no pre-signed URL step required.
- The `file` field name must be exactly `file`.
- `tags` in multipart form must be sent as a JSON-encoded string: `'["tag1","tag2"]'`, or as repeated fields: `tags=tag1&tags=tag2`.
- `isProcessed` is always `false` on creation. The backend sets it to `true` once AI text extraction is complete.
