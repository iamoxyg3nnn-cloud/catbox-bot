'use strict';

// Metadata backend factory.
//   - Default: local node:sqlite (tests, single-node experiments)
//   - With SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY: cloned Supabase/Postgres
//
// Byte storage is never selected here; that lives in src/storage/.

const useSupabase = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = useSupabase
  ? require('./adapters/supabase')
  : require('./db');

module.exports.backend = useSupabase ? 'supabase' : 'sqlite';
