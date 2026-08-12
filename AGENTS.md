# AGENTS.md

Welcome AI Agent! This repository, **oh-my-md**, is a desktop Markdown editor with live preview capabilities. Here is the operational context and guidelines for working in this codebase.

---

## 1. Project Overview & Workspace Layout
We use a **pnpm monorepo** workspace structure containing a desktop application and a shared parsing engine.

```
oh-my-md/
├── apps/
│   └── desktop/               # Tauri v2 desktop application
│       ├── src/               # React 19 frontend
│       └── src-tauri/         # Rust backend (Tauri host)
├── packages/
│   └── engine/                # Core parsing & rendering engine
│       ├── src/               # CodeMirror 6 & Lezer markdown extensions
│       └── test/              # Vitest test suite for the editor engine
```

---

## 2. Key Developer Commands
Always use `pnpm` to execute commands in this repository.

- **Run Dev Server (Desktop app)**: `pnpm dev` (spawns the Tauri dev environment)
- **Run Engine Tests**: `pnpm test` (runs Vitest in `@omd/engine`)
- **Build Desktop App Frontend**: `pnpm --filter @omd/desktop build`

---

## 3. Tech Stack Details
- **Frontend Framework**: React 19 (in `@omd/desktop`)
- **Desktop Host**: Tauri v2 (Rust backend, Node/Vite frontend)
- **Editor Base**: CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`)
- **Parsing Engine**: Lezer Markdown (`@lezer/markdown`, `@lezer/common`)
- **Testing**: Vitest (`vitest`)

---

## 4. Architectural Boundaries (Critical)
To keep the code clean and maintainable, adhere to these strict boundary guidelines:

- **Parsing & Markdown Rendering (`packages/engine`)**: All CodeMirror configuration, Lezer parsing syntax trees, custom Markdown decorations, and preview modes must live in the engine. It must remain **completely independent** of React and Tauri APIs.
- **Frontend Logic (`apps/desktop/src`)**: Handles React component lifecycle, user settings, editor hosting, keymaps, and communication with the Tauri API. Do not write raw file parser logic here.
- **OS Actions (`apps/desktop/src-tauri`)**: Handles file system read/write, window sizing, menu bars, and other native features. Keep JavaScript-side code clean of native operations; trigger them via Tauri Commands (like `invoke("read_file", { path })`).

---

## 5. Coding Conventions
- **TypeScript**: Always write strictly typed TypeScript code. Avoid `any` types.
- **Exports**: Use named exports exclusively (`export const createEditor = ...`). Never use default exports unless modifying files that require them (like the React root application wrapper `App.tsx`).
- **CodeMirror Integration**: In `createEditor` (within `@omd/desktop`), do **NOT** enable:
  - `indentOnInput`
  - `closeBrackets`
  - `autocompletion`
  These editing features conflict with the Markdown live-preview decorators.
- **Stable References for Handlers**: When registering window-level listeners (such as shortcut triggers in `App.tsx`), utilize stable `useRef` handlers referencing the mutable state to avoid registering/deregistering event listeners repeatedly on every state change.
