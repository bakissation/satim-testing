/**
 * Official SATIM certification test cards, copied verbatim from SATIM's
 * certification documentation (mirrored in `satim-ts/docs/satim-gateway.md`).
 * These are the only PANs that work on SATIM's test platform — **never invent PANs.**
 * Only `valid` / `validCredit` are approved; every other card declines for the
 * stated reason. Feed them via `pay(orderId, { card })` (Tier 1) or by typing
 * them into the mock payment page (Tier 3).
 */
export interface TestCard {
  pan: string;
  exp: string;
  cvv2: string;
  password: string;
  /** What the SATIM gateway does with this card. */
  outcome: 'approved' | 'declined';
  /** The reason label from SATIM's certification sheet. */
  reason: string;
}

export const testCards = {
  valid: { pan: '6280581110007215', exp: '01/2027', cvv2: '373', password: '123456', outcome: 'approved', reason: 'Valid' },
  validCredit: { pan: '6280580610061011', exp: '01/2027', cvv2: '992', password: '123456', outcome: 'approved', reason: 'Valid credit' },
  temporarilyBlocked: { pan: '6280581110006712', exp: '01/2027', cvv2: '897', password: '123456', outcome: 'declined', reason: 'Temporarily blocked' },
  lost: { pan: '6280581110006316', exp: '01/2027', cvv2: '657', password: '123456', outcome: 'declined', reason: 'Lost' },
  stolen: { pan: '6280581110006415', exp: '01/2027', cvv2: '958', password: '123456', outcome: 'declined', reason: 'Stolen' },
  incorrectExpiry: { pan: '6280581110006613', exp: '08/2027', cvv2: '411', password: '123456', outcome: 'declined', reason: 'Incorrect expiration entry' },
  notOnIssuer: { pan: '6280581110003927', exp: '01/2025', cvv2: '834', password: '123456', outcome: 'declined', reason: 'Card no longer on issuer server' },
  limitExceeded: { pan: '6280580610061219', exp: '01/2027', cvv2: '049', password: '123456', outcome: 'declined', reason: 'Card limit exceeded' },
  insufficientBalance: { pan: '6280580610061110', exp: '01/2027', cvv2: '260', password: '123456', outcome: 'declined', reason: 'Insufficient balance' },
  incorrectCvv2: { pan: '6280581110006514', exp: '01/2027', cvv2: '205', password: '123456', outcome: 'declined', reason: 'Incorrect CVV2' },
  passwordAttemptsExceeded: { pan: '6280580610061318', exp: '01/2027', cvv2: '930', password: '666666', outcome: 'declined', reason: 'Exceeded password attempts (3 wrong)' },
  notAuthorizedOnline: { pan: '6280581110007017', exp: '01/2027', cvv2: '632', password: '123456', outcome: 'declined', reason: 'Not authorized for online payment' },
  notActiveOnline: { pan: '6280581110007116', exp: '01/2027', cvv2: '040', password: '123456', outcome: 'declined', reason: 'Not active for online payment' },
  amountLimitExceeded: { pan: '6280581110007314', exp: '01/2027', cvv2: '821', password: '123456', outcome: 'declined', reason: 'Terminal/transaction amount limit exceeded' },
  expired: { pan: '6280580610056615', exp: '12/2022', cvv2: '428', password: '123456', outcome: 'declined', reason: 'Expired card' },
} as const satisfies Record<string, TestCard>;

export type TestCardName = keyof typeof testCards;

/** Outcome for a raw PAN. Matches a known cert card; an unknown PAN is treated as declined. */
export function cardOutcome(pan: string): 'approved' | 'declined' {
  const clean = pan.replace(/\s/g, '');
  const hit = Object.values(testCards).find((c) => c.pan === clean);
  return hit ? hit.outcome : 'declined';
}

/** The result SATIM expects for a certification line item. */
export type CertExpectation = 'accepted' | 'refused' | 'refunded' | 'cancelled';

/** One row of SATIM's certification test matrix (the cahier de recette). */
export interface CertCase {
  /** SATIM's "Test effectué" wording. */
  test: string;
  /** SATIM's "Résultats attendus". */
  expected: CertExpectation;
  /** The test card the case uses, when it's a card test. */
  card?: TestCardName;
}

/**
 * SATIM's certification transaction matrix, transcribed from the CIBWEBSATIM
 * validation console (the official cahier de recette). Walk it as your e2e
 * suite — passing every case against the mock is the strongest signal that a
 * real integration will pass SATIM certification. (Real cert still runs on
 * `test2.satim.dz`; this only proves your *integration logic* is correct.)
 */
export const certChecklist: readonly CertCase[] = [
  { test: 'Paiement en ligne avec carte CIB valide', expected: 'accepted', card: 'valid' },
  { test: 'Paiement en ligne avec carte CIB temporairement bloquée', expected: 'refused', card: 'temporarilyBlocked' },
  { test: 'Paiement en ligne avec carte CIB déclarée perdue', expected: 'refused', card: 'lost' },
  { test: 'Paiement en ligne avec carte CIB déclarée volée', expected: 'refused', card: 'stolen' },
  { test: "Paiement en ligne avec saisie erronée de la date d'expiration", expected: 'refused', card: 'incorrectExpiry' },
  { test: "Paiement en ligne avec carte inexistante sur le serveur de l'émetteur", expected: 'refused', card: 'notOnIssuer' },
  { test: 'Paiement en ligne avec dépassement du plafond de la carte', expected: 'refused', card: 'limitExceeded' },
  { test: 'Paiement en ligne avec solde insuffisant', expected: 'refused', card: 'insufficientBalance' },
  { test: 'Paiement en ligne avec CVV2 erroné', expected: 'refused', card: 'incorrectCvv2' },
  { test: 'Paiement en ligne avec dépassement du nombre autorisé des mots de passe erronés', expected: 'refused', card: 'passwordAttemptsExceeded' },
  { test: 'Carte non autorisée pour le service de paiement en ligne', expected: 'refused', card: 'notAuthorizedOnline' },
  { test: 'Paiement en ligne avec carte inactive pour le service de paiement en ligne', expected: 'refused', card: 'notActiveOnline' },
  { test: 'Paiement en ligne avec dépassement du montant plafond du terminal', expected: 'refused', card: 'amountLimitExceeded' },
  { test: 'Paiement en ligne avec carte expirée', expected: 'refused', card: 'expired' },
  { test: "Remboursement d'une transaction via l'interface de la plateforme SATIM", expected: 'refunded' },
  { test: "Annulation d'une transaction via l'interface de la plateforme SATIM", expected: 'cancelled' },
];
