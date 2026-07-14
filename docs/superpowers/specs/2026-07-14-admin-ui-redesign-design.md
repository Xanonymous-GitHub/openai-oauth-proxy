# Admin UI Redesign

**Date:** 2026-07-14
**Status:** Approved

## Problem

The loopback admin service on port 8081 serves a framework-free authentication page with raw browser styling. It exposes the required Codex device-login controls, but its hierarchy, state feedback, responsiveness, and interaction design are not suitable for a polished operator interface.

## Goals

- Replace the raw admin page with a small React and TypeScript application built by Vite and Bun.
- Use customized shadcn/ui components rather than default browser controls or an unmodified component demo.
- Provide a responsive, accessible light/dark interface that follows the system theme and includes a compact theme control.
- Render every existing account state clearly and make device login easy to complete.
- Preserve the current admin API, session, CSRF, Origin, CSP, and loopback-only security boundaries.
- Keep runtime code and dependencies minimal.

## Non-Goals

- No new backend endpoints, authentication methods, metrics, logs, navigation, or proxy controls.
- No router, global state library, server-side React rendering, automatic polling, or animation framework.
- No changes to the admin listener address, port exposure, cookie policy, or Kubernetes deployment boundary.
- No fake operational data or decorative dashboard modules.

## Design Direction

Read this as a loopback-only authentication control panel for technical operators, using a calm premium devtool visual language.

- `DESIGN_VARIANCE: 5`
- `MOTION_INTENSITY: 3`
- `VISUAL_DENSITY: 4`

Use cool graphite neutrals with one muted teal accent in both light and dark themes. Use self-hosted Geist Sans for interface copy and Geist Mono for device codes and technical labels. Panels use a 16px radius, controls use a 10px radius, and only status badges use pill geometry.

Avoid gradients, glass effects, glows, fake charts, oversized type, excessive cards, and a sidebar. Motion is limited to short opacity and transform transitions for state changes and tactile control feedback. All nonessential motion is disabled by `prefers-reduced-motion`.

## Architecture

Keep one root `package.json`, one exact-pinned dependency graph, and one Bun lockfile. Add the browser application under `src/admin/ui/` and a dedicated browser TypeScript configuration for DOM and JSX types. The existing server TypeScript configuration remains strict and Node-focused.

Vite builds deterministic `app.js` and `app.css` assets into `dist/admin-ui/`. Hono retains a small, testable HTML mount shell at `/` and serves the generated assets from same-origin routes using a runtime path resolved from `import.meta.url`. The production build explicitly runs both server compilation and the Vite build. The Docker build copies the Vite configuration and client source into the build stage; its existing copy of `dist/` carries the assets into the runtime image.

The production asset handler accepts an asset-root dependency. Production supplies the `dist/admin-ui/` path, while server tests supply fixture assets from a temporary directory. Unit tests therefore remain independent of build order, and the existing `check` sequence can continue to run tests before the production build.

Use the latest stable React, React DOM, Vite, TypeScript-compatible Vite plugin, Tailwind CSS, and shadcn/ui tooling available during implementation. Pin exact versions to match the root project's dependency policy. Only copy the shadcn/ui components required by this screen.

## Page Structure

The page uses a compact top bar containing the product identity, current account status, and theme control. The primary workspace sits in a centered container with a maximum width of 1120px.

At desktop widths, the workspace is an asymmetric grid: the main authentication panel occupies roughly seven columns and a guidance rail occupies five. The main panel carries the current state and all actions. The rail explains the loopback security boundary and the short device-login sequence without introducing new controls.

Below 768px, the layout becomes one strict column. The primary panel appears first, followed by guidance. Controls become full-width where needed, device codes wrap safely, and no horizontal scrolling is required at 320px viewport width.

## Components

Use customized shadcn/ui `Button`, `Badge`, `Card`, `Separator`, `Skeleton`, and `Alert` components. Use one icon family throughout. Keep the component tree small:

- `AdminApp` owns bootstrap state, request state, and theme preference.
- `AccountPanel` exhaustively selects the view for the current account state.
- State views contain only their state-specific content and actions.
- `GuidancePanel` contains static operational guidance.
- `ThemeControl` applies `system`, `light`, or `dark` on the document root and stores the user's explicit preference.

Do not create abstractions beyond these clear responsibilities.

## Account States

### Checking

Show shape-matched skeletons in the final panel layout and a `Refresh status` action that invokes `/api/refresh`. Do not use a generic spinner or leave the operator without a recovery action.

### Signed Out

Present a concise explanation and one primary `Connect Codex` action. Secondary guidance remains outside the action area.

### Login Pending

Make the device code the visual focus in a high-contrast monospace block with a copy action and inline copied feedback. Parse the supplied verification URL and make it clickable only when its origin is exactly `https://auth.openai.com` and its pathname is exactly `/codex/device`. Open that canonical URL in a new tab with `noopener` and `noreferrer`. An unexpected URL is shown as an invalid authentication state and is not linked. Provide a manual refresh action and a cancel action. Device-login completion remains manual-refresh only.

### Ready

Show the account email, including a clear fallback when it is null, and the plan type. Refresh is secondary. Logout is visually destructive and remains distinct from routine actions.

### Error

Show a sanitized authentication-required message and a `Reconnect Codex` action that invokes `/api/login`. Never display raw backend error text or credential-related details.

## Data Flow And Security

Share a browser-safe response contract for the account state, CSRF token, and optional sanitized error code. Parse API responses with a small runtime guard, then render all `AccountState` discriminants exhaustively. An unknown variant or malformed payload enters the recoverable client-error state rather than rendering partial data.

Bootstrap with `GET /api/state`. Mutations continue to use the existing paths, same-origin cookies, `Content-Type: application/json`, and the latest `X-CSRF-Token`. Login sends exactly `{ "type": "chatgptDeviceCode" }`; cancel, refresh, and logout each send exactly `{}`. Disable mutation controls while a request is active to prevent session-rotation races.

Login and logout adopt the CSRF token returned with their rotated sessions. Cancel and refresh retain the current session semantics. On `401` or `403`, clear the local CSRF token and bootstrap a fresh session once without replaying the rejected mutation.

Do not change the server's exact-Origin validation, session expiry, cookie attributes, sanitized response bodies, no-CORS behavior, or loopback-only deployment. External verification links use safe new-tab attributes and never become API connection targets.

## Error Handling

A valid `503` response may still contain an updated account state and CSRF token. Apply valid state updates while displaying only a generic authentication-unavailable message.

For malformed JSON, invalid response shapes, unexpected statuses, and network failure, preserve the last valid account state and show an inline recovery alert. If bootstrap fails before any valid state exists, render a dedicated session-unavailable panel with a `Retry` action that invokes `GET /api/state`. Do not rely on transient toasts. A forbidden mutation triggers one clean re-bootstrap; it is never automatically replayed.

## CSP And Assets

All JavaScript, CSS, icons, and fonts are local and same-origin. Theme switching uses external CSS variables and a root data attribute, so no inline script or style exception is required. Select shadcn/ui primitives that do not require CSP relaxation or runtime-injected inline styles.

The existing restrictive CSP remains at least as strong as its current form. Asset responses retain `Cache-Control: no-store` unless a later security review explicitly permits immutable caching.

## Testing

Preserve existing backend coverage for exact Origin checks, CSRF enforcement, session rotation, cookie attributes, account delegation, sanitization, and operation failures.

Replace framework-free DOM-script assertions with:

- mount-shell, static-asset, content-type, and CSP integration tests;
- client tests for all five account states and nullable email;
- request tests for exact mutation payloads and busy-state disabling;
- CSRF rotation and `401`/`403` re-bootstrap tests with no mutation replay;
- valid `503`, malformed response, unexpected status, and network-failure tests;
- initial-bootstrap failure and retry tests;
- theme preference, keyboard focus, and copy feedback tests.

## Verification

The change is complete when:

1. Server and browser TypeScript checks pass.
2. The full Vitest suite passes.
3. The production server and Vite build emit all expected files.
4. `bun run check` passes.
5. A production-container smoke test returns the mount shell, JavaScript, CSS, and `/api/state` successfully.
6. The page is manually checked in a real browser at 320px, 768px, and desktop widths in light, dark, and system theme modes.
7. Keyboard-only operation, visible focus, reduced motion, and WCAG AA text/control contrast are verified.
