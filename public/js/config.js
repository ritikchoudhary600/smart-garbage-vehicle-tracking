/**
 * config.js — where the app finds Supabase
 *
 * Leave both values empty to run the offline demo (no sign-in, nothing saved).
 *  - Locally, `npm start` serves this file from SUPABASE_URL / SUPABASE_ANON_KEY
 *    in .env instead, so you normally never edit it.
 *  - On Vercel, the build step (scripts/build-config.js) rewrites it from the
 *    project's environment variables.
 * The anon / publishable key is designed to be public; row-level security in
 * the database is what protects the data. Never put the service-role key here.
 */
window.APP_CONFIG = {
  supabaseUrl: "",
  supabaseKey: "",
};
