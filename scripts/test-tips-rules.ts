/**
 * Tip distribution (M20 / AROS-181) — the PURE function, no database.
 *
 *   npx tsx scripts/test-tips-rules.ts
 */
import {
  DEFAULT_TIP_RULES,
  apportion,
  computeTipDistribution,
  isPeriodOver,
  isTipPeriod,
  periodRange,
  validateTipRules,
  type TipPerson,
  type TipRules,
} from '../lib/tips/rules'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const paise = (n: number) => Math.round(n * 100)

const staff: TipPerson[] = [
  { membershipId: 'ann', role: 'floor_staff', hours: 40 },
  { membershipId: 'bob', role: 'floor_staff', hours: 20 },
  { membershipId: 'cat', role: 'floor_staff', hours: 0 }, // on the roster, never clocked in
  { membershipId: 'kim', role: 'kitchen_staff', hours: 30 },
  { membershipId: 'kai', role: 'kitchen_staff', hours: 10 },
  { membershipId: 'mgr', role: 'manager', hours: 50 },
]
const rules = (o: Partial<TipRules> = {}): TipRules => ({ ...DEFAULT_TIP_RULES, ...o })
const by = (r: ReturnType<typeof computeTipDistribution>, id: string) => r.payouts.find((p) => p.membershipId === id)
/** The invariant that matters: not a paisa created or lost. */
const exact = (r: ReturnType<typeof computeTipDistribution>) => paise(r.distributed) + paise(r.undistributed) === paise(r.totalTips) && paise(r.distributed) === r.payouts.reduce((n, p) => n + paise(p.total), 0)

// ── apportion ───────────────────────────────────────────────────────────────
const ap = apportion(100, [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }])
check('100 paise over 3 equal weights = 34/33/33 (extra paisa to the first on a tie)', ap.get('a') === 34 && ap.get('b') === 33 && ap.get('c') === 33)
check('apportion always sums to the total', [...ap.values()].reduce((n, v) => n + v, 0) === 100)
check('weights are proportional (3:1 of 400 -> 300/100)', apportion(400, [{ id: 'x', weight: 3 }, { id: 'y', weight: 1 }]).get('x') === 300)
check('zero / negative weights get nothing', !apportion(100, [{ id: 'x', weight: 0 }, { id: 'y', weight: 2 }]).has('x'))
check('nothing to split / nobody to split between is empty', apportion(0, [{ id: 'x', weight: 1 }]).size === 0 && apportion(100, []).size === 0)

// ── direct ──────────────────────────────────────────────────────────────────
const d1 = computeTipDistribution({
  rules: rules({ mode: 'direct' }),
  tips: [{ recipientId: 'ann', amount: 1000 }, { recipientId: 'bob', amount: 400 }],
  people: staff,
})
check('direct: each server keeps their own tips', by(d1, 'ann')?.total === 1000 && by(d1, 'bob')?.total === 400 && d1.payouts.length === 2)
check('direct: nothing undistributed, exact', d1.undistributed === 0 && d1.totalTips === 1400 && exact(d1))

const d2 = computeTipDistribution({
  rules: rules({ mode: 'direct', tipOutPct: 10, tipOutRoles: ['kitchen_staff'] }),
  tips: [{ recipientId: 'ann', amount: 1000 }, { recipientId: 'bob', amount: 400 }],
  people: staff,
})
check('direct + 10% tip-out: servers keep 90% (ann 900, bob 360)', by(d2, 'ann')?.own === 900 && by(d2, 'bob')?.own === 360)
check('...ann gave up 100, bob 40', by(d2, 'ann')?.tippedOut === 100 && by(d2, 'bob')?.tippedOut === 40)
check('...the 140 goes to kitchen by hours (30h:10h -> 105 / 35)', by(d2, 'kim')?.tipOutReceived === 105 && by(d2, 'kai')?.tipOutReceived === 35)
check('...exact to the paisa', exact(d2) && d2.totalTips === 1400 && d2.undistributed === 0)

// unattributed
const d3 = computeTipDistribution({
  rules: rules({ mode: 'direct' }),
  tips: [{ recipientId: 'ann', amount: 500 }, { recipientId: null, amount: 300 }],
  people: staff,
})
check('direct: unattributed tips are shared by hours among the pool roles (ann 40h, bob 20h -> 200/100)', by(d3, 'ann')?.poolShare === 200 && by(d3, 'bob')?.poolShare === 100)
check('...ann = 500 own + 200 share', by(d3, 'ann')?.total === 700 && d3.unattributed === 300 && exact(d3))
check('someone who never clocked in (0h) gets no share', by(d3, 'cat') === undefined)
check('a manager is not in the pool unless the rules say so', by(d3, 'mgr') === undefined)

// ── pooled ──────────────────────────────────────────────────────────────────
const p1 = computeTipDistribution({
  rules: rules({ mode: 'pooled' }),
  tips: [{ recipientId: 'ann', amount: 1000 }, { recipientId: 'bob', amount: 200 }, { recipientId: null, amount: 100 }],
  people: staff,
})
check('pooled: 1300 split by hours 40:20 -> 866.67 / 433.33', by(p1, 'ann')?.total === 866.67 && by(p1, 'bob')?.total === 433.33)
check('pooled: who earned the tip no longer matters, and it is exact', exact(p1) && p1.totalTips === 1300)

const p2 = computeTipDistribution({
  rules: rules({ mode: 'pooled', tipOutPct: 20, tipOutRoles: ['kitchen_staff'] }),
  tips: [{ recipientId: 'ann', amount: 1000 }],
  people: staff,
})
check('pooled + 20% tip-out: 200 to kitchen (150 / 50), 800 to the floor by hours', by(p2, 'kim')?.total === 150 && by(p2, 'kai')?.total === 50)
check('...floor 800 split 40:20 -> 533.33 / 266.67', by(p2, 'ann')?.total === 533.33 && by(p2, 'bob')?.total === 266.67)
check('...exact', exact(p2))

const p3 = computeTipDistribution({
  rules: rules({ mode: 'pooled', poolRoles: ['floor_staff', 'manager'] }),
  tips: [{ recipientId: 'ann', amount: 1100 }],
  people: staff,
})
check('pool roles are configurable (a manager can share: 40/20/50 of 1100)', by(p3, 'mgr')?.total === 500 && by(p3, 'ann')?.total === 400 && by(p3, 'bob')?.total === 200)

// ── degenerate cases ────────────────────────────────────────────────────────
const e1 = computeTipDistribution({ rules: rules({ mode: 'pooled' }), tips: [{ recipientId: 'ann', amount: 500 }], people: staff.map((p) => ({ ...p, hours: 0 })) })
check('pooled with nobody clocked in: nothing is invented — all 500 is undistributed', e1.payouts.length === 0 && e1.undistributed === 500 && exact(e1))
const e2 = computeTipDistribution({
  rules: rules({ mode: 'direct', tipOutPct: 10, tipOutRoles: ['kitchen_staff'] }),
  tips: [{ recipientId: 'ann', amount: 1000 }],
  people: staff.map((p) => (p.role === 'kitchen_staff' ? { ...p, hours: 0 } : p)),
})
check('tip-out with no kitchen on shift is NOT taken: ann keeps all 1000', by(e2, 'ann')?.total === 1000 && e2.tipOutSkipped && exact(e2))
const e3 = computeTipDistribution({ rules: rules(), tips: [], people: staff })
check('no tips -> no payouts, zero everything', e3.payouts.length === 0 && e3.totalTips === 0 && e3.undistributed === 0)
const e4 = computeTipDistribution({ rules: rules({ mode: 'direct' }), tips: [{ recipientId: 'gone', amount: 250 }], people: staff })
check("direct: a recipient with no hours/role row still keeps their tips (they earned them)", by(e4, 'gone')?.total === 250 && exact(e4))
const e5 = computeTipDistribution({ rules: rules({ mode: 'direct' }), tips: [{ recipientId: 'ann', amount: 0.1 }, { recipientId: 'ann', amount: 0.2 }], people: staff })
check('no float dust (0.1 + 0.2 = exactly 0.30)', by(e5, 'ann')?.total === 0.3 && exact(e5))
const e6 = computeTipDistribution({ rules: rules({ mode: 'pooled', tipOutPct: 33.33, tipOutRoles: ['kitchen_staff'] }), tips: [{ recipientId: 'ann', amount: 9999.99 }, { recipientId: null, amount: 0.01 }], people: staff })
check('awkward percentages and amounts still reconcile to the paisa', exact(e6) && e6.totalTips === 10000)
let thrown = false
try {
  computeTipDistribution({ rules: rules(), tips: [{ recipientId: 'ann', amount: -5 }], people: staff })
} catch {
  thrown = true
}
check('a negative tip is rejected, not silently netted', thrown)

// property: random inputs always reconcile
let propOk = true
let seed = 7
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
for (let n = 0; n < 300 && propOk; n++) {
  const people: TipPerson[] = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) => ({
    membershipId: `p${i}`,
    role: (['floor_staff', 'kitchen_staff', 'manager', 'cashier'] as const)[Math.floor(rnd() * 4)],
    hours: rnd() < 0.2 ? 0 : Math.round(rnd() * 400) / 10,
  }))
  const tips = Array.from({ length: Math.floor(rnd() * 8) }, () => ({
    recipientId: rnd() < 0.3 ? null : `p${Math.floor(rnd() * 7)}`,
    amount: Math.round(rnd() * 100000) / 100,
  }))
  const r = rules({
    mode: rnd() < 0.5 ? 'direct' : 'pooled',
    tipOutPct: Math.round(rnd() * 5000) / 100,
    poolRoles: ['floor_staff', 'cashier'],
    tipOutRoles: ['kitchen_staff'],
  })
  const out = computeTipDistribution({ rules: r, tips, people })
  if (!exact(out) || out.payouts.some((p) => p.total <= 0)) propOk = false
}
check('300 random scenarios: payouts + undistributed == total tips, to the paisa, every time', propOk)

// ── validation + periods ────────────────────────────────────────────────────
check('default rules are valid and direct with no tip-out', validateTipRules(DEFAULT_TIP_RULES) === null && DEFAULT_TIP_RULES.mode === 'direct' && DEFAULT_TIP_RULES.tipOutPct === 0)
check('tip-out % outside 0–100 refused', validateTipRules(rules({ tipOutPct: 101 })) !== null && validateTipRules(rules({ tipOutPct: -1 })) !== null)
check('a tip-out % with nobody to receive it is refused', validateTipRules(rules({ tipOutPct: 10, tipOutRoles: [] })) !== null)
check('a role cannot be both pooled and tipped out to', validateTipRules(rules({ tipOutPct: 10, poolRoles: ['floor_staff'], tipOutRoles: ['floor_staff'] })) !== null)
check('unknown role refused', validateTipRules(rules({ poolRoles: ['wizard'] })) !== null)
check('pooled mode needs at least one pool role', validateTipRules(rules({ mode: 'pooled', poolRoles: [] })) !== null)
check('period helpers', isTipPeriod('2026-09') && !isTipPeriod('2026-13') && !isTipPeriod('2026-9') && periodRange('2026-02').end === '2026-02-28' && periodRange('2028-02').end === '2028-02-29')
check('a month can be closed only once it is over', isPeriodOver('2026-09', '2026-10-01') && !isPeriodOver('2026-10', '2026-10-31') && !isPeriodOver('2026-10', '2026-10-01'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
