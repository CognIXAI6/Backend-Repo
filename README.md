# CognIX AI Backend API

A NestJS backend API for CognIX AI - an AI-powered transcription platform.

## Tech Stack

- **Framework**: NestJS
- **ORM**: KnexJS
- **Database**: PostgreSQL
- **Cache**: Redis
- **Email**: Resend / Nodemailer
- **File Upload**: Cloudinary
- **Payment**: Stripe
- **Containerization**: Docker

## Getting Started

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- PostgreSQL 15+
- Redis 7+

### Installation

1. Clone the repository
2. Copy environment variables:
   ```bash
   cp .env.example .env
   ```
3. Update `.env` with your configuration

### Development

Using Docker:
```bash
docker-compose up -d
```

Or manually:
```bash
# Install dependencies
npm install

# Run migrations
npm run migrate:latest

# Seed database
npm run seed:run

# Start development server
npm run start:dev
```

### API Structure

```
/api/v1
├── /auth
│   ├── POST /signup
│   ├── POST /login
│   ├── POST /verify-email
│   ├── POST /resend-verification
│   ├── POST /forgot-password
│   ├── POST /reset-password
│   ├── POST /refresh
│   ├── POST /logout
│   └── POST /me
├── /onboarding
│   ├── GET /status
│   ├── POST /name
│   ├── POST /field
│   ├── POST /speakers
│   ├── POST /skip-voice
│   └── POST /complete
├── /fields
│   ├── GET /
│   ├── GET /settings/:key
│   ├── GET /my-fields
│   ├── GET /my-custom-fields
│   ├── POST /select
│   └── POST /custom
├── /verification
│   ├── GET /
│   ├── GET /:fieldId/status
│   ├── POST /healthcare
│   └── POST /legal
├── /speakers
│   ├── GET /
│   ├── GET /count
│   ├── POST /
│   ├── PUT /:id
│   └── DELETE /:id
├── /voice
│   ├── GET /
│   ├── GET /has-sample
│   ├── POST /upload
│   ├── POST /upload-base64
│   └── DELETE /:id
└── /payment
    ├── POST /subscribe
    ├── POST /cancel
    └── POST /webhook
```

## Database Migrations

```bash
# Create a new migration
npm run migrate:make <migration_name>

# Run migrations
npm run migrate:latest

# Rollback migrations
npm run migrate:rollback
```

## Database Seeds

```bash
# Create a new seed
npm run seed:make <seed_name>

# Run seeds
npm run seed:run
```

## Environment Variables

See `.env.example` for all required environment variables.

## License

Private
