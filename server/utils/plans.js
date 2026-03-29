/**
 * plans.js — Plan tier helpers
 *
 * Plan hierarchy:  free  <  premium  <  cross_campus
 *
 * premium      — home-university features unlocked (browse privately, DM anyone, etc.)
 * cross_campus — everything in premium PLUS access to all supported universities
 *
 * Always use these helpers instead of comparing req.user.plan directly, so that
 * adding a new tier in the future only requires updating this file.
 */

/** True for premium OR cross_campus (any paid plan) */
const isPremium     = plan => plan === 'premium' || plan === 'cross_campus';

/** True only for cross_campus (cross-university access) */
const isCrossCampus = plan => plan === 'cross_campus';

module.exports = { isPremium, isCrossCampus };
