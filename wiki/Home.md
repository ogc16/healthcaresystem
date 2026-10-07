# CarePulse Wiki

Welcome. This wiki is the operational guide to the CarePulse codebase — how to
run it, how it is put together, and what is and is not safe about it.

It is written for someone joining the project, or picking it up after six
months. It favours accuracy over polish: where a control is incomplete, this
wiki says so.

## Pages

| Page | Read it when |
| --- | --- |
| [Getting Started](Getting-Started.md) | Setting up a local environment from nothing |
| [Architecture](Architecture.md) | You need to know how a request flows through the app |
| [Security Model](Security-Model.md) | Before deploying, or reviewing an auth change |
| [Testing and CI](Testing-and-CI.md) | Running the gates, adding tests, interpreting CI |
| [Troubleshooting](Troubleshooting.md) | Something is broken and the error is unhelpful |
| [Roadmap and Open Gaps](Roadmap.md) | You want to know what is unfinished and why |

Reference documentation for environment variables, the admin and patient auth
model, and upload validation lives in the repository under [`docs/`](../docs),
and is kept closer to the code than this wiki is.

## Publishing this to a GitHub wiki

A GitHub wiki is a **separate git repository**, so `git push` to `main` will not
publish these pages.

```bash
git clone https://github.com/ogc16/healthcaresystem.wiki.git
cp wiki/*.md <wiki-clone>/
cd <wiki-clone> && git add . && git commit -m "Add wiki" && git push
```

One consequence: links of the form `../docs/…` resolve when you are browsing the
**repository**, but they will 404 in the published wiki, because the `docs/`
directory does not exist there. If that matters, either copy `docs/` into the
wiki repo or replace those links with absolute URLs to the repository, e.g.
`https://github.com/ogc16/healthcaresystem/blob/main/docs/security.md`.

Pages are named with hyphens (`Security-Model.md`) because GitHub wiki URLs
cannot contain underscores.

## What this project is

A patient registration and appointment scheduling system, with an admin
dashboard. Built on Next.js 16 (App Router) and Appwrite.

| Layer | Technology |
| --- | --- |
| Framework | Next.js 16.3, React 19, TypeScript |
| Backend | Appwrite (auth, database, storage, messaging) |
| Styling | Tailwind CSS |
| Validation | Zod |
| Forms | React Hook Form |
| Tests | Vitest |
| Monitoring | Sentry |

## Status

Green on every push: typecheck, lint, 102 unit tests, and a production build all
run in CI on `main`.

**This is not a HIPAA-compliant system and must not handle real patient data
until the items in [Roadmap and Open Gaps](Roadmap.md) are closed.** Specifically
there is no audit log, no field-level encryption, and the admin passkey is a
single shared secret. The [Security Model](Security-Model.md) page is explicit
about which controls are real and which are aspirational.

Upstream is a public tutorial project (`javascript-mastery`), which explains both
some of the code's shape and the Sentry configuration that pointed at someone
else's project. The DSN is now environment-driven and reporting is off by
default; see [Troubleshooting](Troubleshooting.md#sentry-reports-to-the-wrong-project).