/** Synthetic members. No real PII. */
export interface Share {
  id: string;
  type: 'Savings' | 'Checking' | 'Money Market' | 'Club';
  nickname: string;
  balance: number;
  available: number;
}
export interface Loan {
  id: string;
  type: string;
  balance: number;
  nextPayment: number;
  dueDate: string;
}
export interface Card {
  id: string;
  last4: string;
  type: string;
  status: 'Active' | 'Blocked' | 'Closed';
}
export interface Member {
  number: string;
  firstName: string;
  lastName: string;
  ssnLast4: string;
  phone: string;
  address: string;
  memberSince: string;
  shares: Share[];
  loans: Loan[];
  cards: Card[];
}

function m(
  number: string,
  firstName: string,
  lastName: string,
  ssnLast4: string,
  savings: number,
  checking: number,
  extras: Partial<Member> = {},
): Member {
  return {
    number,
    firstName,
    lastName,
    ssnLast4,
    phone: '555-01' + number.slice(-2),
    address: `${number.slice(-3)} Example St, Springfield, US`,
    memberSince: '2015-03-1' + number.slice(-1),
    shares: [
      { id: 'S01', type: 'Savings', nickname: 'Primary Savings', balance: savings, available: savings - 5 },
      { id: 'S05', type: 'Checking', nickname: 'Everyday Checking', balance: checking, available: checking },
    ],
    loans: [],
    cards: [{ id: 'C1', last4: number.slice(-4), type: 'Debit', status: 'Active' }],
    ...extras,
  };
}

function seed(): Record<string, Member> {
  return {
    '10001': m('10001', 'Alice', 'Harborview', '1234', 2540.12, 1203.55, {
      loans: [{ id: 'L20', type: 'Auto Loan', balance: 11250.0, nextPayment: 312.4, dueDate: '2026-10-01' }],
    }),
    '10002': m('10002', 'Bruno', 'Okafor', '5678', 18.4, 0.0),
    '10003': m('10003', 'Chen', 'Delacroix', '9012', 75000.0, 4310.9, {
      shares: [
        { id: 'S01', type: 'Savings', nickname: 'Primary Savings', balance: 75000.0, available: 74995.0 },
        { id: 'S05', type: 'Checking', nickname: 'Everyday Checking', balance: 4310.9, available: 4310.9 },
        { id: 'S20', type: 'Money Market', nickname: 'Rainy Day', balance: 12000.0, available: 12000.0 },
      ],
    }),
    '10042': m('10042', 'Dana', 'Whitfield', '3456', 640.0, 88.13),
  };
}

/** In-memory state. Writes (sub-accounts, card blocks) mutate it; `resetMembers()` restores the seed. */
export const MEMBERS: Record<string, Member> = seed();

export function resetMembers() {
  for (const k of Object.keys(MEMBERS)) delete MEMBERS[k];
  Object.assign(MEMBERS, seed());
}

/** Sub-account products a member can open. */
export const SUB_ACCOUNT_PRODUCTS = [
  { code: 'CLUB', name: 'Holiday Club', minDeposit: 25 },
  { code: 'MM', name: 'Money Market', minDeposit: 1000 },
  { code: 'SAV2', name: 'Secondary Savings', minDeposit: 5 },
];

/** Synthetic operator credentials. */
export const OPERATORS: Record<string, { password: string; canBlockCards: boolean }> = {
  tlr0421: { password: 'demo123', canBlockCards: true },
  teller2: { password: 'demo123', canBlockCards: false },
};
