# Prisma migrations

This directory is the committed migration history for the backend database.

## Development

Create and test migrations only against a development database with Prisma's
development workflow, for example:

```bash
npx prisma migrate dev --name <descriptive_name> --schema prisma/schema.prisma
```

Review the generated SQL and commit the migration directory with the schema change.

## Production

Production must use the committed migration history and the deployment-safe command:

```bash
npm run db:migrate:deploy
```

This command is intentionally not part of the application build or start scripts.
Do not use `prisma migrate dev`, `prisma db push`, `prisma migrate reset`, or
`prisma reset` against production.

## Rollback

Prisma does not provide an automatic rollback command for applied migrations in this
repository. Recovery requires restoring a database backup or deploying a reviewed
corrective migration.
