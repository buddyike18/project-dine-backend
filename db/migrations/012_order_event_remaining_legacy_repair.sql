BEGIN;

SET LOCAL search_path = public, pg_catalog;

-- ============================================================================
-- Phase 40F
-- 012_order_event_remaining_legacy_repair.sql
--
-- Forward-only repair for the 66 remaining historical lifecycle events
-- identified after migration 011 had already been applied.
--
-- Historical repair only:
--   * 41 ORDER_VOIDED actor-role metadata repairs
--   * 2 PAYMENT_RECORDED actor classification repairs
--   * 23 RECALL transition repairs
--
-- This migration installs no constraints, triggers, or runtime behavior.
-- ============================================================================

-- ============================================================================
-- Remaining Phase 40F historical lifecycle repair
-- ============================================================================

DO $$
DECLARE
  repaired_void_count integer;
  repaired_payment_count integer;
  repaired_recall_count integer;
BEGIN
  -- Preserve the legacy manager role in the canonical metadata contract.
  UPDATE public.order_events
  SET meta = jsonb_set(
    COALESCE(meta, '{}'::jsonb),
    '{actor_role}',
    to_jsonb(actor_role::text),
    true
  )
  WHERE id = ANY (ARRAY[
    '0f943f0d-c96d-477b-be03-3f99ea38050e',
    '1dbdc9ed-a17e-4015-9f38-bc0bf5d29c6b',
    '26e5b7aa-53c8-4728-89dc-c7cf76d60ca9',
    '2b985290-f6b4-4866-88ec-ecd218449ea5',
    '2f2d7959-8e51-4b2d-b6b5-544590ce698f',
    '32587638-3bdc-4c0e-9a39-b68bf455d242',
    '38b4e0a5-9c80-44e5-addb-b5c5b374944d',
    '3b5956b0-b3dd-4fa4-a94e-e4ffe2db290c',
    '4187ec33-076f-482b-83cb-eacfb1a96337',
    '47bfc84e-e7cd-4c18-80b6-e741ce934cba',
    '4c5b50ae-90bc-498b-8cb5-3344c2dba9a4',
    '4d71f0fb-2542-43a4-bd71-095952c37878',
    '502503ac-c4e2-4adc-bebe-25b2a272aad0',
    '51220abc-b729-48cf-b723-fe8ec8764665',
    '55fdb8da-f67e-4432-925b-906bfdf69f14',
    '5871e53e-0055-4a94-af3e-5258eae67d87',
    '61f1f48b-38eb-4947-99c6-ef758f69a8d0',
    '6494bb70-c636-4741-a05a-d2bfd45ddd25',
    '6e6fd965-f57d-437f-b428-7f6497ac3674',
    '72e0f492-466a-4503-ae21-ebe5c2d362c5',
    '7600d756-d880-434c-b9ea-b5751645d6d8',
    '7a83e5e5-b57d-422e-8009-75bfe7a0944d',
    '846b00dd-8f33-41d2-a6f7-896f76c36784',
    '90be4995-5590-4e91-abfb-2a9267da92f8',
    '92fbbf84-c189-40eb-b9a9-094c81fc1a94',
    '950f51e7-d7c9-4087-bc66-fee1e0535200',
    '97442184-3422-4c02-b8a6-d2feb06a9bed',
    '9c16269d-613d-4517-82c1-a9d05fe20498',
    'a65af6a7-35be-4fa5-9c1f-83b974e21cf4',
    'abb30d74-c275-4939-a0ae-73d8fe3c285b',
    'b6794b76-8c88-40c7-b665-1e5d321c26cf',
    'b836ff41-da18-49b6-81db-0e049636a3d4',
    'b998c051-621c-439b-8dfb-8ec12de23928',
    'ba39a070-9825-43c0-98cf-9226cbde1b22',
    'bbd7078a-5f94-45a0-99e7-4a6f2199ca87',
    'c0b13a05-d669-40cb-889c-f36a8fdbf543',
    'd8487fb7-3982-4b40-a6eb-8c7c789f9879',
    'e9abd749-b87a-40e5-bbf1-ea29caa67ed1',
    'f4bd88ac-8cb1-41cb-aba7-d8dc63c24dcf',
    'f778dfaf-3a63-4233-bfb8-3c7a5688376f',
    'fa130b54-5687-4a74-bb10-5eac40f5b50a'
  ]::uuid[])
    AND event_type::text = 'ORDER_VOIDED'
    AND actor_role::text IN ('Owner', 'Manager')
    AND NULLIF(btrim(meta ->> 'actor_role'), '') IS NULL;

  GET DIAGNOSTICS repaired_void_count = ROW_COUNT;

  IF repaired_void_count <> 41 THEN
    RAISE EXCEPTION
      'Phase 40F expected 41 legacy ORDER_VOIDED repairs, repaired %',
      repaired_void_count;
  END IF;

  -- Convert the two known legacy customer-checkout payment events into the
  -- canonical payment-provider actor representation while preserving history.
  UPDATE public.order_events
  SET
    actor_user_id = NULL,
    actor_firebase_uid = NULL,
    meta = COALESCE(meta, '{}'::jsonb)
      || jsonb_build_object(
        'legacy_actor_role', actor_role::text,
        'legacy_actor_user_id', actor_user_id::text,
        'legacy_actor_firebase_uid', actor_firebase_uid,
        'legacy_actor_classification', 'CUSTOMER_CHECKOUT'
      )
  WHERE id IN (
    '5c281cab-bffc-4cd6-8c2f-b0138c5d99bb'::uuid,
    '1386583e-9a9b-49e0-a643-fb76a528dedd'::uuid
  )
    AND event_type::text = 'PAYMENT_RECORDED'
    AND actor_user_id IS NOT NULL
    AND (
      meta IS NULL
      OR meta ->> 'legacy_actor_classification' IS NULL
    );

  GET DIAGNOSTICS repaired_payment_count = ROW_COUNT;

  IF repaired_payment_count <> 2 THEN
    RAISE EXCEPTION
      'Phase 40F expected 2 legacy PAYMENT_RECORDED repairs, repaired %',
      repaired_payment_count;
  END IF;

  -- Normalize the 23 known recall-to-OPEN events to the canonical
  -- READY-to-SENT recall transition while preserving their original states.
  UPDATE public.order_events
  SET
    meta = COALESCE(meta, '{}'::jsonb)
      || jsonb_build_object(
        'legacy_from_status', from_status::text,
        'legacy_to_status', to_status::text,
        'legacy_transition_classification', 'RECALL_TO_OPEN'
      ),
    from_status = 'READY',
    to_status = 'SENT'
  WHERE id = ANY (ARRAY[
    '7e7512f3-f482-4f37-8a1a-7d6e062fa0c7',
    '9f939fa3-e6ad-4184-a6c2-e98b4dfdb962',
    '5d82f7e3-3c80-485c-929a-0a080ba39f98',
    'a3db9ac8-7819-44d9-be71-7f183f6be819',
    '95f23ec9-900a-4bcc-8d74-9e7be3a7cf88',
    '161d74b3-a6ba-4d2d-85bf-38e9820a1e46',
    '9c2738b1-3e71-4a6a-bbde-0085ca83e43f',
    '88054ff0-a1d4-416f-a3c4-235de6edaa5b',
    '051ad6ab-e34f-42c0-a0be-fc81143087d3',
    '640dddaf-39d1-4620-affe-b56b436c6eca',
    '4341b56a-4aa6-499c-9745-2c7faff5dce9',
    '30d01228-527f-4930-906d-8f59377dfe4a',
    '21b1c53f-f86a-4427-95bc-002725071d1e',
    '8d33c2d4-4207-42ac-bc3c-64ddf9e08b45',
    '1fa2d29e-595b-4779-9de9-9afd1fc91202',
    '3f69b57d-e35f-463b-b5f1-31aa1a8cc77e',
    'cbe4e4ca-8d8a-4dbb-b1a5-53585d6ff96b',
    '09ad2af2-6aa1-4d5a-a6ab-a304532e15f3',
    'e6d8357c-c679-4379-9c0d-f7f0ed719424',
    '48ea9ea3-5986-49e6-9039-80b1c279cd67',
    'e436c51f-f6da-4013-a7f3-5e279c130c8d',
    '85dec071-51d4-48b4-861b-96c35f9be550',
    'fd2eb715-4379-4bed-8d97-7c4d4972f289'
  ]::uuid[])
    AND event_type::text = 'RECALL'
    AND (
      meta IS NULL
      OR meta ->> 'legacy_transition_classification' IS NULL
    );

  GET DIAGNOSTICS repaired_recall_count = ROW_COUNT;

  IF repaired_recall_count <> 23 THEN
    RAISE EXCEPTION
      'Phase 40F expected 23 legacy RECALL repairs, repaired %',
      repaired_recall_count;
  END IF;
END;
$$;

DO $$
DECLARE
  invalid_count integer;
BEGIN
  SELECT COUNT(*)
  INTO invalid_count
  FROM public.order_events
  WHERE
    (
      id = ANY (ARRAY[
        '0f943f0d-c96d-477b-be03-3f99ea38050e',
        '1dbdc9ed-a17e-4015-9f38-bc0bf5d29c6b',
        '26e5b7aa-53c8-4728-89dc-c7cf76d60ca9',
        '2b985290-f6b4-4866-88ec-ecd218449ea5',
        '2f2d7959-8e51-4b2d-b6b5-544590ce698f',
        '32587638-3bdc-4c0e-9a39-b68bf455d242',
        '38b4e0a5-9c80-44e5-addb-b5c5b374944d',
        '3b5956b0-b3dd-4fa4-a94e-e4ffe2db290c',
        '4187ec33-076f-482b-83cb-eacfb1a96337',
        '47bfc84e-e7cd-4c18-80b6-e741ce934cba',
        '4c5b50ae-90bc-498b-8cb5-3344c2dba9a4',
        '4d71f0fb-2542-43a4-bd71-095952c37878',
        '502503ac-c4e2-4adc-bebe-25b2a272aad0',
        '51220abc-b729-48cf-b723-fe8ec8764665',
        '55fdb8da-f67e-4432-925b-906bfdf69f14',
        '5871e53e-0055-4a94-af3e-5258eae67d87',
        '61f1f48b-38eb-4947-99c6-ef758f69a8d0',
        '6494bb70-c636-4741-a05a-d2bfd45ddd25',
        '6e6fd965-f57d-437f-b428-7f6497ac3674',
        '72e0f492-466a-4503-ae21-ebe5c2d362c5',
        '7600d756-d880-434c-b9ea-b5751645d6d8',
        '7a83e5e5-b57d-422e-8009-75bfe7a0944d',
        '846b00dd-8f33-41d2-a6f7-896f76c36784',
        '90be4995-5590-4e91-abfb-2a9267da92f8',
        '92fbbf84-c189-40eb-b9a9-094c81fc1a94',
        '950f51e7-d7c9-4087-bc66-fee1e0535200',
        '97442184-3422-4c02-b8a6-d2feb06a9bed',
        '9c16269d-613d-4517-82c1-a9d05fe20498',
        'a65af6a7-35be-4fa5-9c1f-83b974e21cf4',
        'abb30d74-c275-4939-a0ae-73d8fe3c285b',
        'b6794b76-8c88-40c7-b665-1e5d321c26cf',
        'b836ff41-da18-49b6-81db-0e049636a3d4',
        'b998c051-621c-439b-8dfb-8ec12de23928',
        'ba39a070-9825-43c0-98cf-9226cbde1b22',
        'bbd7078a-5f94-45a0-99e7-4a6f2199ca87',
        'c0b13a05-d669-40cb-889c-f36a8fdbf543',
        'd8487fb7-3982-4b40-a6eb-8c7c789f9879',
        'e9abd749-b87a-40e5-bbf1-ea29caa67ed1',
        'f4bd88ac-8cb1-41cb-aba7-d8dc63c24dcf',
        'f778dfaf-3a63-4233-bfb8-3c7a5688376f',
        'fa130b54-5687-4a74-bb10-5eac40f5b50a'
      ]::uuid[])
      AND event_type::text = 'ORDER_VOIDED'
      AND meta ->> 'actor_role'
        IS DISTINCT FROM actor_role::text
    )
    OR (
      id IN (
        '5c281cab-bffc-4cd6-8c2f-b0138c5d99bb'::uuid,
        '1386583e-9a9b-49e0-a643-fb76a528dedd'::uuid
      )
      AND (
        event_type::text <> 'PAYMENT_RECORDED'
        OR actor_user_id IS NOT NULL
        OR actor_firebase_uid IS NOT NULL
        OR meta ->> 'legacy_actor_classification'
          IS DISTINCT FROM 'CUSTOMER_CHECKOUT'
      )
    )
    OR (
      id = ANY (ARRAY[
        '7e7512f3-f482-4f37-8a1a-7d6e062fa0c7',
        '9f939fa3-e6ad-4184-a6c2-e98b4dfdb962',
        '5d82f7e3-3c80-485c-929a-0a080ba39f98',
        'a3db9ac8-7819-44d9-be71-7f183f6be819',
        '95f23ec9-900a-4bcc-8d74-9e7be3a7cf88',
        '161d74b3-a6ba-4d2d-85bf-38e9820a1e46',
        '9c2738b1-3e71-4a6a-bbde-0085ca83e43f',
        '88054ff0-a1d4-416f-a3c4-235de6edaa5b',
        '051ad6ab-e34f-42c0-a0be-fc81143087d3',
        '640dddaf-39d1-4620-affe-b56b436c6eca',
        '4341b56a-4aa6-499c-9745-2c7faff5dce9',
        '30d01228-527f-4930-906d-8f59377dfe4a',
        '21b1c53f-f86a-4427-95bc-002725071d1e',
        '8d33c2d4-4207-42ac-bc3c-64ddf9e08b45',
        '1fa2d29e-595b-4779-9de9-9afd1fc91202',
        '3f69b57d-e35f-463b-b5f1-31aa1a8cc77e',
        'cbe4e4ca-8d8a-4dbb-b1a5-53585d6ff96b',
        '09ad2af2-6aa1-4d5a-a6ab-a304532e15f3',
        'e6d8357c-c679-4379-9c0d-f7f0ed719424',
        '48ea9ea3-5986-49e6-9039-80b1c279cd67',
        'e436c51f-f6da-4013-a7f3-5e279c130c8d',
        '85dec071-51d4-48b4-861b-96c35f9be550',
        'fd2eb715-4379-4bed-8d97-7c4d4972f289'
      ]::uuid[])
      AND (
        event_type::text <> 'RECALL'
        OR from_status::text <> 'READY'
        OR to_status::text <> 'SENT'
        OR meta ->> 'legacy_transition_classification'
          IS DISTINCT FROM 'RECALL_TO_OPEN'
      )
    );

  IF invalid_count <> 0 THEN
    RAISE EXCEPTION
      'Phase 40F remaining legacy repair validation failed for % row(s)',
      invalid_count;
  END IF;
END;
$$;

COMMIT;
