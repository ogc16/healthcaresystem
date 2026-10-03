# CarePulse documentation

| Doc | Contents |
| --- | --- |
| [architecture.md](architecture.md) | Directory layout, request flow, data access |
| [security.md](security.md) | Admin and patient auth model, proxy, known open gaps |
| [environment.md](environment.md) | Every environment variable and what it grants |

## Quick start

```bash
cp .env.example .env.local   # then fill in values
npm install
npm run dev
```

Patient portal: <http://localhost:3000> — admin: <http://localhost:3000/admin/login>

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |

## Project layout

Source lives under `src/` so that application code, config, and static assets
stay separable. Next.js resolves `src/app` as the App Router root.

```
src/
  app/          Routes (App Router), layouts, route handlers
  components/   React components (ui/ = shadcn primitives)
  lib/          Server logic: Appwrite client, actions, auth
  constants/    Shared constants
  types/        Global type declarations
  proxy.ts     Route protection
public/         Static assets served at the web root
docs/           This documentation
```

The `@/*` path alias maps to `./src/*`.