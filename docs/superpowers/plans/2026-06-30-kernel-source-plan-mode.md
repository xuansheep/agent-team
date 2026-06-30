# Kernel Plan Mode Source Of Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make Kernel the only Plan Mode source of truth while preserving workflow as the approved-plan execution backend.

**Architecture:** KernelSession stores Plan Mode state, QueryEngine owns Plan Mode turns, PlanModeController owns approval, PermissionKernel owns write boundaries, and TUI/SDK/workflow become adapters.

**Tech Stack:** TypeScript, Node node:test, React/Ink TUI, existing workflow engine.

---

- [ ] Task 1: Add Kernel app-state projection, intents, snapshot and restore tests, then implementation.
- [ ] Task 2: Add PlanModeController approval hash/id/handoff tests, then implementation.
- [ ] Task 3: Add Plan Mode attachment/tool visibility tests, then implementation.
- [ ] Task 4: Add PermissionKernel plan-file-only write tests, then implementation.
- [ ] Task 5: Add QueryEngine pending interaction and ExitPlanMode ownership tests, then implementation.
- [ ] Task 6: Add TUI adapter intent projection tests, then implementation.
- [ ] Task 7: Add SDK/workflow Kernel state tests, then implementation.
- [ ] Task 8: Run focused and full verification: npm run build:test, focused tests, npm test, git diff --check.
