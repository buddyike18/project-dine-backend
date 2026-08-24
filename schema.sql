--
-- PostgreSQL database dump
--

\restrict Oi3PVOSl8FBGTUDTgTd6NpgycjQ7RPf8rH8M1KPrchJrnQtoF8hGPn31s4e3uOC

-- Dumped from database version 17.4
-- Dumped by pg_dump version 17.7 (Postgres.app)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: menu_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.menu_type AS ENUM (
    'FOOD',
    'DRINKS'
);


--
-- Name: order_actor_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_actor_type AS ENUM (
    'USER',
    'CUSTOMER',
    'SYSTEM',
    'PAYMENT_PROVIDER'
);


--
-- Name: order_event_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_event_type AS ENUM (
    'ORDER_CREATED',
    'PAYMENT_RECORDED',
    'STATUS_CHANGED',
    'RECALL',
    'ORDER_VOIDED',
    'ORDER_COMPED',
    'ORDER_OVERRIDE'
);


--
-- Name: order_origin; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_origin AS ENUM (
    'STAFF',
    'CUSTOMER'
);


--
-- Name: order_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_status AS ENUM (
    'OPEN',
    'SENT',
    'READY',
    'CLOSED',
    'CANCELLED'
);


--
-- Name: order_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_type AS ENUM (
    'DINE_IN',
    'TAKEOUT'
);


--
-- Name: payment_provider; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_provider AS ENUM (
    'STRIPE'
);


--
-- Name: payment_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_status AS ENUM (
    'REQUIRES_PAYMENT',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'REQUIRES_PAYMENT_METHOD',
    'REQUIRES_CONFIRMATION',
    'PROCESSING'
);


--
-- Name: role_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.role_type AS ENUM (
    'Manager',
    'Employee',
    'Customer'
);


--
-- Name: dine_enforce_canonical_order_lifecycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.dine_enforce_canonical_order_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'OPEN' THEN
      RAISE EXCEPTION
        'New orders must be created in OPEN status'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  -- Same-state retries are allowed as database no-ops.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Canonical send: OPEN -> SENT.
  IF OLD.status = 'OPEN'
     AND NEW.status = 'SENT'
  THEN
    NEW.sent_at := COALESCE(NEW.sent_at, now());
    NEW.ready_at := NULL;
    NEW.closed_at := NULL;
    RETURN NEW;
  END IF;

  -- Kitchen completion: SENT -> READY.
  IF OLD.status = 'SENT'
     AND NEW.status = 'READY'
  THEN
    NEW.ready_at := now();
    NEW.closed_at := NULL;
    RETURN NEW;
  END IF;

  -- Manager recall: READY -> SENT.
  IF OLD.status = 'READY'
     AND NEW.status = 'SENT'
  THEN
    NEW.sent_at := COALESCE(NEW.sent_at, now());
    NEW.ready_at := NULL;
    NEW.recalled_at := now();
    NEW.closed_at := NULL;
    RETURN NEW;
  END IF;

  -- Canonical close: READY -> CLOSED.
  IF OLD.status = 'READY'
     AND NEW.status = 'CLOSED'
  THEN
    NEW.closed_at := now();
    RETURN NEW;
  END IF;

  -- Exceptional terminal cancellation.
  IF OLD.status IN ('OPEN', 'SENT', 'READY')
     AND NEW.status = 'CANCELLED'
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Illegal canonical order lifecycle transition: % -> %',
    OLD.status,
    NEW.status
    USING ERRCODE = '23514';
END;
$$;


--
-- Name: dine_enforce_order_lifecycle_timestamps(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.dine_enforce_order_lifecycle_timestamps() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- OPEN has not entered the kitchen lifecycle.
  IF NEW.status = 'OPEN'
     AND (
       NEW.sent_at IS NOT NULL
       OR NEW.ready_at IS NOT NULL
       OR NEW.recalled_at IS NOT NULL
       OR NEW.closed_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION
      'OPEN order has invalid lifecycle timestamps'
      USING ERRCODE = '23514';
  END IF;

  -- SENT includes both first send and manager recall.
  -- A recalled order may retain recalled_at, but ready_at must be cleared.
  IF NEW.status = 'SENT'
     AND (
       NEW.sent_at IS NULL
       OR NEW.ready_at IS NOT NULL
       OR NEW.closed_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION
      'SENT order has invalid lifecycle timestamps'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'READY'
     AND (
       NEW.sent_at IS NULL
       OR NEW.ready_at IS NULL
       OR NEW.closed_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION
      'READY order has invalid lifecycle timestamps'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'CLOSED'
     AND (
       NEW.sent_at IS NULL
       OR NEW.ready_at IS NULL
       OR NEW.closed_at IS NULL
     )
  THEN
    RAISE EXCEPTION
      'CLOSED order has invalid lifecycle timestamps'
      USING ERRCODE = '23514';
  END IF;

  -- CANCELLED preserves any legitimate prior sent/ready history.
  -- It is not a successful close and therefore cannot have closed_at.
  IF NEW.status = 'CANCELLED'
     AND (
       NEW.closed_at IS NOT NULL
       OR (
         NEW.ready_at IS NOT NULL
         AND NEW.sent_at IS NULL
       )
     )
  THEN
    RAISE EXCEPTION
      'CANCELLED order cannot have closed_at'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: dine_enforce_order_send_eligibility(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.dine_enforce_order_send_eligibility() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.status IN ('SENT', 'READY', 'CLOSED')
     AND (
       COALESCE(NEW.paid_cents, 0)
       + COALESCE(NEW.comped_cents, 0)
     ) < COALESCE(NEW.total_cents, 0)
  THEN
    RAISE EXCEPTION
      'Order cannot remain beyond OPEN unless financially settled (status %, paid_cents %, comped_cents %, total_cents %)',
      NEW.status,
      NEW.paid_cents,
      NEW.comped_cents,
      NEW.total_cents
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: enforce_order_event_amount(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_order_event_amount() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  authoritative_total_cents bigint;
  event_amount_cents bigint;
  existing_financial_event_cents bigint;
BEGIN
  IF NEW.event_type NOT IN (
    'ORDER_COMPED',
    'PAYMENT_RECORDED'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT orders.total_cents::bigint
  INTO authoritative_total_cents
  FROM public.orders orders
  WHERE orders.id = NEW.order_id
    AND orders.restaurant_id = NEW.restaurant_id
  FOR NO KEY UPDATE;

  IF authoritative_total_cents IS NULL THEN
    RAISE EXCEPTION
      'Order event references an unavailable authoritative order total';
  END IF;

  IF NEW.event_type = 'ORDER_COMPED' THEN
    IF NOT (
      (NEW.meta ->> 'comped_cents') ~ '^[0-9]+$'
    ) THEN
      RAISE EXCEPTION
        'ORDER_COMPED comped_cents must be a nonnegative integer string';
    END IF;

    event_amount_cents :=
      (NEW.meta ->> 'comped_cents')::bigint;

    IF event_amount_cents <= 0 THEN
      RAISE EXCEPTION
        'ORDER_COMPED comped_cents % must be greater than zero',
        event_amount_cents;
    END IF;

  ELSIF NEW.event_type = 'PAYMENT_RECORDED' THEN
    IF NOT (
      (NEW.meta ->> 'amount_cents') ~ '^[0-9]+$'
    ) THEN
      RAISE EXCEPTION
        'PAYMENT_RECORDED amount_cents must be a nonnegative integer string';
    END IF;

    event_amount_cents :=
      (NEW.meta ->> 'amount_cents')::bigint;

    IF event_amount_cents <= 0 THEN
      RAISE EXCEPTION
        'PAYMENT_RECORDED amount_cents % must be greater than zero',
        event_amount_cents;
    END IF;
  END IF;

  SELECT COALESCE(
    SUM(
      CASE
        WHEN order_events.event_type = 'PAYMENT_RECORDED'
          AND (
            order_events.meta ->> 'amount_cents'
          ) ~ '^[0-9]+$'
          THEN (
            order_events.meta ->> 'amount_cents'
          )::bigint

        WHEN order_events.event_type = 'ORDER_COMPED'
          AND (
            order_events.meta ->> 'comped_cents'
          ) ~ '^[0-9]+$'
          AND (
            order_events.meta ->> 'comped_cents'
          )::bigint > 0
          THEN (
            order_events.meta ->> 'comped_cents'
          )::bigint

        ELSE 0
      END
    ),
    0
  )
  INTO existing_financial_event_cents
  FROM public.order_events order_events
  WHERE order_events.order_id = NEW.order_id
    AND order_events.restaurant_id = NEW.restaurant_id
    AND order_events.event_type IN (
      'ORDER_COMPED',
      'PAYMENT_RECORDED'
    )
    AND order_events.id IS DISTINCT FROM NEW.id;

  IF (
    existing_financial_event_cents
    + event_amount_cents
  ) > authoritative_total_cents THEN
    RAISE EXCEPTION
      'Cumulative financial event amount % exceeds authoritative order total %',
      existing_financial_event_cents + event_amount_cents,
      authoritative_total_cents;
  END IF;

  RETURN NEW;
END;
$_$;


--
-- Name: prevent_order_total_drift(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_order_total_drift() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
BEGIN
  IF NEW.total_cents IS NOT DISTINCT FROM OLD.total_cents THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.order_events order_events
    WHERE order_events.order_id = OLD.id
      AND order_events.restaurant_id = OLD.restaurant_id
      AND (
        order_events.event_type = 'PAYMENT_RECORDED'
        OR (
          order_events.event_type = 'ORDER_COMPED'
          AND (order_events.meta ->> 'comped_cents') ~ '^[0-9]+$'
          AND (order_events.meta ->> 'comped_cents')::bigint > 0
        )
      )
  ) THEN
    RAISE EXCEPTION
      'orders.total_cents cannot change after payment or positive comp events exist';
  END IF;

  RETURN NEW;
END;
$_$;


--
-- Name: set_restaurant_tables_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_restaurant_tables_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


--
-- Name: set_table_sessions_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_table_sessions_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: inventory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    restaurant_id uuid NOT NULL,
    name text NOT NULL,
    quantity numeric(12,3) DEFAULT 0 NOT NULL,
    unit text NOT NULL,
    low_stock_threshold numeric(12,3) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: menu_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menu_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    restaurant_id uuid NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    menu_type public.menu_type DEFAULT 'FOOD'::public.menu_type NOT NULL
);


--
-- Name: menu_item_modifier_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menu_item_modifier_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    menu_item_id uuid NOT NULL,
    group_id uuid NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: menu_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menu_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    restaurant_id uuid NOT NULL,
    category_id uuid,
    name text NOT NULL,
    price_cents integer NOT NULL,
    tax_rate_bps integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    available boolean DEFAULT true NOT NULL,
    CONSTRAINT menu_items_price_cents_check CHECK ((price_cents >= 0)),
    CONSTRAINT menu_items_tax_rate_bps_check CHECK ((tax_rate_bps >= 0))
);


--
-- Name: modifier_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modifier_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    restaurant_id uuid NOT NULL,
    name text NOT NULL,
    min_select integer DEFAULT 0 NOT NULL,
    max_select integer DEFAULT 1 NOT NULL,
    required boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT modifier_groups_max_select_check CHECK ((max_select >= 0)),
    CONSTRAINT modifier_groups_min_le_max_check CHECK ((min_select <= max_select)),
    CONSTRAINT modifier_groups_min_select_check CHECK ((min_select >= 0)),
    CONSTRAINT modifier_groups_required_matches_min_select CHECK ((required = (min_select > 0)))
);


--
-- Name: modifier_options; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modifier_options (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    name text NOT NULL,
    price_delta_cents integer DEFAULT 0 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT modifier_options_price_delta_cents_check CHECK ((price_delta_cents >= 0))
);


--
-- Name: order_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    restaurant_id uuid NOT NULL,
    order_id uuid NOT NULL,
    event_type public.order_event_type NOT NULL,
    from_status public.order_status,
    to_status public.order_status,
    actor_role public.role_type,
    actor_user_id uuid,
    actor_firebase_uid text,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_type public.order_actor_type NOT NULL,
    idempotency_key text,
    CONSTRAINT chk_order_events_actor_consistency CHECK ((((actor_type = 'USER'::public.order_actor_type) AND (actor_user_id IS NOT NULL)) OR ((actor_type = 'CUSTOMER'::public.order_actor_type) AND (actor_user_id IS NULL) AND (actor_firebase_uid IS NOT NULL) AND (btrim(actor_firebase_uid) <> ''::text)) OR ((actor_type = ANY (ARRAY['SYSTEM'::public.order_actor_type, 'PAYMENT_PROVIDER'::public.order_actor_type])) AND (actor_user_id IS NULL) AND (actor_firebase_uid IS NULL)))),
    CONSTRAINT chk_order_events_idempotency_actor_present CHECK (((idempotency_key IS NULL) OR (event_type <> 'ORDER_CREATED'::public.order_event_type) OR (actor_user_id IS NOT NULL) OR (actor_firebase_uid IS NOT NULL))),
    CONSTRAINT chk_order_events_idempotency_key_nonblank CHECK (((idempotency_key IS NULL) OR (btrim(idempotency_key) <> ''::text))),
    CONSTRAINT chk_order_events_meta_object CHECK ((jsonb_typeof(meta) = 'object'::text)),
    CONSTRAINT chk_order_events_semantics CHECK ((((event_type = 'ORDER_CREATED'::public.order_event_type) AND (from_status IS NULL) AND (NOT (to_status IS DISTINCT FROM 'OPEN'::public.order_status))) OR ((event_type = 'STATUS_CHANGED'::public.order_event_type) AND (from_status IS NOT NULL) AND (to_status IS NOT NULL) AND (from_status <> to_status)) OR ((event_type = 'RECALL'::public.order_event_type) AND (NOT (from_status IS DISTINCT FROM 'READY'::public.order_status)) AND (NOT (to_status IS DISTINCT FROM 'SENT'::public.order_status))) OR ((event_type = 'ORDER_VOIDED'::public.order_event_type) AND (from_status IS NOT NULL) AND (NOT (to_status IS DISTINCT FROM 'CANCELLED'::public.order_status)) AND (actor_type = 'USER'::public.order_actor_type) AND (NULLIF(btrim((meta ->> 'reason'::text)), ''::text) IS NOT NULL) AND COALESCE((NULLIF(btrim((meta ->> 'actor_role'::text)), ''::text) = ANY (ARRAY['Owner'::text, 'Manager'::text])), false)) OR ((event_type = 'ORDER_COMPED'::public.order_event_type) AND (actor_type = 'USER'::public.order_actor_type) AND (NULLIF(btrim((meta ->> 'reason'::text)), ''::text) IS NOT NULL) AND COALESCE((NULLIF(btrim((meta ->> 'actor_role'::text)), ''::text) = ANY (ARRAY['Owner'::text, 'Manager'::text])), false) AND (meta ? 'comped_cents'::text) AND ((
CASE
    WHEN ((meta ->> 'comped_cents'::text) ~ '^[0-9]+$'::text) THEN (((meta ->> 'comped_cents'::text))::bigint > 0)
    ELSE false
END AND (COALESCE((meta ->> 'legacy_classification'::text), ''::text) <> 'NO_OP_COMP_ATTEMPT'::text)) OR ((id = ANY (ARRAY['ce789609-3c9f-48ce-a003-624e4fccfffe'::uuid, '5350de42-3664-4b7d-8d42-e7632fc4c654'::uuid, '7d695d1e-6d4d-474d-b514-7ab59c0e1587'::uuid, '4ab584ea-21aa-4c71-9f13-4154d6606d54'::uuid, 'b6d87a21-f183-446e-9ab4-10fbeb5efef6'::uuid, 'beb12727-d987-462d-bf83-ca19528eed7c'::uuid])) AND (NOT ((meta ->> 'comped_cents'::text) IS DISTINCT FROM '0'::text)) AND (NOT ((meta ->> 'legacy_classification'::text) IS DISTINCT FROM 'NO_OP_COMP_ATTEMPT'::text))))) OR ((event_type = 'ORDER_OVERRIDE'::public.order_event_type) AND (actor_type = 'USER'::public.order_actor_type) AND (from_status IS NOT NULL) AND (to_status IS NOT NULL) AND (from_status <> to_status) AND (NULLIF(btrim((meta ->> 'reason'::text)), ''::text) IS NOT NULL) AND COALESCE((NULLIF(btrim((meta ->> 'actor_role'::text)), ''::text) = ANY (ARRAY['Owner'::text, 'Manager'::text])), false)) OR ((event_type = 'PAYMENT_RECORDED'::public.order_event_type) AND (actor_type = 'PAYMENT_PROVIDER'::public.order_actor_type) AND ((NULLIF(btrim(idempotency_key), ''::text) IS NOT NULL) OR (id = ANY (ARRAY['5c281cab-bffc-4cd6-8c2f-b0138c5d99bb'::uuid, '1386583e-9a9b-49e0-a643-fb76a528dedd'::uuid]))) AND (NULLIF(btrim((meta ->> 'provider'::text)), ''::text) IS NOT NULL) AND COALESCE(((meta ->> 'provider'::text) = ANY (ARRAY['STRIPE'::text, 'LEGACY_CUSTOMER_CHECKOUT'::text])), false) AND (NULLIF(btrim((meta ->> 'payment_reference'::text)), ''::text) IS NOT NULL) AND (((meta ->> 'provider'::text) <> 'LEGACY_CUSTOMER_CHECKOUT'::text) OR ((NOT ((meta ->> 'legacy_classification'::text) IS DISTINCT FROM 'LEGACY_CUSTOMER_CHECKOUT'::text)) AND ((meta ->> 'payment_reference'::text) = ('legacy-order:'::text || (order_id)::text)) AND (idempotency_key = ('legacy-payment:'::text || (order_id)::text)))) AND (meta ? 'amount_cents'::text) AND
CASE
    WHEN ((meta ->> 'amount_cents'::text) ~ '^[0-9]+$'::text) THEN (((meta ->> 'amount_cents'::text))::bigint > 0)
    ELSE false
END)))
);


--
-- Name: order_item_modifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_item_modifiers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    restaurant_id uuid NOT NULL,
    order_item_id uuid NOT NULL,
    group_id uuid,
    option_id uuid,
    group_name_snapshot text NOT NULL,
    option_name_snapshot text NOT NULL,
    price_delta_cents_snapshot integer NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_item_modifiers_price_delta_check CHECK ((price_delta_cents_snapshot >= 0)),
    CONSTRAINT order_item_modifiers_qty_check CHECK ((quantity > 0))
);


--
-- Name: order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    restaurant_id uuid NOT NULL,
    order_id uuid NOT NULL,
    menu_item_id uuid,
    name_snapshot text NOT NULL,
    unit_price_cents_snapshot integer NOT NULL,
    quantity integer NOT NULL,
    line_total_cents integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_items_line_total_cents_check CHECK ((line_total_cents >= 0)),
    CONSTRAINT order_items_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT order_items_unit_price_cents_snapshot_check CHECK ((unit_price_cents_snapshot >= 0))
);


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    restaurant_id uuid NOT NULL,
    status public.order_status DEFAULT 'OPEN'::public.order_status NOT NULL,
    type public.order_type DEFAULT 'DINE_IN'::public.order_type NOT NULL,
    created_by_user_id uuid NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    subtotal_cents integer DEFAULT 0 NOT NULL,
    tax_cents integer DEFAULT 0 NOT NULL,
    tip_cents integer DEFAULT 0 NOT NULL,
    total_cents integer DEFAULT 0 NOT NULL,
    sent_at timestamp with time zone,
    ready_at timestamp with time zone,
    paid_cents integer DEFAULT 0 NOT NULL,
    recalled_at timestamp with time zone,
    recall_reason text,
    order_origin public.order_origin NOT NULL,
    table_id text,
    comped_cents integer DEFAULT 0 NOT NULL,
    CONSTRAINT chk_orders_comped_cents_nonnegative CHECK ((COALESCE(comped_cents, 0) >= 0)),
    CONSTRAINT chk_orders_comped_not_over_total CHECK ((COALESCE(comped_cents, 0) <= COALESCE(total_cents, 0))),
    CONSTRAINT chk_orders_paid_cents_nonnegative CHECK ((COALESCE(paid_cents, 0) >= 0)),
    CONSTRAINT chk_orders_paid_not_over_total CHECK ((COALESCE(paid_cents, 0) <= COALESCE(total_cents, 0))),
    CONSTRAINT chk_orders_settlement_not_over_total CHECK (((COALESCE(paid_cents, 0) + COALESCE(comped_cents, 0)) <= COALESCE(total_cents, 0))),
    CONSTRAINT chk_orders_total_cents_nonnegative CHECK ((COALESCE(total_cents, 0) >= 0)),
    CONSTRAINT orders_paid_cents_check CHECK ((paid_cents >= 0)),
    CONSTRAINT orders_subtotal_cents_check CHECK ((subtotal_cents >= 0)),
    CONSTRAINT orders_tax_cents_check CHECK ((tax_cents >= 0)),
    CONSTRAINT orders_tip_cents_check CHECK ((tip_cents >= 0)),
    CONSTRAINT orders_total_cents_check CHECK ((total_cents >= 0))
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    restaurant_id uuid NOT NULL,
    order_id uuid NOT NULL,
    provider public.payment_provider DEFAULT 'STRIPE'::public.payment_provider NOT NULL,
    payment_intent_id text NOT NULL,
    amount_cents integer NOT NULL,
    tip_cents integer DEFAULT 0 NOT NULL,
    status public.payment_status DEFAULT 'REQUIRES_PAYMENT'::public.payment_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    stripe_payment_intent_id text,
    created_by_user_id uuid,
    CONSTRAINT payments_amount_cents_check CHECK ((amount_cents >= 0)),
    CONSTRAINT payments_tip_cents_check CHECK ((tip_cents >= 0))
);


--
-- Name: restaurant_tables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restaurant_tables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    restaurant_id uuid NOT NULL,
    table_id text NOT NULL,
    display_name text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_restaurant_tables_display_name CHECK (((display_name IS NULL) OR ((display_name = btrim(display_name)) AND ((char_length(display_name) >= 1) AND (char_length(display_name) <= 120))))),
    CONSTRAINT chk_restaurant_tables_table_id CHECK (((table_id = btrim(table_id)) AND (table_id ~ '^[A-Za-z0-9_-]{1,64}$'::text))),
    CONSTRAINT chk_restaurant_tables_updated_at CHECK ((updated_at >= created_at))
);


--
-- Name: restaurants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restaurants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    timezone text DEFAULT 'America/New_York'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    active boolean DEFAULT true NOT NULL
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    id integer NOT NULL,
    filename text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: schema_migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.schema_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: schema_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.schema_migrations_id_seq OWNED BY public.schema_migrations.id;


--
-- Name: shifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shifts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    restaurant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    clock_in_at timestamp with time zone DEFAULT now() NOT NULL,
    clock_out_at timestamp with time zone,
    duration_minutes integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stripe_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_webhook_events (
    event_id text NOT NULL,
    type text NOT NULL,
    livemode boolean,
    stripe_created integer,
    object_id text,
    request_id text,
    api_version text,
    payload jsonb NOT NULL,
    status text DEFAULT 'received'::text NOT NULL,
    processed_at timestamp with time zone,
    effects jsonb,
    error_message text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: supplier_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplier_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    restaurant_id uuid NOT NULL,
    supplier_id text NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    order_status text DEFAULT 'Pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: table_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.table_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    restaurant_id uuid NOT NULL,
    table_id text NOT NULL,
    staff_user_id uuid NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: table_session_verification_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.table_session_verification_limits (
    client_key bytea NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    attempt_count integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    limit_type text NOT NULL,
    CONSTRAINT chk_table_session_verification_attempt_count CHECK ((attempt_count >= 1)),
    CONSTRAINT chk_table_session_verification_client_key CHECK ((octet_length(client_key) = 32)),
    CONSTRAINT chk_table_session_verification_limit_type CHECK ((limit_type = ANY (ARRAY['network'::text, 'token'::text])))
);


--
-- Name: table_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.table_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    restaurant_id uuid NOT NULL,
    table_id text NOT NULL,
    token_hash bytea NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_table_sessions_expiration CHECK (((expires_at IS NULL) OR (expires_at > created_at))),
    CONSTRAINT chk_table_sessions_revocation_state CHECK ((((status = 'ACTIVE'::text) AND (revoked_at IS NULL)) OR ((status = 'REVOKED'::text) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT chk_table_sessions_status CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'REVOKED'::text]))),
    CONSTRAINT chk_table_sessions_table_id CHECK (((table_id = btrim(table_id)) AND (table_id ~ '^[A-Za-z0-9_-]{1,64}$'::text))),
    CONSTRAINT chk_table_sessions_token_hash CHECK ((octet_length(token_hash) = 32)),
    CONSTRAINT chk_table_sessions_updated_at CHECK ((updated_at >= created_at))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    firebase_uid text NOT NULL,
    restaurant_id uuid NOT NULL,
    role public.role_type DEFAULT 'Employee'::public.role_type NOT NULL,
    name text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    firebase_deletion_status text DEFAULT 'NONE'::text NOT NULL,
    firebase_deletion_requested_at timestamp with time zone,
    firebase_deletion_completed_at timestamp with time zone,
    firebase_deletion_last_error text,
    firebase_deletion_claimed_at timestamp with time zone,
    firebase_deletion_claim_token uuid,
    CONSTRAINT users_firebase_deletion_state_check CHECK ((((firebase_deletion_status = 'NONE'::text) AND (firebase_deletion_requested_at IS NULL) AND (firebase_deletion_completed_at IS NULL) AND (firebase_deletion_last_error IS NULL) AND (firebase_deletion_claimed_at IS NULL) AND (firebase_deletion_claim_token IS NULL)) OR ((firebase_deletion_status = 'PENDING'::text) AND (firebase_deletion_requested_at IS NOT NULL) AND (firebase_deletion_completed_at IS NULL) AND (firebase_deletion_last_error IS NULL) AND (firebase_deletion_claimed_at IS NULL) AND (firebase_deletion_claim_token IS NULL)) OR ((firebase_deletion_status = 'IN_PROGRESS'::text) AND (firebase_deletion_requested_at IS NOT NULL) AND (firebase_deletion_completed_at IS NULL) AND (firebase_deletion_last_error IS NULL) AND (firebase_deletion_claimed_at IS NOT NULL) AND (firebase_deletion_claim_token IS NOT NULL)) OR ((firebase_deletion_status = 'FAILED'::text) AND (firebase_deletion_requested_at IS NOT NULL) AND (firebase_deletion_completed_at IS NULL) AND (firebase_deletion_last_error IS NOT NULL) AND (firebase_deletion_claimed_at IS NULL) AND (firebase_deletion_claim_token IS NULL)) OR ((firebase_deletion_status = 'COMPLETED'::text) AND (firebase_deletion_requested_at IS NOT NULL) AND (firebase_deletion_completed_at IS NOT NULL) AND (firebase_deletion_last_error IS NULL) AND (firebase_deletion_claimed_at IS NULL) AND (firebase_deletion_claim_token IS NULL)))),
    CONSTRAINT users_firebase_deletion_status_check CHECK ((firebase_deletion_status = ANY (ARRAY['NONE'::text, 'PENDING'::text, 'IN_PROGRESS'::text, 'COMPLETED'::text, 'FAILED'::text])))
);


--
-- Name: schema_migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations ALTER COLUMN id SET DEFAULT nextval('public.schema_migrations_id_seq'::regclass);


--
-- Name: inventory inventory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_pkey PRIMARY KEY (id);


--
-- Name: menu_categories menu_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_categories
    ADD CONSTRAINT menu_categories_pkey PRIMARY KEY (id);


--
-- Name: menu_item_modifier_groups menu_item_modifier_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_item_modifier_groups
    ADD CONSTRAINT menu_item_modifier_groups_pkey PRIMARY KEY (id);


--
-- Name: menu_item_modifier_groups menu_item_modifier_groups_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_item_modifier_groups
    ADD CONSTRAINT menu_item_modifier_groups_unique UNIQUE (menu_item_id, group_id);


--
-- Name: menu_items menu_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT menu_items_pkey PRIMARY KEY (id);


--
-- Name: modifier_groups modifier_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_groups
    ADD CONSTRAINT modifier_groups_pkey PRIMARY KEY (id);


--
-- Name: modifier_options modifier_options_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_options
    ADD CONSTRAINT modifier_options_pkey PRIMARY KEY (id);


--
-- Name: order_events order_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_pkey PRIMARY KEY (id);


--
-- Name: order_item_modifiers order_item_modifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers
    ADD CONSTRAINT order_item_modifiers_pkey PRIMARY KEY (id);


--
-- Name: order_items order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: payments payments_payment_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_payment_intent_id_key UNIQUE (payment_intent_id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: restaurant_tables restaurant_tables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_tables
    ADD CONSTRAINT restaurant_tables_pkey PRIMARY KEY (id);


--
-- Name: restaurants restaurants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurants
    ADD CONSTRAINT restaurants_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_filename_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_filename_key UNIQUE (filename);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (id);


--
-- Name: shifts shifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_pkey PRIMARY KEY (id);


--
-- Name: stripe_webhook_events stripe_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_webhook_events
    ADD CONSTRAINT stripe_webhook_events_pkey PRIMARY KEY (event_id);


--
-- Name: supplier_orders supplier_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_orders
    ADD CONSTRAINT supplier_orders_pkey PRIMARY KEY (id);


--
-- Name: table_assignments table_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.table_assignments
    ADD CONSTRAINT table_assignments_pkey PRIMARY KEY (id);


--
-- Name: table_assignments table_assignments_restaurant_id_table_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.table_assignments
    ADD CONSTRAINT table_assignments_restaurant_id_table_id_key UNIQUE (restaurant_id, table_id);


--
-- Name: table_session_verification_limits table_session_verification_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.table_session_verification_limits
    ADD CONSTRAINT table_session_verification_limits_pkey PRIMARY KEY (limit_type, client_key);


--
-- Name: table_sessions table_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.table_sessions
    ADD CONSTRAINT table_sessions_pkey PRIMARY KEY (id);


--
-- Name: orders uq_orders_restaurant_id_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT uq_orders_restaurant_id_id UNIQUE (restaurant_id, id);


--
-- Name: restaurant_tables uq_restaurant_tables_restaurant_table; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_tables
    ADD CONSTRAINT uq_restaurant_tables_restaurant_table UNIQUE (restaurant_id, table_id);


--
-- Name: users users_firebase_uid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_firebase_uid_key UNIQUE (firebase_uid);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_inventory_restaurant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inventory_restaurant_id ON public.inventory USING btree (restaurant_id);


--
-- Name: idx_menu_categories_restaurant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menu_categories_restaurant_id ON public.menu_categories USING btree (restaurant_id);


--
-- Name: idx_menu_items_category_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menu_items_category_id ON public.menu_items USING btree (category_id);


--
-- Name: idx_menu_items_restaurant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menu_items_restaurant_id ON public.menu_items USING btree (restaurant_id);


--
-- Name: idx_mimg_group_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mimg_group_id ON public.menu_item_modifier_groups USING btree (group_id);


--
-- Name: idx_mimg_menu_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mimg_menu_item_id ON public.menu_item_modifier_groups USING btree (menu_item_id);


--
-- Name: idx_modifier_groups_restaurant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_modifier_groups_restaurant_id ON public.modifier_groups USING btree (restaurant_id);


--
-- Name: idx_modifier_options_group_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_modifier_options_group_id ON public.modifier_options USING btree (group_id);


--
-- Name: idx_order_events_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_events_created_at ON public.order_events USING btree (created_at);


--
-- Name: idx_order_events_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_events_order_id ON public.order_events USING btree (order_id);


--
-- Name: idx_order_events_order_id_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_events_order_id_created_at ON public.order_events USING btree (order_id, created_at);


--
-- Name: idx_order_events_order_timeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_events_order_timeline ON public.order_events USING btree (order_id, created_at, id);


--
-- Name: idx_order_events_restaurant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_events_restaurant_id ON public.order_events USING btree (restaurant_id);


--
-- Name: idx_order_events_restaurant_id_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_events_restaurant_id_created_at ON public.order_events USING btree (restaurant_id, created_at);


--
-- Name: idx_order_events_restaurant_timeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_events_restaurant_timeline ON public.order_events USING btree (restaurant_id, created_at, id);


--
-- Name: idx_order_item_modifiers_order_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_item_modifiers_order_item_id ON public.order_item_modifiers USING btree (order_item_id);


--
-- Name: idx_order_item_modifiers_restaurant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_item_modifiers_restaurant_id ON public.order_item_modifiers USING btree (restaurant_id);


--
-- Name: idx_order_items_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_order_id ON public.order_items USING btree (order_id);


--
-- Name: idx_order_items_restaurant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_restaurant_id ON public.order_items USING btree (restaurant_id);


--
-- Name: idx_orders_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_created_by ON public.orders USING btree (created_by_user_id);


--
-- Name: idx_orders_restaurant_kitchen_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_restaurant_kitchen_status ON public.orders USING btree (restaurant_id, status, opened_at);


--
-- Name: idx_orders_restaurant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_restaurant_status ON public.orders USING btree (restaurant_id, status);


--
-- Name: idx_orders_restaurant_table_opened_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_restaurant_table_opened_at ON public.orders USING btree (restaurant_id, table_id, opened_at DESC);


--
-- Name: idx_payments_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_order_id ON public.payments USING btree (order_id);


--
-- Name: idx_payments_restaurant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_restaurant_id ON public.payments USING btree (restaurant_id);


--
-- Name: idx_shifts_restaurant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_restaurant_id ON public.shifts USING btree (restaurant_id);


--
-- Name: idx_shifts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_user_id ON public.shifts USING btree (user_id);


--
-- Name: idx_stripe_webhook_events_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stripe_webhook_events_created_at ON public.stripe_webhook_events USING btree (created_at);


--
-- Name: idx_supplier_orders_restaurant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supplier_orders_restaurant_id ON public.supplier_orders USING btree (restaurant_id);


--
-- Name: idx_table_assignments_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_table_assignments_restaurant ON public.table_assignments USING btree (restaurant_id);


--
-- Name: idx_table_assignments_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_table_assignments_staff ON public.table_assignments USING btree (staff_user_id);


--
-- Name: idx_users_firebase_deletion_retry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_firebase_deletion_retry ON public.users USING btree (firebase_deletion_status, firebase_deletion_requested_at) WHERE (firebase_deletion_status = ANY (ARRAY['PENDING'::text, 'FAILED'::text]));


--
-- Name: ix_restaurant_tables_active_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_restaurant_tables_active_lookup ON public.restaurant_tables USING btree (restaurant_id, table_id) WHERE (active = true);


--
-- Name: ix_restaurant_tables_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_restaurant_tables_restaurant ON public.restaurant_tables USING btree (restaurant_id, active, table_id);


--
-- Name: ix_table_session_verification_limits_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_table_session_verification_limits_updated ON public.table_session_verification_limits USING btree (updated_at);


--
-- Name: ix_table_sessions_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_table_sessions_restaurant ON public.table_sessions USING btree (restaurant_id, table_id, created_at DESC);


--
-- Name: ix_table_sessions_verification; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_table_sessions_verification ON public.table_sessions USING btree (token_hash, status, expires_at) WHERE ((status = 'ACTIVE'::text) AND (revoked_at IS NULL));


--
-- Name: uq_menu_categories_restaurant_name_ci; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_menu_categories_restaurant_name_ci ON public.menu_categories USING btree (restaurant_id, lower(name));


--
-- Name: uq_menu_items_category_name_ci; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_menu_items_category_name_ci ON public.menu_items USING btree (category_id, lower(name)) WHERE (category_id IS NOT NULL);


--
-- Name: uq_menu_items_uncategorized_restaurant_name_ci; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_menu_items_uncategorized_restaurant_name_ci ON public.menu_items USING btree (restaurant_id, lower(name)) WHERE (category_id IS NULL);


--
-- Name: uq_modifier_groups_restaurant_name_ci; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_modifier_groups_restaurant_name_ci ON public.modifier_groups USING btree (restaurant_id, lower(name));


--
-- Name: uq_modifier_options_group_name_ci; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_modifier_options_group_name_ci ON public.modifier_options USING btree (group_id, lower(name));


--
-- Name: uq_order_events_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_order_events_idempotency ON public.order_events USING btree (restaurant_id, event_type, idempotency_key, (
CASE
    WHEN (actor_user_id IS NOT NULL) THEN ('user:'::text || (actor_user_id)::text)
    WHEN (actor_firebase_uid IS NOT NULL) THEN ('firebase:'::text || actor_firebase_uid)
    ELSE 'system'::text
END)) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_table_sessions_active_table; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_table_sessions_active_table ON public.table_sessions USING btree (restaurant_id, table_id) WHERE ((status = 'ACTIVE'::text) AND (revoked_at IS NULL));


--
-- Name: uq_table_sessions_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_table_sessions_token_hash ON public.table_sessions USING btree (token_hash);


--
-- Name: users_restaurant_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_restaurant_id_idx ON public.users USING btree (restaurant_id);


--
-- Name: ux_payments_stripe_payment_intent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_payments_stripe_payment_intent_id ON public.payments USING btree (stripe_payment_intent_id) WHERE (stripe_payment_intent_id IS NOT NULL);


--
-- Name: orders trg_dine_canonical_order_lifecycle; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_dine_canonical_order_lifecycle BEFORE INSERT OR UPDATE OF status ON public.orders FOR EACH ROW EXECUTE FUNCTION public.dine_enforce_canonical_order_lifecycle();


--
-- Name: orders trg_dine_enforce_order_lifecycle_timestamps; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_dine_enforce_order_lifecycle_timestamps BEFORE INSERT OR UPDATE OF status, sent_at, ready_at, recalled_at, closed_at ON public.orders FOR EACH ROW EXECUTE FUNCTION public.dine_enforce_order_lifecycle_timestamps();


--
-- Name: orders trg_dine_enforce_order_send_eligibility; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_dine_enforce_order_send_eligibility BEFORE INSERT OR UPDATE OF status, paid_cents, comped_cents, total_cents ON public.orders FOR EACH ROW EXECUTE FUNCTION public.dine_enforce_order_send_eligibility();


--
-- Name: order_events trg_enforce_order_event_amount; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_enforce_order_event_amount BEFORE INSERT OR UPDATE OF event_type, order_id, restaurant_id, meta ON public.order_events FOR EACH ROW EXECUTE FUNCTION public.enforce_order_event_amount();


--
-- Name: orders trg_prevent_order_total_drift; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_prevent_order_total_drift BEFORE UPDATE OF total_cents ON public.orders FOR EACH ROW EXECUTE FUNCTION public.prevent_order_total_drift();


--
-- Name: restaurant_tables trg_restaurant_tables_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_restaurant_tables_updated_at BEFORE UPDATE ON public.restaurant_tables FOR EACH ROW EXECUTE FUNCTION public.set_restaurant_tables_updated_at();


--
-- Name: table_sessions trg_table_sessions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_table_sessions_updated_at BEFORE UPDATE ON public.table_sessions FOR EACH ROW EXECUTE FUNCTION public.set_table_sessions_updated_at();


--
-- Name: order_events fk_order_events_actor_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT fk_order_events_actor_user FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: order_events fk_order_events_restaurant; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT fk_order_events_restaurant FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE RESTRICT;


--
-- Name: order_events fk_order_events_restaurant_order; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT fk_order_events_restaurant_order FOREIGN KEY (restaurant_id, order_id) REFERENCES public.orders(restaurant_id, id) ON DELETE RESTRICT;


--
-- Name: restaurant_tables fk_restaurant_tables_restaurant; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_tables
    ADD CONSTRAINT fk_restaurant_tables_restaurant FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: table_sessions fk_table_sessions_created_by_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.table_sessions
    ADD CONSTRAINT fk_table_sessions_created_by_user FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: table_sessions fk_table_sessions_restaurant; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.table_sessions
    ADD CONSTRAINT fk_table_sessions_restaurant FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: table_sessions fk_table_sessions_restaurant_table; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.table_sessions
    ADD CONSTRAINT fk_table_sessions_restaurant_table FOREIGN KEY (restaurant_id, table_id) REFERENCES public.restaurant_tables(restaurant_id, table_id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: inventory inventory_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory
    ADD CONSTRAINT inventory_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: menu_categories menu_categories_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_categories
    ADD CONSTRAINT menu_categories_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: menu_item_modifier_groups menu_item_modifier_groups_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_item_modifier_groups
    ADD CONSTRAINT menu_item_modifier_groups_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.modifier_groups(id) ON DELETE CASCADE;


--
-- Name: menu_item_modifier_groups menu_item_modifier_groups_menu_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_item_modifier_groups
    ADD CONSTRAINT menu_item_modifier_groups_menu_item_id_fkey FOREIGN KEY (menu_item_id) REFERENCES public.menu_items(id) ON DELETE CASCADE;


--
-- Name: menu_items menu_items_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT menu_items_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.menu_categories(id) ON DELETE SET NULL;


--
-- Name: menu_items menu_items_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT menu_items_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: modifier_groups modifier_groups_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_groups
    ADD CONSTRAINT modifier_groups_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: modifier_options modifier_options_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_options
    ADD CONSTRAINT modifier_options_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.modifier_groups(id) ON DELETE CASCADE;


--
-- Name: order_item_modifiers order_item_modifiers_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers
    ADD CONSTRAINT order_item_modifiers_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.modifier_groups(id) ON DELETE SET NULL;


--
-- Name: order_item_modifiers order_item_modifiers_option_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers
    ADD CONSTRAINT order_item_modifiers_option_id_fkey FOREIGN KEY (option_id) REFERENCES public.modifier_options(id) ON DELETE SET NULL;


--
-- Name: order_item_modifiers order_item_modifiers_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers
    ADD CONSTRAINT order_item_modifiers_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.order_items(id) ON DELETE CASCADE;


--
-- Name: order_item_modifiers order_item_modifiers_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers
    ADD CONSTRAINT order_item_modifiers_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_menu_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_menu_item_id_fkey FOREIGN KEY (menu_item_id) REFERENCES public.menu_items(id) ON DELETE SET NULL;


--
-- Name: order_items order_items_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: orders orders_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: orders orders_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: payments payments_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: payments payments_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: shifts shifts_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: shifts shifts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: supplier_orders supplier_orders_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplier_orders
    ADD CONSTRAINT supplier_orders_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: table_assignments table_assignments_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.table_assignments
    ADD CONSTRAINT table_assignments_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: table_assignments table_assignments_staff_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.table_assignments
    ADD CONSTRAINT table_assignments_staff_user_id_fkey FOREIGN KEY (staff_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: users users_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

\unrestrict Oi3PVOSl8FBGTUDTgTd6NpgycjQ7RPf8rH8M1KPrchJrnQtoF8hGPn31s4e3uOC

