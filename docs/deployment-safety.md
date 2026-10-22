# Deployment safety policy (Vercel)

Status: **ACTIVE IN `vercel.json`** (repository-side; no dashboard access required).

This note records *why* `vercel.json` looks the way it does, so a future change does
not silently re-open the risk this policy closes.

## 1. The risk that existed

The build command was:

```json
"buildCommand": "prisma7 generate && prisma7 migrate deploy && next build"
```

`prisma migrate deploy` applies migrations to whatever database `DATABASE_URL`
points at. Vercel creates a **Preview deployment for every pushed branch by
default** (Vercel docs: "Deploying Git Repositories" / "Environments"). If the
Preview environment's `DATABASE_URL` points at the production database — a
common misconfiguration — then an ordinary push to a feature branch would
apply migrations to production. There is no commit-message token that skips a
Vercel deployment; the documented controls are dashboard-side (Ignored Build
Step, per-branch deployment settings) or repository-side
(`git.deploymentEnabled` in `vercel.json`).

## 2. The two controls now in place

### 2.1 Migrations run for production deployments only

```json
"buildCommand": "prisma7 generate && if [ \"$VERCEL_ENV\" = \"production\" ]; then … prisma7 migrate deploy; else echo \"[build] skipping prisma migrate deploy …\"; fi && next build"
```

`VERCEL_ENV` is a documented Vercel system environment variable
(`production` | `preview` | `development`; custom environments report
`preview`, and `VERCEL_TARGET_ENV` distinguishes them).

Properties:

- **Production behaviour is unchanged** — a production deployment still runs
  `prisma7 migrate deploy` exactly as before.
- **Preview builds never migrate.** If `VERCEL_ENV` is unset for any reason the
  condition is false, so the command *skips* rather than migrates. The failure
  mode is "migrations not applied", never "migrations applied to the wrong
  database".
- The skip is **logged in the build output**, so a skipped migration is visible
  to an operator instead of silent.
- `prisma7 generate` still runs everywhere: the client is generated for every
  build, only the *schema mutation* is production-only.

This is the documented Vercel "conditional build command" mechanism
(<https://vercel.com/kb/guide/dynamic-build-commands>).

### 2.2 Automatic deployments are disabled for the checkpoint branches

```json
"git": { "deploymentEnabled": { "freebuff/*": false, "freebuff/2b9379745bb44ff31bd7c96c-checkpoint": false } }
```

`git.deploymentEnabled` accepts a map of branch patterns to booleans
(minimatch syntax). Unspecified branches — including `main` — keep the default
`true`, so **production deployments are unaffected**. For the `freebuff/*`
namespace used by checkpoint/agent branches, no deployment is created at all.

Note on evidence: Vercel documents the *shape and effect* of
`git.deploymentEnabled` (<https://vercel.com/docs/project-configuration/git-configuration>)
but does not document whether the eligibility check reads the `vercel.json` of
the pushed commit or the project's stored configuration. Control 2.1 does not
depend on that question: even if a preview deployment *is* created for a
checkpoint branch, its build cannot run migrations.

## 3. What this guarantees

| Scenario | Before | After |
|---|---|---|
| Push to `main` | production build + migrations | **unchanged**: production build + migrations |
| Push to a feature branch | preview build + **migrations** | preview build, **no migrations** |
| Push to `freebuff/*` | preview build + **migrations** | **no deployment created** |
| Preview `DATABASE_URL` mis-set to production | production schema mutated by a branch push | **impossible from a build** |

## 4. What is still unverified from a build environment

These need the Vercel dashboard (or a `vercel` CLI login) and are *not*
asserted by this repository:

1. Whether a Vercel project is linked to this GitHub repository at all, and
   which project/org it is.
2. The effective **Ignored Build Step** and any per-branch settings that a
   dashboard administrator has configured.
3. The **Production Branch** (branch tracking) currently set for the project.
4. Whether the **Preview** environment's `DATABASE_URL` points at a disposable
   database or at production.

Until those are confirmed by the repository owner, the honest posture is:
"repository-side guards are in place; the dashboard configuration is
unverified".

## 5. Operating rules for this repository

- Never remove the `VERCEL_ENV` guard from `buildCommand` without an explicit
  decision — it is the only control that does not depend on dashboard state.
- Never add a branch pattern to `git.deploymentEnabled` with the value `true`
  for a checkpoint branch.
- Schema changes reach production only through a reviewed migration applied in
  a production deployment, never through a preview build.
- Keep the `[build]` log lines; they are the audit trail for whether a
  migration ran.
