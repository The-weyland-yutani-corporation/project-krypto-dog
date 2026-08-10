# Contributing Guide

## Opening an Issue

1. Search [existing issues](../../issues) to avoid duplicates.
2. Click **New Issue** and choose the most relevant template.
3. Fill in the title and description — include reproduction steps for bugs, or acceptance criteria for features.
4. Apply appropriate labels and submit.

## Local Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill in the required values before running
the app or repository scripts.

## Validation Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the local dev server |
| `npm run lint` | Run ESLint across the codebase |
| `npm run typecheck:scripts` | Type-check utility scripts |
| `npm run test` | Run the full Jest test suite |
| `npm run test:unit` | Run unit tests serially |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run build` | Production build check |

Run `npm run lint && npm run test` before opening a pull request.

## Pull Request Checklist

- [ ] `npm run lint` passes with no new errors
- [ ] `npm run test` passes
- [ ] Changes are scoped — one concern per PR
- [ ] PR description explains *what* and *why*
