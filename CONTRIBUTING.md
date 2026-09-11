# Contributing

Use Node.js 22 and npm. Install dependencies with `npm ci` and `npm --prefix frontend ci`.

Before opening a pull request, run:

```sh
npm run typecheck
npm run frontend:build
```

Add a SQL migration when changing database storage, and test both existing data and new databases. Keep runtime code compatible with Node.js and Cloudflare Workers. Do not commit real credentials, local databases, logs, or copied reference projects. Use `.env.example` / `.dev.vars.example` for placeholder configuration.

Pull requests run type checks, a frontend build, and a Docker image smoke test. Publishing to Docker Hub is restricted to pushes on `main`, version tags, and explicitly selected manual publishing runs. The image currently targets `linux/amd64`.

Contributions are licensed under the project's MIT license. Dependencies keep their own licenses; update `THIRD_PARTY_NOTICES.md` when changing bundled frontend dependencies.
