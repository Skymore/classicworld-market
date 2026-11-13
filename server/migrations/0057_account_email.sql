-- The Google-verified email of the account's sign-in, saved at each Google login.
-- Admins are the accounts whose email is listed in the private Google sign-in
-- configuration (admin_emails), never a flag users can set.
ALTER TABLE accounts ADD COLUMN email text;
