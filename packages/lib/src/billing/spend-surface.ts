/**
 * spend-surface — what the "spending from" surfaces show (Spec UI-8, SPEND-2, SPEND-4, D20.8):
 * the header chip, its popover rows, the composer strip before a conversation's first message,
 * and the fallback notice. The refusal and skip copy is spend-refusal-copy's.
 *
 * Every input is what the conversation-spend route already answers (the person's labelled
 * options, SpendChoice, and the gate's own decision for the next call), so a surface never
 * resolves a wallet id or converts cents: the counts arrive formatted by the money model.
 *
 * PURE and client-safe: no IO, no clock, type-only imports.
 */
import type { SpendSourceKind, WalletStatus } from './wallet-core';

/** A source the person may pick (spend-resolution SpendChoice, as the route serializes it). */
export interface SurfaceChoice {
  source: SpendSourceKind;
  walletId: string;
  label: string;
  driveName: string | null;
  orgName: string | null;
  /** The person's own remaining amount; null = the source sets no limit of its own. */
  remainingCents: number | null;
  remainingCredits: string | null;
}

/** The gate's decision for the next call (spend-target CallSpendDecision, as serialized). */
export type SurfaceDecision =
  | { kind: 'spend'; source: SpendSourceKind; walletId: string; fallbackApplied: boolean; fallbackFrom: SpendSourceKind | null }
  | { kind: 'refuse'; source: SpendSourceKind | null; reason: string; options: { source: SpendSourceKind; walletId: string }[] }
  | { kind: 'skip'; reason: string; walletId: string | null };

const SOURCES: readonly SpendSourceKind[] = ['drive_wallet', 'seat_allowance', 'own_credits'];
const isSource = (value: unknown): value is SpendSourceKind => typeof value === 'string' && (SOURCES as readonly string[]).includes(value);

/** Whether the spend surfaces show at all: orgs on, and more than one source (D20.8 passive disclosure). */
const surfacesShow = (orgsEnabled: boolean, options: readonly SurfaceChoice[]): boolean => orgsEnabled && options.length > 1;

function choiceFor(decision: SurfaceDecision, options: readonly SurfaceChoice[]): SurfaceChoice | null {
  if (decision.kind === 'spend') {
    return options.find((o) => o.walletId === decision.walletId) ?? options.find((o) => o.source === decision.source) ?? null;
  }
  if (decision.kind === 'refuse' && decision.source) return options.find((o) => o.source === decision.source) ?? null;
  return null;
}

const count = (choice: SurfaceChoice): string => (choice.remainingCredits === null ? 'No cap' : `${choice.remainingCredits} credits`);

export interface SpendChipModel {
  /** The kind of source, for the icon; null when the person has to choose. */
  source: SpendSourceKind | null;
  /** One short token: a credit count or a state, never the wallet's name (UI-8). */
  text: string;
  tone: 'normal' | 'paused' | 'refused';
  ariaLabel: string;
}

const REFUSED_CHIP_TEXT: Readonly<Record<string, string>> = {
  source_paused: 'Paused',
  source_cap_reached: 'Cap reached',
  source_empty: '0 credits',
  guest_drive_wallet_off: 'Not for guests',
};

/**
 * The header chip, or null where the personal-credits chip stays (one source, or orgs dark).
 * It names what the gate will actually spend, so a fallback the drive rule applies shows the
 * new source (SPEND-4).
 */
export function spendChipModel(input: { orgsEnabled: boolean; options: readonly SurfaceChoice[]; resolved: SurfaceDecision }): SpendChipModel | null {
  if (!surfacesShow(input.orgsEnabled, input.options)) return null;
  const { resolved } = input;
  const choice = choiceFor(resolved, input.options);
  if (resolved.kind === 'spend' && choice) {
    const text = count(choice);
    return { source: choice.source, text, tone: 'normal', ariaLabel: `Spending from ${choice.label}: ${text}` };
  }
  if (resolved.kind === 'refuse' && choice && Object.prototype.hasOwnProperty.call(REFUSED_CHIP_TEXT, resolved.reason)) {
    const text = REFUSED_CHIP_TEXT[resolved.reason];
    return { source: choice.source, text, tone: resolved.reason === 'source_paused' ? 'paused' : 'refused', ariaLabel: `Spending from ${choice.label}: ${text}` };
  }
  return { source: null, text: 'Choose', tone: 'refused', ariaLabel: 'Choose what to spend from' };
}

/** A popover row's second line: who funds the source, by name. */
export function spendChoiceHint(choice: SurfaceChoice): string {
  if (choice.source === 'drive_wallet') return choice.orgName ? `Funded by ${choice.orgName}` : "Funded by the drive's owner";
  if (choice.source === 'seat_allowance') return `Your seat allowance from ${choice.orgName ?? 'your organization'}`;
  return 'Personal balance · not billed to an organization';
}

/** A popover row's amount: the person's own remaining credits (SPEND-9). */
export function spendChoiceAmount(choice: SurfaceChoice): string {
  if (choice.remainingCredits === null) return 'No cap';
  return choice.source === 'own_credits' ? `${choice.remainingCredits} credits` : `${choice.remainingCredits} credits left`;
}

export interface ComposerStripModel {
  /** The source's name, in bold; null when the person must choose. */
  label: string | null;
  detail: string;
  tone: 'normal' | 'fallback' | 'refused';
}

/** The strip above the composer before a conversation's first message (SPEND-2). */
export function composerStripModel(input: {
  orgsEnabled: boolean;
  options: readonly SurfaceChoice[];
  resolved: SurfaceDecision;
  hasMessages: boolean;
}): ComposerStripModel | null {
  if (input.hasMessages || !surfacesShow(input.orgsEnabled, input.options)) return null;
  const { resolved } = input;
  const choice = choiceFor(resolved, input.options);
  if (resolved.kind !== 'spend' || !choice) {
    return { label: null, detail: 'Choose what this conversation spends from', tone: 'refused' };
  }
  const amount = choice.remainingCredits === null
    ? 'No cap'
    : choice.source === 'own_credits' ? `${choice.remainingCredits} credits` : `${choice.remainingCredits} credits left this month`;
  if (resolved.fallbackApplied && resolved.fallbackFrom) {
    const from = input.options.find((o) => o.source === resolved.fallbackFrom);
    return { label: choice.label, detail: `${amount} · ${from?.label ?? 'The chosen source'} cannot cover this`, tone: 'fallback' };
  }
  return { label: choice.label, detail: amount, tone: 'normal' };
}

const FALLBACK_TO: Readonly<Record<SpendSourceKind, string>> = {
  drive_wallet: 'the drive wallet',
  seat_allowance: 'your seat allowance',
  own_credits: 'your own credits',
};

/**
 * The notice under a reply the drive's rule moved to another source (SPEND-4): which source was
 * used, which it moved off, and why when the wallet's status says. Null for a malformed notice
 * (it crosses the wire untyped) or one that moved nowhere.
 */
export function spendFallbackCopy(input: { from: unknown; to: unknown; fromLabel: string | null; fromStatus: WalletStatus | null }): string | null {
  const { from, to } = input;
  if (!isSource(from) || !isSource(to) || from === to) return null;
  const fromName = input.fromLabel ?? FALLBACK_TO[from];
  const why = input.fromStatus === 'over' ? 'was empty' : input.fromStatus === 'paused' ? 'is paused' : "couldn't cover this";
  return `Used ${FALLBACK_TO[to]} because ${fromName} ${why}.`;
}

/**
 * Who an automation spends as (Spec SPEND-6, D-OW-34): a scheduled run spends the drive's wallet
 * as its creator, under the creator's caps and fallback; a channel mention or a manual Run is the
 * spend of whoever triggered it. For the workflow and trigger surfaces.
 */
export function automationSpendCopy(input: { creatorName: string | null; walletLabel: string | null }): { badge: string; line: string | null; detail: string } {
  const firstName = input.creatorName?.trim().split(/\s+/)[0] ?? null;
  const wallet = input.walletLabel ?? "the drive's wallet";
  return {
    badge: firstName ? `As ${firstName}` : 'As its creator',
    line: input.creatorName ? `Created by ${input.creatorName}` : null,
    detail: `Each scheduled run spends from ${wallet} as ${input.creatorName ?? 'its creator'}, under their caps and fallback. A channel mention or a manual Run counts against whoever triggered it. If no source can pay, the run is skipped and logged.`,
  };
}
