-- Safe Reset Slate Procedure for Saka Fleet Test Environment
-- Clears vehicles, chat_history, and test session data safely without dropping tables or breaking schema.

CREATE OR REPLACE FUNCTION reset_test_slate(target_phone text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result jsonb;
BEGIN
  IF target_phone IS NOT NULL AND target_phone <> '' THEN
    -- Targeted user wipe for individual test run
    DELETE FROM public.chat_history WHERE user_phone = target_phone;
    DELETE FROM public.chat_transcripts WHERE phone_number = target_phone;
    DELETE FROM public.superadmin_sessions WHERE phone_number = target_phone;
    DELETE FROM public.coupons WHERE assigned_to_phone = target_phone;
    
    DELETE FROM public.reminders WHERE vehicle_id IN (
      SELECT id FROM public.vehicles WHERE owner_phone = target_phone
    );
    DELETE FROM public.expense_logs WHERE vehicle_id IN (
      SELECT id FROM public.vehicles WHERE owner_phone = target_phone
    );
    DELETE FROM public.private_earnings WHERE vehicle_id IN (
      SELECT id FROM public.vehicles WHERE owner_phone = target_phone
    );
    DELETE FROM public.passbook_transfers WHERE vehicle_id IN (
      SELECT id FROM public.vehicles WHERE owner_phone = target_phone
    );
    DELETE FROM public.pending_owner_notifications WHERE vehicle_id IN (
      SELECT id FROM public.vehicles WHERE owner_phone = target_phone
    );
    DELETE FROM public.vehicles WHERE owner_phone = target_phone;
    DELETE FROM public.profiles WHERE phone_number = target_phone;

    result := jsonb_build_object('status', 'success', 'scope', 'targeted', 'phone', target_phone);
  ELSE
    -- Global test data wipe
    TRUNCATE TABLE 
      public.chat_history,
      public.chat_transcripts,
      public.pending_owner_notifications,
      public.passbook_transfers,
      public.private_earnings,
      public.expense_logs,
      public.reminders,
      public.vehicles,
      public.superadmin_sessions,
      public.coupons,
      public.error_logs,
      public.conversation_analytics
    RESTART IDENTITY CASCADE;

    TRUNCATE TABLE public.profiles RESTART IDENTITY CASCADE;

    result := jsonb_build_object('status', 'success', 'scope', 'global');
  END IF;

  RETURN result;
END;
$$;
