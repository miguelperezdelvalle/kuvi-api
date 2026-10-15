# Kuvi API

Backend Fastify + Prisma/PostgreSQL. Use Node.js 22 and run commands from this directory.

## Setup

1. Run `npm ci` (all runtime dependencies belong to this project).
2. Configure `.env` with `DATABASE_URL`, `JWT_SECRET` and optional settings from `src/app/env.ts`. Keep real secrets out of Git.
3. Run `npm run prisma:generate` after installing or changing the Prisma schema.
4. Check existing migrations with `npx prisma migrate status` before starting the service.

## Development and validation

- `npm run dev`: development server with automatic restart.
- `npm run typecheck`: check application, seed and Prisma configuration without emitting files.
- `npm run build`: compile application into `dist/`; fails without emitting on type errors.
- `npm start`: run `dist/app/server.js`.
- `npm test`: build, start an isolated server on a free loopback port, check authentication guards and test `/users/me` using an in-memory database stub.
- `RUN_DB_HEALTH=1 npm test`: also verify database connectivity using the read-only `/db-health` endpoint.

Tests require valid environment settings but do not create users, alter data, apply migrations or run the seed. The seed is executed separately with `npm run seed`; it is not part of the application build.

Before changing the database, prepare and review a migration and back up the database. Do not use reset commands against an existing database.
