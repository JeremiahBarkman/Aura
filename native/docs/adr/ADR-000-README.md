# Aura Architecture Decision Records (ADR)

## Purpose

Architecture Decision Records (ADRs) document important engineering decisions made during the development of Aura.

Unlike design documents, ADRs answer one specific question:

> **Why did we choose this approach?**

Months or years later, developers should be able to understand not only *what* Aura does, but *why* it was designed that way.

---

## Why ADRs?

During development there are many possible solutions to a problem.

For example:

- Media Foundation vs DirectShow
- Shared Memory vs TCP
- Named Pipes vs Localhost HTTP
- BGRA vs NV12
- Electron vs Native UI

Each choice has consequences.

Rather than relying on memory or chat history, Aura records those decisions permanently.

---

## ADR Format

Each ADR follows the same structure.

### Title

A short description of the decision.

Example:

```
ADR-002
Use Named Pipes for Electron → Native communication
```

---

### Status

Examples:

Accepted

Proposed

Deprecated

Superseded

---

### Context

What problem were we trying to solve?

---

### Decision

What was chosen?

---

### Alternatives Considered

Examples:

TCP

Unix Domain Socket

COM

Shared Memory only

---

### Consequences

Positive:

Negative:

Tradeoffs:

---

### Future Review

Should this decision ever be revisited?

If so, under what circumstances?

---

## Numbering

ADRs are sequential.

```
ADR-001

ADR-002

ADR-003
```

Numbers are never reused.

---

## Modification Policy

Accepted ADRs should not be edited significantly.

If an architectural decision changes:

Create a new ADR.

Reference the previous one.

Maintain historical context.

---

## Relationship to Other Documents

Architecture documents describe:

**How Aura is organized.**

Development Guidelines describe:

**How Aura code is written.**

AFTS describes:

**How Aura frames are transported.**

ADRs describe:

**Why important engineering decisions were made.**

---

## Long-Term Goal

Over time, the ADR collection should become the engineering history of Aura.

Future contributors should be able to understand the evolution of the system simply by reading the ADRs in chronological order.