# CLAUDE.md

# Aura Development Guide

This file defines how Claude Code should operate when working on the Aura project.

Aura is a Windows-first, local-first AI platform. Stability, clarity, and maintainability are valued more highly than cleverness or unnecessary abstraction.

---

# Core Philosophy

Aura is intentionally engineered around these principles:

- Local-first whenever practical.
- User privacy before convenience.
- Simple architecture over clever architecture.
- Incremental evolution instead of rewrites.
- Explicit behavior over hidden magic.
- Human-readable code over "smart" code.
- Performance matters.
- Predictability matters more than novelty.

When in doubt, preserve existing architecture rather than inventing a new one.

---

# 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State assumptions explicitly.
- If multiple interpretations exist, explain them.
- Recommend simpler approaches when appropriate.
- Push back when something is unnecessarily complicated.
- If requirements are unclear, stop and ask.

Never silently invent requirements.

---

# 2. Simplicity First

**Minimum code that solves the requested problem.**

Do not add:

- future-proof abstractions
- optional configuration
- plugin systems
- dependency injection
- generic frameworks
- speculative features

unless explicitly requested.

Always ask:

> "Would a senior engineer remove half of this?"

If yes, simplify.

---

# 3. Surgical Changes

Modify only what is necessary.

Do not:

- reformat unrelated files
- rename variables unnecessarily
- reorganize folders
- change coding style
- "clean up" unrelated code

Only remove code that your own changes have made obsolete.

If unrelated problems are discovered:

Mention them.

Do not fix them unless requested.

---

# 4. Goal-Driven Execution

Every task should begin with a short implementation plan.

Example:

1. Investigate
2. Implement
3. Verify
4. Report

For bug fixes:

- reproduce
- isolate
- fix
- verify

Do not stop after writing code.

Verify it.

Whenever practical:

- build
- lint
- run
- test

before declaring success.

---

# 5. Understand Before Modifying

Before editing code:

Understand the execution flow.

Trace:

request ↓ API ↓ business logic ↓ database ↓ UI

Do not modify code you have not inspected.

If unsure where behavior originates:

Search first.

Guessing is prohibited.

---

# 6. Aura Architecture

Aura is intentionally modular.

Current major systems include:

- Electron application
- Electron main process
- Renderer/UI
- Local Express web server
- SQLite database
- Whisper transcription
- Ollama local LLM
- Semantic record library
- Image generation pipeline
- Scene composition engine
- Translation subsystem
- Virtual camera pipeline
- Settings/configuration system

Preserve module boundaries.

Avoid cross-module coupling.

---

# 7. Local-First Philosophy

Aura is designed to work locally.

Do not introduce cloud dependencies unless explicitly requested.

Cloud services should always be optional.

Never replace an existing local solution with an online one.

---

# 8. Performance Matters

Aura processes:

- live camera frames
- AI inference
- image rendering
- translation
- transcription

Performance is a feature.

Avoid:

- unnecessary allocations
- polling when events are possible
- duplicate processing
- unnecessary copies
- blocking the UI thread

When adding processing:

Consider CPU usage.

Consider GPU usage.

Consider memory usage.

Explain any expected performance impact.

---

# 9. Translation System

Aura's translation architecture follows these principles:

- Invisible to the user
- Universal
- Local whenever practical
- Single language selection in Settings
- Minimal latency
- No workflow changes

Do not expose translation complexity in the UI.

---

# 10. Virtual Camera

Aura's virtual camera is a core product feature.

Treat it as production infrastructure.

Avoid changes that increase latency.

Avoid unnecessary frame copies.

Avoid architecture changes without discussion.

---

# 11. User Experience

Aura should feel:

- calm
- intelligent
- effortless
- responsive

Avoid unnecessary dialogs.

Avoid interrupting workflows.

Reduce clicks whenever possible.

If something can be automated safely, recommend it.

---

# 12. Documentation

When implementing features:

Update documentation if behavior changes.

Keep comments focused on **why**, not **what**.

Avoid obvious comments.

---

# 13. Git Safety

Never perform these operations without explicit permission:

- git reset --hard
- force push
- branch deletion
- history rewriting
- mass file deletion

Do not commit automatically.

Do not create commits unless requested.

---

# 14. Secrets

Never:

- print API keys
- expose .env values
- hardcode credentials
- commit secrets

Use environment variables.

---

# 15. Windows Environment

Aura currently targets:

- Windows 11
- Node.js
- Electron
- Visual Studio
- C++
- Media Foundation
- PowerShell

Prefer Windows-native solutions.

Do not replace Windows functionality with Linux-only alternatives.

---

# 16. Working With Jeremiah

Jeremiah is the product architect.

He prefers:

- exact file paths
- complete code blocks
- beginner-friendly explanations
- step-by-step instructions
- minimal ambiguity

When suggesting changes:

Explain:

- why
- where
- expected result

If multiple approaches exist:

Recommend one.

Explain why.

---

# 17. Large Tasks

For significant features:

Do not immediately write code.

Instead:

1. Analyze
2. Explain architecture
3. Identify affected files
4. Describe risks
5. Propose implementation
6. Wait if requirements are ambiguous
7. Implement
8. Verify
9. Summarize changes

---

# 18. Definition of Done

A task is complete only when:

✓ Requested functionality exists

✓ Existing functionality still works

✓ Build passes (when applicable)

✓ Tests pass (when applicable)

✓ No unnecessary code was added

✓ No unrelated files changed

✓ Documentation updated if needed

✓ User can understand what changed

---

# Repository Documentation

This repository contains project documentation in addition to source code.

Before implementing significant changes, consult these documents when present:

- ARCHITECTURE.md — Current system architecture and execution flow.
- TRANSLATION.md — Universal translation subsystem.
- VIRTUAL_CAMERA.md — Native virtual camera architecture.
- INSTALLER.md — Packaging and deployment.
- ROADMAP.md — Long-term product direction.

Do not duplicate their contents inside CLAUDE.md.

CLAUDE.md defines behavior.

The other documents define the software.

---

# Final Principle

Optimize for maintainability.

Optimize for clarity.

Optimize for correctness.

Do not optimize for impressiveness.

The best Aura code should look obvious in hindsight.
