# Audit prompt

```
Audit <SCOPE>.

This project's whole value is that every published sentence is exactly
supported by recorded evidence. So the bugs that matter are not crashes. They
are true-looking claims the evidence does not support, and correct numbers
filed under the wrong identity.

Your goals, in order:

1. Find published claims that outrun their evidence.
2. Find values that are right but filed under a wrong or unrefreshable
   identity — cohort, key, measurement version. These reconcile perfectly and
   guards pass, which is why they survive.
3. Find guards that cannot fail: fixtures sharing the code's own assumption,
   corpus tests that pass over zero rows, flags written and read by nothing.
4. Be right. Refute your own findings before reporting them. An audit that
   confirms everything it found is not auditing. Expect to discard most of it.

Ground every finding in something you executed against the real corpus in
public/reports/, not something you reasoned about. State a concrete failure:
specific input, specific wrong output. Few strong findings beat many weak ones.

Two things will bite you:
- `test:unit` starts with `rm -rf .unit-test-dist`, so two test runs in this
  tree destroy each other. Symptom: many files failing in ~40ms. A corrupted
  run can read green.
- Redaction tokens, catalog entries and producer tuples are measurement
  identity, not strings. Changing one can orphan every published report.

Report only; change nothing.
```

## Notes

Scope it to a slice: one evidence family from producer to published sentence,
one PR diff, one published surface against the facts behind it.

Reviewing already-green work is where the surprises are. Last audit, my own
CI-green fixes yielded four more defects, three of them a correction that
introduced a new false claim.
