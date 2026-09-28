# ChatFlow API

This backend implements the multi-tenant SaaS foundation for ChatFlow CRM.

## Security model
- JWT-based auth for authenticated requests
- RBAC with permission middleware
- Tenant access checks through organization ownership
- Audit logging and secret separation
- Mock WhatsApp provider for local development

## Key routes
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/customers`
- `POST /api/customers`
- `GET /api/dashboard`
- `GET /api/whatsapp/accounts`
- `POST /api/whatsapp/connect`

## Development
```bash
npm run dev
```

## Production note
The official Meta/WhatsApp Business API integration is represented by `MetaWhatsAppProvider`; environment variables must be supplied before using it in production.

## Production runtime configuration

The backend requires these runtime variables when `NODE_ENV=production`:

- `DATABASE_URL`
- `DIRECT_URL`
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `APP_URL`
- `API_URL`
- `CORS_ORIGINS`
- `SMTP_HOST`
- `EMAIL_FROM`

`PORT` is optional and defaults to `4000`. `SMTP_PORT` defaults to `587`.
`SMTP_USER` and `SMTP_PASSWORD` must be provided together when SMTP
authentication is used. The server exposes `GET /health` and does not run Prisma
migrations during application startup.
