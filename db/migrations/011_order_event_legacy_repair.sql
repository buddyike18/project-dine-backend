-- Phase 40F: authoritative one-time repair of known legacy lifecycle events.
-- Repairs only the 18 event IDs confirmed against existing database records.
-- Must run before 012_lifecycle_event_normalization.sql.

BEGIN;

DO $$
DECLARE
    invalid_count integer;
BEGIN
    WITH expected(event_id, expected_event_type, expected_order_id) AS (
        VALUES
            ('1b44188b-2f49-48ba-a630-2219c15dcd31'::uuid, 'ORDER_COMPED'::text, 'b09386e4-86fc-4e05-a0e3-d6e364dbecde'::uuid),
            ('ce789609-3c9f-48ce-a003-624e4fccfffe'::uuid, 'ORDER_COMPED'::text, '22429f3b-bb64-4e6b-a0c8-049d3a9da154'::uuid),
            ('8d7618b3-c010-46ff-99e4-b3cb07f66543'::uuid, 'ORDER_COMPED'::text, '63563e8a-db1d-47f0-ba0e-09b38cd526f0'::uuid),
            ('b5c4d2af-8a36-47f6-b391-7a3f05abf9b0'::uuid, 'ORDER_COMPED'::text, '08043765-16f2-4e53-8036-69400211ce93'::uuid),
            ('5350de42-3664-4b7d-8d42-e7632fc4c654'::uuid, 'ORDER_COMPED'::text, 'f4a2430c-6004-4eeb-9b6f-bbc2e617cc4d'::uuid),
            ('7d695d1e-6d4d-474d-b514-7ab59c0e1587'::uuid, 'ORDER_COMPED'::text, '08043765-16f2-4e53-8036-69400211ce93'::uuid),
            ('4ab584ea-21aa-4c71-9f13-4154d6606d54'::uuid, 'ORDER_COMPED'::text, '08043765-16f2-4e53-8036-69400211ce93'::uuid),
            ('a361a328-feb5-4e43-abfe-a103c6dd125e'::uuid, 'ORDER_COMPED'::text, '8acb9f0e-a331-4c97-9b73-d435852dfe5f'::uuid),
            ('b6d87a21-f183-446e-9ab4-10fbeb5efef6'::uuid, 'ORDER_COMPED'::text, '8acb9f0e-a331-4c97-9b73-d435852dfe5f'::uuid),
            ('beb12727-d987-462d-bf83-ca19528eed7c'::uuid, 'ORDER_COMPED'::text, '8acb9f0e-a331-4c97-9b73-d435852dfe5f'::uuid),
            ('91c2c869-cde8-4da6-ac71-a1652b04b5e3'::uuid, 'ORDER_COMPED'::text, '37bf1377-01f1-4cdb-9d7c-58c0b4635e25'::uuid),
            ('c7911dfa-be31-4f0b-8b38-0ed9504fa117'::uuid, 'ORDER_COMPED'::text, 'b8552aa7-dd3d-432b-a558-5b38b2972ed6'::uuid),
            ('6987c471-e98f-42fe-9d87-8782e28c3d98'::uuid, 'ORDER_COMPED'::text, '1148bcb9-8323-4e30-a4b7-9188b2aad1b6'::uuid),
            ('27b02f0c-f2d8-4c91-b8b2-0d4b7fbefac0'::uuid, 'ORDER_COMPED'::text, 'a8c51dbc-5d13-4f83-8de7-4f903090dc96'::uuid),
            ('aedace16-f85a-4374-885b-d4e9fa886b4d'::uuid, 'ORDER_COMPED'::text, '0a0b0e44-fe7c-40aa-bbd4-9cda03649e81'::uuid),
            ('0c162c77-6a68-40e5-93ec-5e94e390320c'::uuid, 'ORDER_COMPED'::text, 'f3f20827-ffce-4fea-81cb-af63fb1d5883'::uuid),
            ('5c281cab-bffc-4cd6-8c2f-b0138c5d99bb'::uuid, 'PAYMENT_RECORDED'::text, '69f68aa4-44d0-48ca-8aaa-c918443dfe0c'::uuid),
            ('1386583e-9a9b-49e0-a643-fb76a528dedd'::uuid, 'PAYMENT_RECORDED'::text, 'be536bf5-050f-4742-aa6c-958bed6bc1ad'::uuid)
    ),
    locked_events AS MATERIALIZED (
        SELECT
            event.id,
            event.event_type::text AS event_type,
            event.order_id
        FROM public.order_events event
        JOIN expected
          ON expected.event_id = event.id
        FOR UPDATE
    )
    SELECT COUNT(*)
      INTO invalid_count
      FROM expected
      LEFT JOIN locked_events event
        ON event.id = expected.event_id
     WHERE event.id IS NULL
        OR event.event_type
           IS DISTINCT FROM expected.expected_event_type
        OR event.order_id
           IS DISTINCT FROM expected.expected_order_id;

    IF invalid_count <> 0 THEN
        RAISE EXCEPTION
            'Phase 40F repair aborted: % required events are missing or do not match the expected type/order',
            invalid_count;
    END IF;
END;
$$;

-- Ten confirmed financial comps.
DO $$
DECLARE
    updated_count integer;
BEGIN
    WITH repairs(event_id, order_id, comped_cents) AS (
        VALUES
            ('1b44188b-2f49-48ba-a630-2219c15dcd31'::uuid, 'b09386e4-86fc-4e05-a0e3-d6e364dbecde'::uuid, 700::bigint),
            ('8d7618b3-c010-46ff-99e4-b3cb07f66543'::uuid, '63563e8a-db1d-47f0-ba0e-09b38cd526f0'::uuid, 2900::bigint),
            ('b5c4d2af-8a36-47f6-b391-7a3f05abf9b0'::uuid, '08043765-16f2-4e53-8036-69400211ce93'::uuid, 2900::bigint),
            ('a361a328-feb5-4e43-abfe-a103c6dd125e'::uuid, '8acb9f0e-a331-4c97-9b73-d435852dfe5f'::uuid, 1400::bigint),
            ('91c2c869-cde8-4da6-ac71-a1652b04b5e3'::uuid, '37bf1377-01f1-4cdb-9d7c-58c0b4635e25'::uuid, 4900::bigint),
            ('c7911dfa-be31-4f0b-8b38-0ed9504fa117'::uuid, 'b8552aa7-dd3d-432b-a558-5b38b2972ed6'::uuid, 4600::bigint),
            ('6987c471-e98f-42fe-9d87-8782e28c3d98'::uuid, '1148bcb9-8323-4e30-a4b7-9188b2aad1b6'::uuid, 3200::bigint),
            ('27b02f0c-f2d8-4c91-b8b2-0d4b7fbefac0'::uuid, 'a8c51dbc-5d13-4f83-8de7-4f903090dc96'::uuid, 2900::bigint),
            ('aedace16-f85a-4374-885b-d4e9fa886b4d'::uuid, '0a0b0e44-fe7c-40aa-bbd4-9cda03649e81'::uuid, 700::bigint),
            ('0c162c77-6a68-40e5-93ec-5e94e390320c'::uuid, 'f3f20827-ffce-4fea-81cb-af63fb1d5883'::uuid, 3800::bigint)
    )
    UPDATE public.order_events event
       SET meta = COALESCE(event.meta, '{}'::jsonb)
           || jsonb_build_object(
               'actor_role', 'Manager',
               'comped_cents', repairs.comped_cents
           )
      FROM repairs
     WHERE event.id = repairs.event_id
       AND event.order_id = repairs.order_id
       AND event.event_type = 'ORDER_COMPED';

    GET DIAGNOSTICS updated_count = ROW_COUNT;

    IF updated_count <> 10 THEN
        RAISE EXCEPTION
            'Phase 40F repair failed: expected to update 10 financial comp events, but updated %',
            updated_count;
    END IF;
END;
$$;

-- Six confirmed historical no-op comp attempts.
DO $$
DECLARE
    updated_count integer;
BEGIN
    WITH repairs(event_id, order_id) AS (
        VALUES
            ('ce789609-3c9f-48ce-a003-624e4fccfffe'::uuid, '22429f3b-bb64-4e6b-a0c8-049d3a9da154'::uuid),
            ('5350de42-3664-4b7d-8d42-e7632fc4c654'::uuid, 'f4a2430c-6004-4eeb-9b6f-bbc2e617cc4d'::uuid),
            ('7d695d1e-6d4d-474d-b514-7ab59c0e1587'::uuid, '08043765-16f2-4e53-8036-69400211ce93'::uuid),
            ('4ab584ea-21aa-4c71-9f13-4154d6606d54'::uuid, '08043765-16f2-4e53-8036-69400211ce93'::uuid),
            ('b6d87a21-f183-446e-9ab4-10fbeb5efef6'::uuid, '8acb9f0e-a331-4c97-9b73-d435852dfe5f'::uuid),
            ('beb12727-d987-462d-bf83-ca19528eed7c'::uuid, '8acb9f0e-a331-4c97-9b73-d435852dfe5f'::uuid)
    )
    UPDATE public.order_events event
       SET meta = COALESCE(event.meta, '{}'::jsonb)
           || jsonb_build_object(
               'actor_role', 'Manager',
               'comped_cents', 0,
               'legacy_classification', 'NO_OP_COMP_ATTEMPT'
           )
      FROM repairs
     WHERE event.id = repairs.event_id
       AND event.order_id = repairs.order_id
       AND event.event_type = 'ORDER_COMPED';

    GET DIAGNOSTICS updated_count = ROW_COUNT;

    IF updated_count <> 6 THEN
        RAISE EXCEPTION
            'Phase 40F repair failed: expected to update 6 no-op comp events, but updated %',
            updated_count;
    END IF;
END;
$$;

-- Two confirmed legacy customer-checkout payments.
DO $$
DECLARE
    updated_count integer;
BEGIN
    WITH repairs(event_id, order_id, amount_cents) AS (
        VALUES
            (
                '5c281cab-bffc-4cd6-8c2f-b0138c5d99bb'::uuid,
                '69f68aa4-44d0-48ca-8aaa-c918443dfe0c'::uuid,
                3700::bigint
            ),
            (
                '1386583e-9a9b-49e0-a643-fb76a528dedd'::uuid,
                'be536bf5-050f-4742-aa6c-958bed6bc1ad'::uuid,
                2400::bigint
            )
    )
    UPDATE public.order_events event
       SET meta = COALESCE(event.meta, '{}'::jsonb)
           || jsonb_build_object(
               'provider', 'LEGACY_CUSTOMER_CHECKOUT',
               'payment_reference', 'legacy-order:' || repairs.order_id::text,
               'amount_cents', repairs.amount_cents,
               'legacy_classification', 'LEGACY_CUSTOMER_CHECKOUT'
           )
      FROM repairs
     WHERE event.id = repairs.event_id
       AND event.order_id = repairs.order_id
       AND event.event_type = 'PAYMENT_RECORDED';

    GET DIAGNOSTICS updated_count = ROW_COUNT;

    IF updated_count <> 2 THEN
        RAISE EXCEPTION
            'Phase 40F repair failed: expected to update 2 payment events, but updated %',
            updated_count;
    END IF;
END;
$$;

-- Exact post-repair verification.
DO $$
DECLARE
    unresolved_count integer;
BEGIN
    WITH expected(event_id, expected_event_type, expected_order_id) AS (
        VALUES
            ('1b44188b-2f49-48ba-a630-2219c15dcd31'::uuid, 'ORDER_COMPED'::text, 'b09386e4-86fc-4e05-a0e3-d6e364dbecde'::uuid),
            ('ce789609-3c9f-48ce-a003-624e4fccfffe'::uuid, 'ORDER_COMPED'::text, '22429f3b-bb64-4e6b-a0c8-049d3a9da154'::uuid),
            ('8d7618b3-c010-46ff-99e4-b3cb07f66543'::uuid, 'ORDER_COMPED'::text, '63563e8a-db1d-47f0-ba0e-09b38cd526f0'::uuid),
            ('b5c4d2af-8a36-47f6-b391-7a3f05abf9b0'::uuid, 'ORDER_COMPED'::text, '08043765-16f2-4e53-8036-69400211ce93'::uuid),
            ('5350de42-3664-4b7d-8d42-e7632fc4c654'::uuid, 'ORDER_COMPED'::text, 'f4a2430c-6004-4eeb-9b6f-bbc2e617cc4d'::uuid),
            ('7d695d1e-6d4d-474d-b514-7ab59c0e1587'::uuid, 'ORDER_COMPED'::text, '08043765-16f2-4e53-8036-69400211ce93'::uuid),
            ('4ab584ea-21aa-4c71-9f13-4154d6606d54'::uuid, 'ORDER_COMPED'::text, '08043765-16f2-4e53-8036-69400211ce93'::uuid),
            ('a361a328-feb5-4e43-abfe-a103c6dd125e'::uuid, 'ORDER_COMPED'::text, '8acb9f0e-a331-4c97-9b73-d435852dfe5f'::uuid),
            ('b6d87a21-f183-446e-9ab4-10fbeb5efef6'::uuid, 'ORDER_COMPED'::text, '8acb9f0e-a331-4c97-9b73-d435852dfe5f'::uuid),
            ('beb12727-d987-462d-bf83-ca19528eed7c'::uuid, 'ORDER_COMPED'::text, '8acb9f0e-a331-4c97-9b73-d435852dfe5f'::uuid),
            ('91c2c869-cde8-4da6-ac71-a1652b04b5e3'::uuid, 'ORDER_COMPED'::text, '37bf1377-01f1-4cdb-9d7c-58c0b4635e25'::uuid),
            ('c7911dfa-be31-4f0b-8b38-0ed9504fa117'::uuid, 'ORDER_COMPED'::text, 'b8552aa7-dd3d-432b-a558-5b38b2972ed6'::uuid),
            ('6987c471-e98f-42fe-9d87-8782e28c3d98'::uuid, 'ORDER_COMPED'::text, '1148bcb9-8323-4e30-a4b7-9188b2aad1b6'::uuid),
            ('27b02f0c-f2d8-4c91-b8b2-0d4b7fbefac0'::uuid, 'ORDER_COMPED'::text, 'a8c51dbc-5d13-4f83-8de7-4f903090dc96'::uuid),
            ('aedace16-f85a-4374-885b-d4e9fa886b4d'::uuid, 'ORDER_COMPED'::text, '0a0b0e44-fe7c-40aa-bbd4-9cda03649e81'::uuid),
            ('0c162c77-6a68-40e5-93ec-5e94e390320c'::uuid, 'ORDER_COMPED'::text, 'f3f20827-ffce-4fea-81cb-af63fb1d5883'::uuid),
            ('5c281cab-bffc-4cd6-8c2f-b0138c5d99bb'::uuid, 'PAYMENT_RECORDED'::text, '69f68aa4-44d0-48ca-8aaa-c918443dfe0c'::uuid),
            ('1386583e-9a9b-49e0-a643-fb76a528dedd'::uuid, 'PAYMENT_RECORDED'::text, 'be536bf5-050f-4742-aa6c-958bed6bc1ad'::uuid)
    )
    SELECT COUNT(*)
      INTO unresolved_count
      FROM expected
      LEFT JOIN public.order_events event
        ON event.id = expected.event_id
     WHERE event.id IS NULL
        OR event.event_type::text
           IS DISTINCT FROM expected.expected_event_type
        OR event.order_id
           IS DISTINCT FROM expected.expected_order_id;

    IF unresolved_count <> 0 THEN
        RAISE EXCEPTION
            'Phase 40F repair failed: % known events remain invalid',
            unresolved_count;
    END IF;

    SELECT COUNT(*)
      INTO unresolved_count
      FROM public.order_events event
     WHERE (
         event.event_type = 'ORDER_COMPED'
         AND event.id IN (
             '1b44188b-2f49-48ba-a630-2219c15dcd31'::uuid,
             'ce789609-3c9f-48ce-a003-624e4fccfffe'::uuid,
             '8d7618b3-c010-46ff-99e4-b3cb07f66543'::uuid,
             'b5c4d2af-8a36-47f6-b391-7a3f05abf9b0'::uuid,
             '5350de42-3664-4b7d-8d42-e7632fc4c654'::uuid,
             '7d695d1e-6d4d-474d-b514-7ab59c0e1587'::uuid,
             '4ab584ea-21aa-4c71-9f13-4154d6606d54'::uuid,
             'a361a328-feb5-4e43-abfe-a103c6dd125e'::uuid,
             'b6d87a21-f183-446e-9ab4-10fbeb5efef6'::uuid,
             'beb12727-d987-462d-bf83-ca19528eed7c'::uuid,
             '91c2c869-cde8-4da6-ac71-a1652b04b5e3'::uuid,
             'c7911dfa-be31-4f0b-8b38-0ed9504fa117'::uuid,
             '6987c471-e98f-42fe-9d87-8782e28c3d98'::uuid,
             '27b02f0c-f2d8-4c91-b8b2-0d4b7fbefac0'::uuid,
             'aedace16-f85a-4374-885b-d4e9fa886b4d'::uuid,
             '0c162c77-6a68-40e5-93ec-5e94e390320c'::uuid
         )
         AND (
             event.meta->>'actor_role' IS DISTINCT FROM 'Manager'
             OR NULLIF(btrim(event.meta->>'reason'), '') IS NULL
             OR CASE
                    WHEN (event.meta->>'comped_cents') ~ '^[0-9]+$'
                    THEN FALSE
                    ELSE TRUE
               END
             OR (
                 event.id = '1b44188b-2f49-48ba-a630-2219c15dcd31'::uuid
                 AND CASE
                      WHEN (event.meta->>'comped_cents') ~ '^[0-9]+$'
                      THEN (event.meta->>'comped_cents')::bigint
                      ELSE NULL
                 END IS DISTINCT FROM 700
             )
             OR (
                 event.id = '8d7618b3-c010-46ff-99e4-b3cb07f66543'::uuid
                 AND CASE
                      WHEN (event.meta->>'comped_cents') ~ '^[0-9]+$'
                      THEN (event.meta->>'comped_cents')::bigint
                      ELSE NULL
                 END IS DISTINCT FROM 2900
             )
             OR (
                 event.id = 'b5c4d2af-8a36-47f6-b391-7a3f05abf9b0'::uuid
                 AND CASE
                      WHEN (event.meta->>'comped_cents') ~ '^[0-9]+$'
                      THEN (event.meta->>'comped_cents')::bigint
                      ELSE NULL
                 END IS DISTINCT FROM 2900
             )
             OR (
                 event.id = 'a361a328-feb5-4e43-abfe-a103c6dd125e'::uuid
                 AND CASE
                      WHEN (event.meta->>'comped_cents') ~ '^[0-9]+$'
                      THEN (event.meta->>'comped_cents')::bigint
                      ELSE NULL
                 END IS DISTINCT FROM 1400
             )
             OR (
                 event.id = '91c2c869-cde8-4da6-ac71-a1652b04b5e3'::uuid
                 AND CASE
                      WHEN (event.meta->>'comped_cents') ~ '^[0-9]+$'
                      THEN (event.meta->>'comped_cents')::bigint
                      ELSE NULL
                 END IS DISTINCT FROM 4900
             )
             OR (
                 event.id = 'c7911dfa-be31-4f0b-8b38-0ed9504fa117'::uuid
                 AND CASE
                      WHEN (event.meta->>'comped_cents') ~ '^[0-9]+$'
                      THEN (event.meta->>'comped_cents')::bigint
                      ELSE NULL
                 END IS DISTINCT FROM 4600
             )
             OR (
                 event.id = '6987c471-e98f-42fe-9d87-8782e28c3d98'::uuid
                 AND CASE
                      WHEN (event.meta->>'comped_cents') ~ '^[0-9]+$'
                      THEN (event.meta->>'comped_cents')::bigint
                      ELSE NULL
                 END IS DISTINCT FROM 3200
             )
             OR (
                 event.id = '27b02f0c-f2d8-4c91-b8b2-0d4b7fbefac0'::uuid
                 AND CASE
                      WHEN (event.meta->>'comped_cents') ~ '^[0-9]+$'
                      THEN (event.meta->>'comped_cents')::bigint
                      ELSE NULL
                 END IS DISTINCT FROM 2900
             )
             OR (
                 event.id = 'aedace16-f85a-4374-885b-d4e9fa886b4d'::uuid
                 AND CASE
                      WHEN (event.meta->>'comped_cents') ~ '^[0-9]+$'
                      THEN (event.meta->>'comped_cents')::bigint
                      ELSE NULL
                 END IS DISTINCT FROM 700
             )
             OR (
                 event.id = '0c162c77-6a68-40e5-93ec-5e94e390320c'::uuid
                 AND CASE
                      WHEN (event.meta->>'comped_cents') ~ '^[0-9]+$'
                      THEN (event.meta->>'comped_cents')::bigint
                      ELSE NULL
                 END IS DISTINCT FROM 3800
             )
             OR (
                 event.id IN (
                     'ce789609-3c9f-48ce-a003-624e4fccfffe'::uuid,
                     '5350de42-3664-4b7d-8d42-e7632fc4c654'::uuid,
                     '7d695d1e-6d4d-474d-b514-7ab59c0e1587'::uuid,
                     '4ab584ea-21aa-4c71-9f13-4154d6606d54'::uuid,
                     'b6d87a21-f183-446e-9ab4-10fbeb5efef6'::uuid,
                     'beb12727-d987-462d-bf83-ca19528eed7c'::uuid
                 )
                 AND CASE
                      WHEN (event.meta->>'comped_cents') ~ '^[0-9]+$'
                      THEN (event.meta->>'comped_cents')::bigint
                      ELSE NULL
                 END IS DISTINCT FROM 0
             )
             OR (
                 event.id IN (
                     'ce789609-3c9f-48ce-a003-624e4fccfffe'::uuid,
                     '5350de42-3664-4b7d-8d42-e7632fc4c654'::uuid,
                     '7d695d1e-6d4d-474d-b514-7ab59c0e1587'::uuid,
                     '4ab584ea-21aa-4c71-9f13-4154d6606d54'::uuid,
                     'b6d87a21-f183-446e-9ab4-10fbeb5efef6'::uuid,
                     'beb12727-d987-462d-bf83-ca19528eed7c'::uuid
                 )
                 AND event.meta->>'legacy_classification'
                     IS DISTINCT FROM 'NO_OP_COMP_ATTEMPT'
             )
             OR (
                 event.id IN (
                     '1b44188b-2f49-48ba-a630-2219c15dcd31'::uuid,
                     '8d7618b3-c010-46ff-99e4-b3cb07f66543'::uuid,
                     'b5c4d2af-8a36-47f6-b391-7a3f05abf9b0'::uuid,
                     'a361a328-feb5-4e43-abfe-a103c6dd125e'::uuid,
                     '91c2c869-cde8-4da6-ac71-a1652b04b5e3'::uuid,
                     'c7911dfa-be31-4f0b-8b38-0ed9504fa117'::uuid,
                     '6987c471-e98f-42fe-9d87-8782e28c3d98'::uuid,
                     '27b02f0c-f2d8-4c91-b8b2-0d4b7fbefac0'::uuid,
                     'aedace16-f85a-4374-885b-d4e9fa886b4d'::uuid,
                     '0c162c77-6a68-40e5-93ec-5e94e390320c'::uuid
                 )
                 AND event.meta->>'legacy_classification'
                     = 'NO_OP_COMP_ATTEMPT'
             )
         )
     )
     OR (
         event.event_type = 'PAYMENT_RECORDED'
         AND event.id IN (
             '5c281cab-bffc-4cd6-8c2f-b0138c5d99bb'::uuid,
             '1386583e-9a9b-49e0-a643-fb76a528dedd'::uuid
         )
         AND (
             event.meta->>'provider' IS DISTINCT FROM 'LEGACY_CUSTOMER_CHECKOUT'
             OR event.meta->>'legacy_classification'
                 IS DISTINCT FROM 'LEGACY_CUSTOMER_CHECKOUT'
             OR event.meta->>'payment_reference'
                 IS DISTINCT FROM ('legacy-order:' || event.order_id::text)
             OR CASE
                    WHEN (event.meta->>'amount_cents') ~ '^[0-9]+$'
                    THEN FALSE
                    ELSE TRUE
               END
             OR (
                 event.id = '5c281cab-bffc-4cd6-8c2f-b0138c5d99bb'::uuid
                 AND CASE
                      WHEN (event.meta->>'amount_cents') ~ '^[0-9]+$'
                      THEN (event.meta->>'amount_cents')::bigint
                      ELSE NULL
                 END IS DISTINCT FROM 3700
             )
             OR (
                 event.id = '1386583e-9a9b-49e0-a643-fb76a528dedd'::uuid
                 AND CASE
                      WHEN (event.meta->>'amount_cents') ~ '^[0-9]+$'
                      THEN (event.meta->>'amount_cents')::bigint
                      ELSE NULL
                 END IS DISTINCT FROM 2400
             )
         )
     );

    IF unresolved_count <> 0 THEN
        RAISE EXCEPTION
            'Phase 40F repair failed: % known events remain invalid',
            unresolved_count;
    END IF;
END;
$$;

COMMIT;
