/**
 * Organizations, seats and wallets ship from branch pu/ow-final-seats-money behind its
 * ORGS_ENABLED flag. That branch is not merged here, so on this base the org and wallet rows
 * stay hidden; phase 8 (built on that branch, DEC-C5) replaces this with the branch's flag.
 */
export const ORGS_ENABLED = false;
