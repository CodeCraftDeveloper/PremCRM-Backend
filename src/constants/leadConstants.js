/**
 * leadConstants.js — Single source of truth for lead status values.
 *
 * Import this wherever lead statuses need to be validated or compared so that
 * route validators, service logic, and the Mongoose model schema never drift.
 */

export const LEAD_STATUSES = [
  "new",
  "contacted",
  "interested",
  "qualified",
  "closed",
  "lost",
  "converted",
];
