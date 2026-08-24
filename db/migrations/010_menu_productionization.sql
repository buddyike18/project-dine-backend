-- Phase 40E — Menu Productionization
--
-- Hardens menu data integrity by:
--   1. Failing closed if ambiguous case-insensitive duplicate menu data exists.
--   2. Normalizing modifier_groups.required from min_select.
--   3. Enforcing required = (min_select > 0).
--   4. Enforcing case-insensitive uniqueness for menu categories, menu items,
--      modifier groups, and modifier options.
--
-- This migration intentionally does not delete, merge, or rename duplicate data.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.menu_categories
    GROUP BY restaurant_id, LOWER(name)
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Phase 40E migration blocked: duplicate menu category names exist within the same restaurant (case-insensitive). Resolve duplicates before rerunning migration 010.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.menu_items
    WHERE category_id IS NOT NULL
    GROUP BY category_id, LOWER(name)
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Phase 40E migration blocked: duplicate menu item names exist within the same category (case-insensitive). Resolve duplicates before rerunning migration 010.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.menu_items
    WHERE category_id IS NULL
    GROUP BY restaurant_id, LOWER(name)
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Phase 40E migration blocked: duplicate uncategorized menu item names exist within the same restaurant (case-insensitive). Resolve duplicates before rerunning migration 010.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.modifier_groups
    GROUP BY restaurant_id, LOWER(name)
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Phase 40E migration blocked: duplicate modifier group names exist within the same restaurant (case-insensitive). Resolve duplicates before rerunning migration 010.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.modifier_options
    GROUP BY group_id, LOWER(name)
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Phase 40E migration blocked: duplicate modifier option names exist within the same modifier group (case-insensitive). Resolve duplicates before rerunning migration 010.';
  END IF;
END;
$$;

UPDATE public.modifier_groups
SET required = (min_select > 0)
WHERE required IS DISTINCT FROM (min_select > 0);

ALTER TABLE public.modifier_groups
  DROP CONSTRAINT IF EXISTS modifier_groups_required_matches_min_select;

ALTER TABLE public.modifier_groups
  ADD CONSTRAINT modifier_groups_required_matches_min_select
  CHECK (required = (min_select > 0));

CREATE UNIQUE INDEX IF NOT EXISTS uq_menu_categories_restaurant_name_ci
  ON public.menu_categories (restaurant_id, LOWER(name));

CREATE UNIQUE INDEX IF NOT EXISTS uq_menu_items_category_name_ci
  ON public.menu_items (category_id, LOWER(name))
  WHERE category_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_menu_items_uncategorized_restaurant_name_ci
  ON public.menu_items (restaurant_id, LOWER(name))
  WHERE category_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_modifier_groups_restaurant_name_ci
  ON public.modifier_groups (restaurant_id, LOWER(name));

CREATE UNIQUE INDEX IF NOT EXISTS uq_modifier_options_group_name_ci
  ON public.modifier_options (group_id, LOWER(name));
