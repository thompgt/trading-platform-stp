-- The order domain: the thing the Blotter and Portfolio pages currently fake.
--
-- Design decisions worth stating, because they are what make this an auditable trade store
-- rather than a table of rows that happen to describe orders:
--
--   * Money is integer cents (BIGINT), never floating point, matching posttrade/money.js.
--     A price is stored in ten-thousandths of a cent so a $123.4567 limit is exact.
--   * Quantities are NUMERIC(28,8), not floats: fractional shares are real, and 0.1 + 0.2
--     must not be 0.30000000000000004 in a position.
--   * Every state change appends to order_events and nothing ever updates or deletes there.
--     That table is the audit trail; `orders` is a materialized view of its own history,
--     kept for the queries a blotter actually runs.
--   * Timestamps are TIMESTAMPTZ. A trading platform that stores naive local time will be
--     wrong twice a year, and settlement dates are exactly where that bites.

-- Order lifecycle. The transitions between these are enforced in code (orders/stateMachine.js)
-- rather than by the database, because a state machine needs to reject a transition with a
-- reason a caller can read, not with a constraint violation.
CREATE TYPE order_status AS ENUM (
  'NEW',              -- accepted, not yet risk-checked
  'PENDING_RISK',     -- with the pre-trade risk gate
  'REJECTED',         -- refused by risk or validation; terminal
  'WORKING',          -- live at the venue
  'PARTIALLY_FILLED', -- some quantity executed, remainder still working
  'FILLED',           -- fully executed
  'CANCELLED',        -- pulled before completion; terminal
  'ALLOCATED',        -- allocated to accounts, ready for settlement
  'SETTLED'           -- cash and securities exchanged; terminal
);

CREATE TYPE order_side AS ENUM ('BUY', 'SELL');
CREATE TYPE order_type AS ENUM ('MARKET', 'LIMIT');
CREATE TYPE time_in_force AS ENUM ('DAY', 'IOC', 'FOK', 'GTC');

CREATE TABLE orders (
  id              UUID           PRIMARY KEY,
  -- The caller's own reference. Unique per account so a client can look an order up by the
  -- id it already has, without holding ours.
  client_order_id TEXT           NOT NULL,
  account_id      TEXT           NOT NULL,
  symbol          TEXT           NOT NULL,
  side            order_side     NOT NULL,
  order_type      order_type     NOT NULL,
  time_in_force   time_in_force  NOT NULL DEFAULT 'DAY',
  quantity        NUMERIC(28,8)  NOT NULL CHECK (quantity > 0),
  -- Ten-thousandths of a cent, so $123.4567 is 1234567. NULL for a market order, and the
  -- constraint below makes "limit order with no price" unrepresentable rather than merely
  -- discouraged.
  limit_price     BIGINT         CHECK (limit_price IS NULL OR limit_price > 0),
  status          order_status   NOT NULL DEFAULT 'NEW',
  filled_quantity NUMERIC(28,8)  NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
  -- Volume-weighted average of the fills, in the same units as limit_price. NULL until the
  -- first fill, rather than 0, because zero is a price and "no price yet" is not.
  avg_fill_price  BIGINT,
  -- Optimistic concurrency. Every write asserts the version it read and bumps it; two
  -- concurrent amendments cannot silently overwrite each other.
  version         INTEGER        NOT NULL DEFAULT 1,
  created_by      TEXT           NOT NULL,
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CONSTRAINT limit_orders_have_a_price
    CHECK ((order_type = 'LIMIT') = (limit_price IS NOT NULL)),
  CONSTRAINT cannot_fill_more_than_ordered
    CHECK (filled_quantity <= quantity),
  CONSTRAINT client_order_id_unique_per_account
    UNIQUE (account_id, client_order_id)
);

-- The blotter's default view: an account's orders, newest first.
CREATE INDEX orders_account_created_idx ON orders (account_id, created_at DESC);
-- "What is still live?" — the query the execution loop runs constantly.
CREATE INDEX orders_working_idx ON orders (symbol, status)
  WHERE status IN ('WORKING', 'PARTIALLY_FILLED');

-- Idempotency for order submission.
--
-- A client that submits an order and loses the response has no safe move: retrying may
-- double-book, and not retrying may lose the order. An idempotency key makes the retry safe —
-- the second request returns the first one's result instead of creating a second order.
--
-- The stored response is what makes it work: a retry after the original completed must return
-- the same body, not merely avoid inserting twice.
CREATE TABLE idempotency_keys (
  key           TEXT        PRIMARY KEY,
  account_id    TEXT        NOT NULL,
  -- A hash of the request body. The same key with a *different* body is a client bug, and
  -- returning the first order for it would be silently wrong.
  request_hash  TEXT        NOT NULL,
  order_id      UUID        REFERENCES orders(id),
  response_body JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- Executions (fills). Append-only: a fill that turns out to be wrong is corrected with a
-- bust/correction record, never by editing history.
CREATE TABLE executions (
  id            UUID           PRIMARY KEY,
  order_id      UUID           NOT NULL REFERENCES orders(id),
  -- The venue's own id for the fill, unique per venue: the natural idempotency key for a
  -- fill feed that may replay.
  venue_exec_id TEXT           NOT NULL,
  venue         TEXT           NOT NULL,
  quantity      NUMERIC(28,8)  NOT NULL CHECK (quantity > 0),
  price         BIGINT         NOT NULL CHECK (price > 0),
  -- Integer cents, positive, charged to the account regardless of side.
  fee_cents     BIGINT         NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  executed_at   TIMESTAMPTZ    NOT NULL,
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CONSTRAINT venue_exec_id_unique_per_venue UNIQUE (venue, venue_exec_id)
);

CREATE INDEX executions_order_idx ON executions (order_id, executed_at);

-- The audit trail. Append-only by convention *and* by grant: nothing in the application ever
-- issues UPDATE or DELETE against this table. Replaying it in sequence reproduces every
-- order's history exactly, which is what makes a lifecycle timeline possible and what a
-- regulator-shaped review would actually ask for.
CREATE TABLE order_events (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    UUID        NOT NULL REFERENCES orders(id),
  -- Monotonic per order, starting at 1. Gives the timeline a total order that does not
  -- depend on timestamp resolution, and makes a missing event detectable.
  sequence    INTEGER     NOT NULL,
  event_type  TEXT        NOT NULL,
  from_status order_status,
  to_status   order_status,
  -- Whatever the transition needs to be reconstructible: the fill, the risk decision, the
  -- rejection reason. Deliberately schemaless — the shape differs per event type and
  -- freezing it in columns would mean a migration per new event.
  payload     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  actor       TEXT        NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT order_event_sequence_unique UNIQUE (order_id, sequence)
);

CREATE INDEX order_events_order_idx ON order_events (order_id, sequence);
CREATE INDEX order_events_occurred_idx ON order_events (occurred_at DESC);
