

# Dine Backend Contract (Immutable)

This document defines the non-negotiable behavior of the Dine backend.
No backend work is considered “complete” unless it conforms to this contract.

## Core Value
Dine is a table-service ordering and payment platform that lets guests transact on their phones while restaurants control timing, flow, and hospitality.

For MVP 2:
- When a guest pays, the order is immediately approved and sent to the kitchen.
- The kitchen may recall an order if it is incorrect.
- Only Managers may void, comp, or refund an order.

---

## Definitions
### Restaurant Control
“Restaurant control” means the backend enforces:
- Only authorized restaurant staff can change operational order status.
- The kitchen queue reflects backend truth, not client timing or UI state.

### Order Certainty
“Order certainty” means:
- A successful payment yields exactly one approved kitchen ticket.
- The order never disappears, duplicates, or becomes ambiguous.
- All reads reflect the latest committed backend state.

---

## Authoritative Source of Truth
- PostgreSQL is the system of record for orders, items, and payments.
- Stripe webhooks are the source of truth for payment success/failure.
- Backend must be correct under retries, replays, delays, and concurrency.

---

## Entities (Canonical)
The backend must maintain these canonical entities:
- restaurants
- users (staff + customers; mapped from Firebase UID)
- orders
- order_items
- payments (Stripe PaymentIntent mapping)
- order_events (audit trail; mandatory)

---

## Order Lifecycle (State Machine)

### Order States
Orders use `order_status`:
- OPEN
- SENT
- READY
- CLOSED
- CANCELLED

### Allowed Transitions (Exhaustive)
Only these transitions are permitted:

1. OPEN → SENT  
   Trigger: Stripe `payment_intent.succeeded` reconciliation  
   Guard: order must be fully paid at transition time

2. SENT → READY  
   Trigger: kitchen or employee action

3. READY → CLOSED  
   Trigger: employee or manager action

4. READY → SENT (RECALL)  
   Trigger: kitchen or employee action  
   Must record recall metadata and audit event

5. ANY → CANCELLED  
   Trigger: Manager-only action (void / comp / refund / cancel)  
   Must record cancellation reason and audit event

All other transitions are illegal and must be rejected.

### Monotonicity Rule
Orders must not rewind except via explicit READY → SENT recall.

---

## Payment Contract

### Canonical Payment Identifier
- Stripe PaymentIntent ID is the canonical payment identifier.
- The backend must store a one-to-one mapping between a Stripe PaymentIntent and a payment record.

### Stripe Authority
- `payment_intent.succeeded` is authoritative.
- Webhook signatures must be verified.

### Idempotency & Replay Safety
- Duplicate or replayed webhook events must not create side effects.
- A PaymentIntent must not credit an order more than once.
- Payment success must not create duplicate kitchen tickets.

### Payment → Order Approval
On `payment_intent.succeeded`:
1. Resolve the associated order
2. Mark payment status = SUCCEEDED
3. Credit paid_cents (bounded by total_cents)
4. Transition order OPEN → SENT if fully paid
5. Write audit events

All steps must occur in a single DB transaction.

---

## Database-Level Invariants

### Paid-Before-Sent
If orders.status = SENT then orders.paid_cents >= orders.total_cents.

### Unique Payment Mapping
- One PaymentIntent → one payment record
- One payment record → one order

### Read-After-Write
Committed writes must be immediately readable.

### Auditability
All transitions and managerial actions must write immutable audit events.

---

## Authorization (RBAC)

### Roles
- Manager
- Employee
- Customer

### Permissions
- Only authenticated users may access the API (except health).
- Only Manager and Employee may change operational order status.
- Only Manager may cancel, void, comp, or refund orders.

Authorization must not fail open.

---

## Audit Trail (order_events)

Audit events must include:
- order_id
- restaurant_id
- actor_user_id (nullable for system)
- actor_role
- event_type
- from_status
- to_status
- metadata (JSON)
- created_at

---

## Completion Criteria
The backend is complete only when:
1. All endpoints conform to this contract
2. DB-level invariants prevent invalid states
3. Webhook reconciliation is signature-verified and idempotent
4. State transitions are enforced exactly as defined
5. Audit events are written for all required actions
6. Backend-only tests prove determinism and replay safety