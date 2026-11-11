/**
 * PLACEHOLDER — the subscription tiers are not designed yet (TOM-988). Everything a real plan will
 * replace is here and in `supabase/migrations/202611110002_device_limit.sql`: the plan ids, how many
 * machines the free plan allows, and where a person goes to subscribe.
 *
 * The limit itself is the database's: it refuses the machine an account has no room for, whatever
 * this file says. These values are only what the app shows before the account has answered.
 */
export const FREE_PLAN = "free";
/** The one paid plan the database knows for now. */
export const PLACEHOLDER_PAID_PLAN = "placeholder_plus";
export const FREE_DEVICE_LIMIT = 2;
/** Where "Subscribe" leads, under the account's site. The page does not exist yet. */
export const SUBSCRIBE_PATH = "/pricing/";
