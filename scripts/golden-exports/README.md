# Golden exports

`gen.py` writes the twelve CSV exports used by `__tests__/goldenExports.test.ts`
(Square, Shopify, Stripe, SumUp, a bank statement, a QuickBooks profit and
loss, a hand-kept takings sheet, a customer survey, timesheets, inventory,
marketing and a wide monthly sheet). They copy the layouts these systems
really export: order details only on an order's first line, report headings
and totals, dotted dates with times, decimal commas, mixed date styles.

Run it from `__tests__/golden-exports/` (`python3 ../../scripts/golden-exports/gen.py`).
The seed is fixed, so the files only change if the script does. The expected
totals in the test were added up straight from the raw CSVs, never from
QuickInsight's own output.
