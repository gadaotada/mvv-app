# Repository Guidelines

## Runtime and deployment

- Development may use the Node.js release selected by the maintainer, including a Current or odd-numbered release. Do not flag or change the development Node.js version during routine implementation or review work.
- Before a production deployment, confirm that the declared runtime is a supported LTS release. Treat runtime-channel changes as deployment-readiness work unless the user explicitly requests a runtime upgrade.
- nginx is deployed in front of the Node.js HTTP server and owns public TLS termination, proxy-level connection limits, and other edge concerns.
- Keep application-level protections such as body limits, handler deadlines, safe error responses, canonical URL handling, and graceful shutdown. nginx complements these protections; it does not replace them.
- Preserve compatibility with the Node.js version declared for the active development cycle unless a runtime upgrade is part of the task.

## TypeScript and modules

- Use strict TypeScript and preserve the checks enabled in `tsconfig.base.json`.
- Use ECMAScript modules and include `.js` extensions in relative TypeScript imports.
- Prefer named exports. Use `import type` or inline type imports when a dependency is type-only.
- Use Node.js built-in imports with the `node:` prefix.
- Prefer `readonly` fields and parameters for values that are not intentionally mutated.
- Model expected failure states explicitly. Avoid `any`, unsafe casts, and non-null assertions unless the boundary genuinely requires one and the reason is clear.
- Validate public configuration at construction time and fail early with a descriptive error.

## Formatting

- Use 2-space indentation, single quotes, semicolons, and trailing commas.
- Follow `.editorconfig` and `.prettierrc.json`; the configured print width is 200 columns.
- Put one space after control-flow keywords:

  ```ts
  if (condition) return;
  ```

- A single short statement may remain on the same line without braces:

  ```ts
  if (value === undefined) return undefined;
  ```

- Use braces when a branch contains multiple statements or when the body spans multiple lines:

  ```ts
  if (response.headersSent) {
    response.destroy(error);
    return;
  }
  ```

- Put spaces around binary operators and after commas. Do not add padding inside parentheses.
- Use blank lines to separate imports, validation, state setup, and distinct logical steps. Avoid blank lines between tightly related statements.
- Keep guard clauses concise and prefer early returns over deeply nested `if`/`else` blocks.
- Break long object literals and function calls across lines with a trailing comma when that improves readability.

## Naming and structure

- Use `camelCase` for variables and functions, `PascalCase` for classes and types, and uppercase snake case for environment-variable names.
- Use descriptive names at HTTP boundaries: `request`, `response`, `statusCode`, `contentType`, and `signal`.
- Keep the HTTP core small and separated by responsibility: routing, request bodies, responses, errors, configuration, and server lifecycle.
- Prefer small focused functions over middleware-style hidden mutation.
- Do not introduce a dependency when the Node.js standard library provides a clear, maintainable solution.

## Core package boundaries

- Import core functionality through its public category subpaths: `@mvv/core/config`, `@mvv/core/http`, `@mvv/core/server`, `@mvv/core/sqlite`, `@mvv/core/template`, and `@mvv/core/utils`.
- Import shared types with `import type` from `@mvv/core/types`.
- Put general shared type declarations in `apps/core/src/types/core.d.ts`.
- Reuse runtime guards from `apps/core/src/utils/global.ts`; do not recreate equivalent local helpers.
- Keep domain-specific helpers close to their owning module.

## SQLite

- Use `@mvv/core/sqlite` rather than importing `node:sqlite` directly from applications.
- Use tagged SQL methods for values originating outside trusted static code.
- Reserve `database.exec()` for trusted schema, migration, and pragma statements.
- Keep SQLite transaction callbacks synchronous.
- Prefer `using` for deterministic database cleanup.
- Add dedicated row mappers when converting SQLite rows into domain types.

## HTTP core expectations

- Every request path must end the response, reject into the error handler, or be terminated by a bounded deadline.
- Propagate `AbortSignal` to asynchronous work where cancellation is supported.
- Bound all untrusted input before buffering it. Rejected request bodies must be drained safely or the connection must be closed.
- Do not expose unexpected internal error messages to clients.
- Treat URL decoding and canonicalization as a security boundary. Decode route segments exactly once.
- Avoid writing headers or bodies after a response has ended or been destroyed.
- Graceful shutdown must have an overall deadline and must not leave active sockets or cleanup hooks waiting indefinitely.

## Tests and verification

- Add regression tests for bug fixes and failure paths, not only successful requests.
- Use black-box HTTP tests when behavior depends on Node.js parsing, sockets, keep-alive, connection closure, or timeouts.
- Before handing off changes, run:

  ```sh
  npm test
  npx tsc -b --force
  git diff --check
  ```

- Keep tests deterministic and use short bounded timeouts. Ensure servers, sockets, timers, and signal listeners are cleaned up.
