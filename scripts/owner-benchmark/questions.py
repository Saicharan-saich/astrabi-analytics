"""Owner questions, worded the way café, shop and online-shop owners type them.

Every case has:
  sql   DuckDB gold SQL. The app re-runs it before scoring, and CI runs it in DuckDB too.
  ref   the same answer worked out separately in pandas. freeze.py stores ref's rows, so the
        frozen answer comes from a different engine than the one that checks it.
  alts  other readings an owner could fairly mean ("sales" before or after discounts, the top
        item alone or the top 10). Each has its own SQL and pandas answer.

The data ends on Wednesday 4 Nov 2026, so: this week = Mon 2 – Wed 4 Nov, last week = Mon 26 Oct
– Sun 1 Nov, last month = October 2026, yesterday = 3 Nov, this year = 2026.
"""
import pandas as pd

WEEK = ('2026-10-26', '2026-11-01')
PREV_WEEK = ('2026-10-19', '2026-10-25')
THIS_WEEK = ('2026-11-02', '2026-11-04')
OCT = ('2026-10-01', '2026-10-31')
SEP = ('2026-09-01', '2026-09-30')
NOV = ('2026-11-01', '2026-11-04')
YEAR = ('2026-01-01', '2026-11-04')


def r2(x):
    return None if x is None or pd.isna(x) else round(float(x) + 0.0, 2)


def r1(x):
    return None if x is None or pd.isna(x) else round(float(x) + 0.0, 1)


def between(df, col, span):
    return df[(df[col] >= span[0]) & (df[col] <= span[1])]


def plain(v):
    """A JSON-safe Python value: NaN → None, numpy numbers → int/float."""
    if v is None:
        return None
    if hasattr(v, 'item'):
        v = v.item()
    if isinstance(v, float) and pd.isna(v):
        return None
    return v


def rows(df):
    return [{k: plain(v) for k, v in r.items()} for r in df.to_dict('records')]


def one(**kw):
    return [kw]


def top(df, key, n=10, asc=False):
    return df.sort_values(key, ascending=asc).head(n)


def sql_d(col='date'):
    return f'CAST("{col}" AS DATE)'


DAY_ONLINE = 'CAST(CAST("paid_at" AS TIMESTAMP) AS DATE)'

Q = []


def case(qid, ds, diff, cat, question, sql, ref, alts=()):
    Q.append({'id': qid, 'ds': ds, 'difficulty': diff, 'category': cat, 'question': question, 'sql': sql, 'ref': ref, 'alts': list(alts)})


# ═══════════════════════════════ Café (Square item sales) ═══════════════════════════════
C = 'cafe'
bw = lambda span, col='date': f"{sql_d(col)} BETWEEN DATE '{span[0]}' AND DATE '{span[1]}'"

def total(measure, span):
    return (f'SELECT ROUND(SUM("{measure}"), 2) AS total FROM "data" WHERE {bw(span)}',
            lambda d, m=measure, s=span: one(total=r2(between(d, 'date', s)[m].sum())))

def total_payments(measure, span):
    return (f'SELECT ROUND(SUM("{measure}"), 2) AS total FROM "data" WHERE {bw(span)} AND "event_type" = \'Payment\'',
            lambda d, m=measure, s=span: one(total=r2(between(d[d.event_type == 'Payment'], 'date', s)[m].sum())))

sql, ref = total('net_sales', WEEK)
case('c01', C, 'easy', 'period total', 'How much did we take last week?', sql, ref,
     [('gross sales', *total('gross_sales', WEEK)), ('payments only, before refunds', *total_payments('net_sales', WEEK))])
sql, ref = total('net_sales', OCT)
case('c02', C, 'easy', 'period total', 'total sales in october', sql, ref,
     [('gross sales', *total('gross_sales', OCT)), ('payments only, before refunds', *total_payments('net_sales', OCT))])
case('c03', C, 'easy', 'count', 'How many transactions did we do yesterday?',
     f'SELECT COUNT(DISTINCT "transaction_id") AS transactions FROM "data" WHERE {sql_d()} = DATE \'2026-11-03\'',
     lambda d: one(transactions=int(d[d.date == '2026-11-03'].transaction_id.nunique())))

def avg_txn(measure):
    return (f'SELECT ROUND(SUM("{measure}") / COUNT(DISTINCT "transaction_id"), 2) AS average_transaction FROM "data"',
            lambda d, m=measure: one(average_transaction=r2(d[m].sum() / d.transaction_id.nunique())))
sql, ref = avg_txn('net_sales')
case('c04', C, 'medium', 'average per transaction', "what's our average transaction value", sql, ref, [('gross sales', *avg_txn('gross_sales'))])

def by_loc(measure, span):
    return (f'SELECT "location", ROUND(SUM("{measure}"), 2) AS total FROM "data" WHERE {bw(span)} GROUP BY "location" ORDER BY total DESC',
            lambda d, m=measure, s=span: rows(between(d, 'date', s).groupby('location', as_index=False)[m].sum().rename(columns={m: 'total'}).assign(total=lambda x: x.total.map(r2))))
sql, ref = by_loc('net_sales', OCT)
case('c05', C, 'medium', 'compare groups', 'Which site took more money last month, Station or Market Street?', sql, ref,
     [('gross sales', *by_loc('gross_sales', OCT)),
      ('the winning site only', f'SELECT "location", ROUND(SUM("net_sales"), 2) AS total FROM "data" WHERE {bw(OCT)} GROUP BY "location" ORDER BY total DESC LIMIT 1',
       lambda d: rows(top(between(d, 'date', OCT).groupby('location', as_index=False).net_sales.sum().rename(columns={'net_sales': 'total'}), 'total', 1).assign(total=lambda x: x.total.map(r2))))])

def item_qty(item, span, payments_only=False):
    cond = " AND \"event_type\" = 'Payment'" if payments_only else ''
    return (f'SELECT COALESCE(SUM("qty"), 0) AS units FROM "data" WHERE LOWER("item") = LOWER(\'{item}\') AND {bw(span)}{cond}',
            lambda d, i=item, s=span, p=payments_only: one(units=int(between(d[(d['item'].str.lower() == i.lower()) & ((d.event_type == 'Payment') if p else True)], 'date', s).qty.sum())))
sql, ref = item_qty('Flat White', THIS_WEEK)
case('c06', C, 'easy', 'filtered count', 'how many flat whites have we sold this week?', sql, ref, [('before refunds', *item_qty('Flat White', THIS_WEEK, True))])

def top_items(measure, n):
    return (f'SELECT "item", ROUND(SUM("{measure}"), 2) AS total FROM "data" GROUP BY "item" ORDER BY total DESC LIMIT {n}',
            lambda d, m=measure, k=n: rows(top(d.groupby('item', as_index=False)[m].sum().rename(columns={m: 'total'}), 'total', k).assign(total=lambda x: x.total.map(r2))))
sql, ref = top_items('net_sales', 5)
case('c07', C, 'easy', 'ranking', 'Show me our top 5 sellers by revenue', sql, ref, [('gross sales', *top_items('gross_sales', 5))])

def hour(col='time'):
    return f'CAST(SPLIT_PART("{col}", \':\', 1) AS INTEGER)'
case('c08', C, 'medium', 'time of day', 'What time of day are we busiest? Number of transactions per hour please',
     f'SELECT {hour()} AS hour, COUNT(DISTINCT "transaction_id") AS transactions FROM "data" GROUP BY 1 ORDER BY 1',
     lambda d: rows(d.assign(hour=d.time.str.split(':').str[0].astype(int)).groupby('hour', as_index=False).transaction_id.nunique().rename(columns={'transaction_id': 'transactions'})))

def by_weekday(measure, n=None):
    lim = f' LIMIT {n}' if n else ''
    def f(d, m=measure, k=n):
        g = d.assign(weekday=pd.to_datetime(d.date).dt.day_name()).groupby('weekday', as_index=False)[m].sum().rename(columns={m: 'total'})
        g = g.sort_values('total', ascending=False)
        return rows((g.head(k) if k else g).assign(total=lambda x: x.total.map(r2)))
    return (f'SELECT DAYNAME({sql_d()}) AS weekday, ROUND(SUM("{measure}"), 2) AS total FROM "data" GROUP BY 1 ORDER BY total DESC{lim}', f)
sql, ref = by_weekday('net_sales')
case('c09', C, 'medium', 'day of week', 'Which day of the week brings in the most money?', sql, ref,
     [('the top day only', *by_weekday('net_sales', 1)), ('gross sales', *by_weekday('gross_sales')), ('gross sales, top day only', *by_weekday('gross_sales', 1))])

case('c10', C, 'medium', 'period total', 'how much did we give away in discounts last month',
     f'SELECT ROUND(-SUM("discounts"), 2) AS discounts_given FROM "data" WHERE {bw(OCT)}',
     lambda d: one(discounts_given=r2(-between(d, 'date', OCT).discounts.sum())),
     [('as the signed total (negative)', f'SELECT ROUND(SUM("discounts"), 2) AS discounts_given FROM "data" WHERE {bw(OCT)}',
       lambda d: one(discounts_given=r2(between(d, 'date', OCT).discounts.sum())))])

def refunds(count_txn, sign):
    cnt = 'COUNT(DISTINCT "transaction_id")' if count_txn else 'COUNT(*)'
    val = '-SUM("net_sales")' if sign < 0 else 'SUM("net_sales")'
    def f(d, c=count_txn, s=sign):
        x = between(d[d.event_type == 'Refund'], 'date', OCT)
        return one(refunds=int(x.transaction_id.nunique() if c else len(x)), refunded=r2(s * x.net_sales.sum()))
    return (f'SELECT {cnt} AS refunds, ROUND({val}, 2) AS refunded FROM "data" WHERE "event_type" = \'Refund\' AND {bw(OCT)}', f)
sql, ref = refunds(False, -1)
case('c11', C, 'medium', 'filtered total', 'How many refunds did we do in October and how much were they worth?', sql, ref,
     [('value as a negative', *refunds(False, 1)), ('refunded transactions', *refunds(True, -1)), ('refunded transactions, value as a negative', *refunds(True, 1))])

def share_to_go(measure):
    return (f'SELECT ROUND(100.0 * SUM(CASE WHEN "dining_option" = \'To Go\' THEN "{measure}" ELSE 0 END) / SUM("{measure}"), 1) AS takeaway_pct FROM "data"',
            lambda d, m=measure: one(takeaway_pct=r1(100 * d[d.dining_option == 'To Go'][m].sum() / d[m].sum())))
def share_split(measure):
    return (f'SELECT "dining_option", ROUND(100.0 * SUM("{measure}") / SUM(SUM("{measure}")) OVER (), 1) AS pct FROM "data" GROUP BY 1',
            lambda d, m=measure: rows(d.groupby('dining_option', as_index=False)[m].sum().assign(pct=lambda x: (100 * x[m] / x[m].sum()).map(r1))[['dining_option', 'pct']]))
def share_count():
    return (f'SELECT ROUND(100.0 * COUNT(DISTINCT CASE WHEN "dining_option" = \'To Go\' THEN "transaction_id" END) / COUNT(DISTINCT "transaction_id"), 1) AS takeaway_pct FROM "data"',
            lambda d: one(takeaway_pct=r1(100 * d[d.dining_option == 'To Go'].transaction_id.nunique() / d.transaction_id.nunique())))
sql, ref = share_to_go('net_sales')
case('c12', C, 'medium', 'share', 'What percentage of our sales are takeaway?', sql, ref,
     [('gross sales', *share_to_go('gross_sales')), ('both options', *share_split('net_sales')), ('both options, gross', *share_split('gross_sales')), ('share of transactions', *share_count())])

case('c13', C, 'medium', 'repeat customers', 'how many customers have come back more than once',
     'SELECT COUNT(*) AS repeat_customers FROM (SELECT "customer_id" FROM "data" WHERE "customer_id" IS NOT NULL GROUP BY 1 HAVING COUNT(DISTINCT "transaction_id") > 1) t',
     lambda d: one(repeat_customers=int((d.dropna(subset=['customer_id']).groupby('customer_id').transaction_id.nunique() > 1).sum())),
     [('visited at least three times (came back more than once)', 'SELECT COUNT(*) AS repeat_customers FROM (SELECT "customer_id" FROM "data" WHERE "customer_id" IS NOT NULL GROUP BY 1 HAVING COUNT(DISTINCT "transaction_id") > 2) t',
       lambda d: one(repeat_customers=int((d.dropna(subset=['customer_id']).groupby('customer_id').transaction_id.nunique() > 2).sum())))])
case('c14', C, 'easy', 'distinct count', 'How many different customers did we have last month?',
     f'SELECT COUNT(DISTINCT "customer_id") AS customers FROM "data" WHERE {bw(OCT)}',
     lambda d: one(customers=int(between(d, 'date', OCT).customer_id.nunique())))

def weekly(measure):
    def f(d, m=measure):
        x = d[d.date >= '2026-09-01'].copy(); dt = pd.to_datetime(x.date)
        x['week'] = (dt - pd.to_timedelta(dt.dt.weekday, unit='D')).dt.strftime('%Y-%m-%d')
        return rows(x.groupby('week', as_index=False)[m].sum().rename(columns={m: 'total'}).assign(total=lambda y: y.total.map(r2)))
    return (f'SELECT STRFTIME(DATE_TRUNC(\'week\', {sql_d()}), \'%Y-%m-%d\') AS week, ROUND(SUM("{measure}"), 2) AS total FROM "data" WHERE {sql_d()} >= DATE \'2026-09-01\' GROUP BY 1 ORDER BY 1', f)
sql, ref = weekly('net_sales')
case('c15', C, 'medium', 'trend', 'show weekly sales since september', sql, ref, [('gross sales', *weekly('gross_sales'))])

def monthly(measure):
    return (f'SELECT STRFTIME(DATE_TRUNC(\'month\', {sql_d()}), \'%Y-%m-%d\') AS month, ROUND(SUM("{measure}"), 2) AS total FROM "data" GROUP BY 1 ORDER BY 1',
            lambda d, m=measure: rows(d.assign(month=d.date.str[:7] + '-01').groupby('month', as_index=False)[m].sum().rename(columns={m: 'total'}).assign(total=lambda y: y.total.map(r2))))
sql, ref = monthly('net_sales')
case('c16', C, 'easy', 'trend', 'Monthly takings', sql, ref, [('gross sales', *monthly('gross_sales'))])

def site_day(measure):
    return (f'SELECT ROUND(SUM("{measure}"), 2) AS total FROM "data" WHERE LOWER("location") = LOWER(\'Market Street\') AND {sql_d()} = DATE \'2026-10-29\'',
            lambda d, m=measure: one(total=r2(d[(d.location == 'Market Street') & (d.date == '2026-10-29')][m].sum())))
sql, ref = site_day('net_sales')
case('c17', C, 'easy', 'filtered total', 'What did Market Street take on Thursday 29th October?', sql, ref, [('gross sales', *site_day('gross_sales'))])

def by_cat(measure, n=10):
    return (f'SELECT "category", ROUND(SUM("{measure}"), 2) AS total FROM "data" GROUP BY 1 ORDER BY total DESC LIMIT {n}',
            lambda d, m=measure, k=n: rows(top(d.groupby('category', as_index=False)[m].sum().rename(columns={m: 'total'}), 'total', k).assign(total=lambda y: y.total.map(r2))))
sql, ref = by_cat('net_sales')
case('c18', C, 'medium', 'ranking', 'which category makes us the most money', sql, ref,
     [('top category only', *by_cat('net_sales', 1)), ('gross sales', *by_cat('gross_sales')), ('gross sales, top only', *by_cat('gross_sales', 1))])
case('c19', C, 'medium', 'average per transaction', 'On average how many items are in each transaction?',
     'SELECT ROUND(SUM("qty") * 1.0 / COUNT(DISTINCT "transaction_id"), 2) AS items_per_transaction FROM "data"',
     lambda d: one(items_per_transaction=r2(d.qty.sum() / d.transaction_id.nunique())),
     [('before refunds', 'SELECT ROUND(SUM("qty") * 1.0 / COUNT(DISTINCT "transaction_id"), 2) AS items_per_transaction FROM "data" WHERE "event_type" = \'Payment\'',
       lambda d: one(items_per_transaction=r2(d[d.event_type == 'Payment'].qty.sum() / d[d.event_type == 'Payment'].transaction_id.nunique())))])
sql, ref = total('tax', OCT)
case('c20', C, 'easy', 'period total', 'How much VAT did we collect last month?', sql, ref)

def drop(measure, n):
    def f(d, m=measure, k=n):
        a = between(d, 'date', WEEK).groupby('item')[m].sum(); b = between(d, 'date', PREV_WEEK).groupby('item')[m].sum()
        g = pd.DataFrame({'last_week': a, 'week_before': b}).fillna(0)
        g['change'] = g.last_week - g.week_before
        g = g.reset_index().rename(columns={'index': 'item'}).sort_values('change').head(k)
        return rows(g[['item', 'change']].assign(change=lambda y: y.change.map(r2)))
    return (f"""SELECT "item", ROUND(SUM(CASE WHEN {bw(WEEK)} THEN "{measure}" ELSE 0 END) - SUM(CASE WHEN {bw(PREV_WEEK)} THEN "{measure}" ELSE 0 END), 2) AS change FROM "data" WHERE {sql_d()} BETWEEN DATE '{PREV_WEEK[0]}' AND DATE '{WEEK[1]}' GROUP BY 1 ORDER BY change ASC LIMIT {n}""", f)
sql, ref = drop('net_sales', 10)
case('c21', C, 'hard', 'period comparison', 'Which items dropped the most in sales last week compared with the week before?', sql, ref,
     [('the biggest drop only', *drop('net_sales', 1)), ('gross sales', *drop('gross_sales', 10)), ('gross sales, biggest only', *drop('gross_sales', 1))])
case('c22', C, 'easy', 'price', "What's the average price of a latte?",
     'SELECT ROUND(SUM("gross_sales") / SUM("qty"), 2) AS average_price FROM "data" WHERE LOWER("item") = LOWER(\'Latte\')',
     lambda d: one(average_price=r2(d[d['item'] == 'Latte'].gross_sales.sum() / d[d['item'] == 'Latte'].qty.sum())),
     [('after discounts', 'SELECT ROUND(SUM("net_sales") / SUM("qty"), 2) AS average_price FROM "data" WHERE LOWER("item") = LOWER(\'Latte\')',
       lambda d: one(average_price=r2(d[d['item'] == 'Latte'].net_sales.sum() / d[d['item'] == 'Latte'].qty.sum())))])
case('c23', C, 'medium', 'filtered breakdown', 'How many coffees did each site sell last month?',
     f'SELECT "location", SUM("qty") AS coffees FROM "data" WHERE LOWER("category") = LOWER(\'Coffee\') AND {bw(OCT)} GROUP BY 1 ORDER BY 1',
     lambda d: rows(between(d[d.category == 'Coffee'], 'date', OCT).groupby('location', as_index=False).qty.sum().rename(columns={'qty': 'coffees'})),
     [('before refunds', f'SELECT "location", SUM("qty") AS coffees FROM "data" WHERE LOWER("category") = LOWER(\'Coffee\') AND "event_type" = \'Payment\' AND {bw(OCT)} GROUP BY 1 ORDER BY 1',
       lambda d: rows(between(d[(d.category == 'Coffee') & (d.event_type == 'Payment')], 'date', OCT).groupby('location', as_index=False).qty.sum().rename(columns={'qty': 'coffees'})))])

def best_day(measure, n):
    return (f'SELECT STRFTIME({sql_d()}, \'%Y-%m-%d\') AS day, ROUND(SUM("{measure}"), 2) AS total FROM "data" GROUP BY 1 ORDER BY total DESC LIMIT {n}',
            lambda d, m=measure, k=n: rows(top(d.groupby('date', as_index=False)[m].sum().rename(columns={'date': 'day', m: 'total'}), 'total', k).assign(total=lambda y: y.total.map(r2))))
sql, ref = best_day('net_sales', 10)
case('c24', C, 'easy', 'ranking', 'When was our best day ever for sales?', sql, ref,
     [('the best day only', *best_day('net_sales', 1)), ('gross sales', *best_day('gross_sales', 10)), ('gross sales, best only', *best_day('gross_sales', 1))])

def saturday(measure):
    def f(d, m=measure):
        x = d[pd.to_datetime(d.date).dt.weekday == 5]
        return one(average_saturday=r2(x.groupby('date')[m].sum().mean()))
    return (f'SELECT ROUND(AVG(day_total), 2) AS average_saturday FROM (SELECT {sql_d()} AS day, SUM("{measure}") AS day_total FROM "data" WHERE DAYNAME({sql_d()}) = \'Saturday\' GROUP BY 1) t', f)
sql, ref = saturday('net_sales')
case('c25', C, 'medium', 'average per day', 'how much do we make on an average saturday', sql, ref, [('gross sales', *saturday('gross_sales'))])

def mtd(measure, wide=True):
    if wide:
        return (f"""SELECT ROUND(SUM(CASE WHEN {bw(NOV)} THEN "{measure}" ELSE 0 END), 2) AS this_month, ROUND(SUM(CASE WHEN {bw(('2026-10-01', '2026-10-04'))} THEN "{measure}" ELSE 0 END), 2) AS same_days_last_month FROM "data\"""",
                lambda d, m=measure: one(this_month=r2(between(d, 'date', NOV)[m].sum()), same_days_last_month=r2(between(d, 'date', ('2026-10-01', '2026-10-04'))[m].sum())))
    return (f"""SELECT CASE WHEN {sql_d()} >= DATE '2026-11-01' THEN 'this month' ELSE 'last month' END AS period, ROUND(SUM("{measure}"), 2) AS total FROM "data" WHERE {bw(NOV)} OR {bw(('2026-10-01', '2026-10-04'))} GROUP BY 1""",
            lambda d, m=measure: [{'period': 'this month', 'total': r2(between(d, 'date', NOV)[m].sum())}, {'period': 'last month', 'total': r2(between(d, 'date', ('2026-10-01', '2026-10-04'))[m].sum())}])
sql, ref = mtd('net_sales')
case('c26', C, 'hard', 'period comparison', 'How are sales so far this month compared with the same days last month?', sql, ref,
     [('as two rows', *mtd('net_sales', False)), ('gross sales', *mtd('gross_sales')), ('gross sales, two rows', *mtd('gross_sales', False))])
sql, ref = item_qty('Oat Milk Latte', WEEK)
case('c27', C, 'easy', 'filtered count', 'how many oat milk lattes did we sell last week', sql, ref,
     [('blank when there were none', f'SELECT SUM("qty") AS units FROM "data" WHERE LOWER("item") = LOWER(\'Oat Milk Latte\') AND {bw(WEEK)}', lambda d: one(units=None))])

# ═══════════════════════════════ Shop (till export) ═══════════════════════════════
S = 'shop'

def stotal(expr, span, extra='', name='total'):
    return (f'SELECT ROUND(SUM({expr}), 2) AS {name} FROM "data" WHERE {bw(span)}{extra}', None)

def shop_sum(span, fn, name='total', expr='"line_total"', cond='', cond_fn=None):
    sql = f'SELECT ROUND(SUM({expr}), 2) AS {name} FROM "data" WHERE {bw(span)}{cond}'
    def f(d):
        x = between(d, 'date', span)
        if cond_fn is not None: x = x[cond_fn(x)]
        return one(**{name: r2(fn(x))})
    return sql, f

sql, ref = shop_sum(WEEK, lambda x: x.line_total.sum())
case('s01', S, 'easy', 'period total', 'What were my sales last week?', sql, ref,
     [('before discounts', *shop_sum(WEEK, lambda x: (x.unit_price * x.qty).sum(), expr='"unit_price" * "qty"'))])
case('s02', S, 'easy', 'count', 'How many sales did we ring through in October?',
     f'SELECT COUNT(DISTINCT "receipt_no") AS receipts FROM "data" WHERE {bw(OCT)}',
     lambda d: one(receipts=int(between(d, 'date', OCT).receipt_no.nunique())))
sql, ref = shop_sum(NOV, lambda x: (x.line_total - x.line_cost).sum(), name='profit', expr='"line_total" - "line_cost"')
case('s03', S, 'medium', 'profit', "what's my profit so far this month", sql, ref)
case('s04', S, 'medium', 'margin', 'What margin am I making in each department?',
     'SELECT "department", ROUND(100.0 * (SUM("line_total") - SUM("line_cost")) / SUM("line_total"), 1) AS margin_pct FROM "data" GROUP BY 1 ORDER BY margin_pct DESC',
     lambda d: rows(d.groupby('department', as_index=False).agg(s=('line_total', 'sum'), c=('line_cost', 'sum')).assign(margin_pct=lambda x: (100 * (x.s - x.c) / x.s).map(r1))[['department', 'margin_pct']]))

def units_top(n):
    return (f'SELECT "product", SUM("qty") AS units FROM "data" GROUP BY 1 ORDER BY units DESC LIMIT {n}',
            lambda d, k=n: rows(top(d.groupby('product', as_index=False).qty.sum().rename(columns={'qty': 'units'}), 'units', k)))
sql, ref = units_top(10)
case('s05', S, 'easy', 'ranking', 'Which product sells the most units?', sql, ref, [('the top product only', *units_top(1))])
case('s06', S, 'easy', 'ranking', 'top 10 products by takings',
     'SELECT "product", ROUND(SUM("line_total"), 2) AS takings FROM "data" GROUP BY 1 ORDER BY takings DESC LIMIT 10',
     lambda d: rows(top(d.groupby('product', as_index=False).line_total.sum().rename(columns={'line_total': 'takings'}), 'takings', 10).assign(takings=lambda x: x.takings.map(r2))))

def staff_rank(n=None):
    lim = f' LIMIT {n}' if n else ''
    return (f'SELECT "staff", ROUND(SUM("line_total"), 2) AS takings FROM "data" WHERE {bw(YEAR)} GROUP BY 1 ORDER BY takings DESC{lim}',
            lambda d, k=n: rows(top(between(d, 'date', YEAR).groupby('staff', as_index=False).line_total.sum().rename(columns={'line_total': 'takings'}), 'takings', k or 99).assign(takings=lambda x: x.takings.map(r2))))
sql, ref = staff_rank()
case('s07', S, 'medium', 'ranking', "who's my best salesperson by takings this year?", sql, ref, [('the top person only', *staff_rank(1))])
sql, ref = shop_sum(OCT, lambda x: x.line_total.sum(), cond=" AND LOWER(\"payment_type\") = LOWER('Cash')", cond_fn=lambda x: x.payment_type == 'Cash')
case('s08', S, 'easy', 'filtered total', 'how much was paid in cash last month', sql, ref)
case('s09', S, 'medium', 'share', 'What percentage of my sales are paid by card?',
     'SELECT ROUND(100.0 * SUM(CASE WHEN "payment_type" = \'Card\' THEN "line_total" ELSE 0 END) / SUM("line_total"), 1) AS card_pct FROM "data"',
     lambda d: one(card_pct=r1(100 * d[d.payment_type == 'Card'].line_total.sum() / d.line_total.sum())),
     [('share of receipts', 'SELECT ROUND(100.0 * COUNT(DISTINCT CASE WHEN "payment_type" = \'Card\' THEN "receipt_no" END) / COUNT(DISTINCT "receipt_no"), 1) AS card_pct FROM "data"',
       lambda d: one(card_pct=r1(100 * d[d.payment_type == 'Card'].receipt_no.nunique() / d.receipt_no.nunique()))),
      ('both payment types', 'SELECT "payment_type", ROUND(100.0 * SUM("line_total") / SUM(SUM("line_total")) OVER (), 1) AS pct FROM "data" GROUP BY 1',
       lambda d: rows(d.groupby('payment_type', as_index=False).line_total.sum().assign(pct=lambda x: (100 * x.line_total / x.line_total.sum()).map(r1))[['payment_type', 'pct']]))])
case('s10', S, 'medium', 'average per receipt', "what's my average basket in pounds",
     'SELECT ROUND(SUM("line_total") / COUNT(DISTINCT "receipt_no"), 2) AS average_basket FROM "data"',
     lambda d: one(average_basket=r2(d.line_total.sum() / d.receipt_no.nunique())))
sql, ref = shop_sum(OCT, lambda x: x.discount.sum(), name='discounts', expr='"discount"')
case('s11', S, 'easy', 'period total', 'How much did I knock off in discounts in October?', sql, ref)
sql, ref = shop_sum(('2026-10-31', '2026-10-31'), lambda x: x.line_total.sum())
case('s12', S, 'easy', 'filtered total', 'How much did we take on Saturday?', sql, ref)

def quiet(measure_sql, fn, n=None):
    lim = f' LIMIT {n}' if n else ''
    def f(d, k=n):
        g = d.assign(weekday=pd.to_datetime(d.date).dt.day_name()).groupby('weekday').apply(fn, include_groups=False).rename('value').reset_index().sort_values('value')
        return rows((g.head(k) if k else g).assign(value=lambda x: x.value.map(r2)))
    return (f'SELECT DAYNAME({sql_d()}) AS weekday, {measure_sql} AS value FROM "data" GROUP BY 1 ORDER BY value ASC{lim}', f)
sql, ref = quiet('COUNT(DISTINCT "receipt_no")', lambda g: g.receipt_no.nunique())
case('s13', S, 'medium', 'day of week', 'which day of the week is the quietest', sql, ref,
     [('the quietest day only', *quiet('COUNT(DISTINCT "receipt_no")', lambda g: g.receipt_no.nunique(), 1)),
      ('by takings', *quiet('ROUND(SUM("line_total"), 2)', lambda g: g.line_total.sum())),
      ('by takings, quietest only', *quiet('ROUND(SUM("line_total"), 2)', lambda g: g.line_total.sum(), 1))])

def sep_oct(long=False):
    if not long:
        return (f"""SELECT "department", ROUND(SUM(CASE WHEN {bw(SEP)} THEN "line_total" ELSE 0 END), 2) AS september, ROUND(SUM(CASE WHEN {bw(OCT)} THEN "line_total" ELSE 0 END), 2) AS october FROM "data" GROUP BY 1 ORDER BY 1""",
                lambda d: rows(pd.DataFrame({'september': between(d, 'date', SEP).groupby('department').line_total.sum(), 'october': between(d, 'date', OCT).groupby('department').line_total.sum()}).fillna(0).reset_index().rename(columns={'index': 'department'}).assign(september=lambda x: x.september.map(r2), october=lambda x: x.october.map(r2))))
    return (f"""SELECT "department", STRFTIME(DATE_TRUNC('month', {sql_d()}), '%Y-%m-%d') AS month, ROUND(SUM("line_total"), 2) AS total FROM "data" WHERE {sql_d()} BETWEEN DATE '{SEP[0]}' AND DATE '{OCT[1]}' GROUP BY 1, 2 ORDER BY 1, 2""",
            lambda d: rows(between(d, 'date', (SEP[0], OCT[1])).assign(month=lambda x: x.date.str[:7] + '-01').groupby(['department', 'month'], as_index=False).line_total.sum().rename(columns={'line_total': 'total'}).assign(total=lambda x: x.total.map(r2))))
sql, ref = sep_oct()
case('s14', S, 'medium', 'period comparison', 'Compare September and October sales by department', sql, ref, [('one row per department and month', *sep_oct(True))])
case('s15', S, 'easy', 'filtered count', 'how many greeting cards did we sell in october',
     f'SELECT SUM("qty") AS units FROM "data" WHERE LOWER("product") = LOWER(\'Greeting Card\') AND {bw(OCT)}',
     lambda d: one(units=int(between(d[d['product'] == 'Greeting Card'], 'date', OCT).qty.sum())))
case('s16', S, 'medium', 'price', 'What price do scented candles actually sell for on average, after discounts?',
     'SELECT ROUND(SUM("line_total") / SUM("qty"), 2) AS average_price FROM "data" WHERE LOWER("product") = LOWER(\'Scented Candle\')',
     lambda d: one(average_price=r2(d[d['product'] == 'Scented Candle'].line_total.sum() / d[d['product'] == 'Scented Candle'].qty.sum())))
case('s17', S, 'medium', 'trend', 'Monthly sales and profit this year',
     f'SELECT STRFTIME(DATE_TRUNC(\'month\', {sql_d()}), \'%Y-%m-%d\') AS month, ROUND(SUM("line_total"), 2) AS sales, ROUND(SUM("line_total") - SUM("line_cost"), 2) AS profit FROM "data" WHERE {bw(YEAR)} GROUP BY 1 ORDER BY 1',
     lambda d: rows(between(d, 'date', YEAR).assign(month=lambda x: x.date.str[:7] + '-01').groupby('month', as_index=False).agg(sales=('line_total', 'sum'), cost=('line_cost', 'sum')).assign(profit=lambda x: (x.sales - x.cost).map(r2), sales=lambda x: x.sales.map(r2))[['month', 'sales', 'profit']]))
case('s18', S, 'medium', 'distribution', 'How many receipts had more than 3 items on them?',
     'SELECT COUNT(*) AS receipts FROM (SELECT "receipt_no" FROM "data" GROUP BY 1 HAVING SUM("qty") > 3) t',
     lambda d: one(receipts=int((d.groupby('receipt_no').qty.sum() > 3).sum())),
     [('more than 3 lines', 'SELECT COUNT(*) AS receipts FROM (SELECT "receipt_no" FROM "data" GROUP BY 1 HAVING COUNT(*) > 3) t',
       lambda d: one(receipts=int((d.groupby('receipt_no').size() > 3).sum())))])

def shop_hours(n=None):
    lim = f' ORDER BY takings DESC LIMIT {n}' if n else ' ORDER BY 1'
    def f(d, k=n):
        g = d.assign(hour=d.time.str.split(':').str[0].astype(int)).groupby('hour', as_index=False).line_total.sum().rename(columns={'line_total': 'takings'})
        g = top(g, 'takings', k) if k else g
        return rows(g.assign(takings=lambda x: x.takings.map(r2)))
    return (f'SELECT {hour()} AS hour, ROUND(SUM("line_total"), 2) AS takings FROM "data" GROUP BY 1{lim}', f)
sql, ref = shop_hours()
case('s19', S, 'medium', 'time of day', 'Which hour of the day do we take the most money?', sql, ref, [('the top hour only', *shop_hours(1))])
case('s20', S, 'hard', 'share', 'What share of my profit comes from each department?',
     'SELECT "department", ROUND(100.0 * SUM("line_total" - "line_cost") / SUM(SUM("line_total" - "line_cost")) OVER (), 1) AS profit_share_pct FROM "data" GROUP BY 1 ORDER BY profit_share_pct DESC',
     lambda d: rows(d.assign(p=d.line_total - d.line_cost).groupby('department', as_index=False).p.sum().assign(profit_share_pct=lambda x: (100 * x.p / x.p.sum()).map(r1))[['department', 'profit_share_pct']]))
sql, ref = shop_sum(OCT, lambda x: x.line_cost.sum(), name='cost_of_goods', expr='"line_cost"')
case('s21', S, 'easy', 'period total', 'What did the stock I sold last month cost me?', sql, ref)

def ben(wide=True):
    if wide:
        return (f"""SELECT ROUND(SUM(CASE WHEN {bw(WEEK)} THEN "line_total" ELSE 0 END), 2) AS last_week, ROUND(SUM(CASE WHEN {bw(PREV_WEEK)} THEN "line_total" ELSE 0 END), 2) AS week_before FROM "data" WHERE LOWER("staff") = LOWER('Ben')""",
                lambda d: one(last_week=r2(between(d[d.staff == 'Ben'], 'date', WEEK).line_total.sum()), week_before=r2(between(d[d.staff == 'Ben'], 'date', PREV_WEEK).line_total.sum())))
    return (f"""SELECT CASE WHEN {bw(WEEK)} THEN 'last week' ELSE 'week before' END AS period, ROUND(SUM("line_total"), 2) AS takings FROM "data" WHERE LOWER("staff") = LOWER('Ben') AND {sql_d()} BETWEEN DATE '{PREV_WEEK[0]}' AND DATE '{WEEK[1]}' GROUP BY 1""",
            lambda d: [{'period': 'last week', 'takings': r2(between(d[d.staff == 'Ben'], 'date', WEEK).line_total.sum())}, {'period': 'week before', 'takings': r2(between(d[d.staff == 'Ben'], 'date', PREV_WEEK).line_total.sum())}])
sql, ref = ben()
case('s22', S, 'medium', 'period comparison', 'How did Ben do last week compared with the week before?', sql, ref, [('as two rows', *ben(False))])

def biggest(n):
    return (f'SELECT "receipt_no", ROUND(SUM("line_total"), 2) AS total FROM "data" GROUP BY 1 ORDER BY total DESC LIMIT {n}',
            lambda d, k=n: rows(top(d.groupby('receipt_no', as_index=False).line_total.sum().rename(columns={'line_total': 'total'}), 'total', k).assign(total=lambda x: x.total.map(r2))))
sql, ref = biggest(10)
case('s23', S, 'easy', 'ranking', "what's the biggest single sale we've ever had", sql, ref, [('the biggest only', *biggest(1))])
case('s24', S, 'medium', 'average per day', 'On average how many customers do we serve a day in October?',
     f'SELECT ROUND(AVG(receipts), 1) AS average_per_day FROM (SELECT {sql_d()} AS day, COUNT(DISTINCT "receipt_no") AS receipts FROM "data" WHERE {bw(OCT)} GROUP BY 1) t',
     lambda d: one(average_per_day=r1(between(d, 'date', OCT).groupby('date').receipt_no.nunique().mean())),
     [('over all 31 days', f'SELECT ROUND(COUNT(DISTINCT "receipt_no") / 31.0, 1) AS average_per_day FROM "data" WHERE {bw(OCT)}',
       lambda d: one(average_per_day=r1(between(d, 'date', OCT).receipt_no.nunique() / 31)))])
case('s25', S, 'easy', 'breakdown', 'sales by payment type this week',
     f'SELECT "payment_type", ROUND(SUM("line_total"), 2) AS sales FROM "data" WHERE {bw(THIS_WEEK)} GROUP BY 1 ORDER BY 1',
     lambda d: rows(between(d, 'date', THIS_WEEK).groupby('payment_type', as_index=False).line_total.sum().rename(columns={'line_total': 'sales'}).assign(sales=lambda x: x.sales.map(r2))))

# ═══════════════════════════════ Online shop (Shopify orders export) ═══════════════════════════════
O = 'online'
obw = lambda span: f"{DAY_ONLINE} BETWEEN DATE '{span[0]}' AND DATE '{span[1]}'"
def oday(d):
    return d.paid_at.str[:10]
def ob(d, span):
    return d[(oday(d) >= span[0]) & (oday(d) <= span[1])]
def orders_only(d):
    return d.dropna(subset=['total'])

case('o01', O, 'easy', 'count', 'How many orders did we get last month?',
     f'SELECT COUNT(DISTINCT "name") AS orders FROM "data" WHERE {obw(OCT)}',
     lambda d: one(orders=int(ob(d, OCT)['name'].nunique())))

def orev(expr, fn, span=OCT, name='revenue', cond='', cond_fn=None):
    sql = f'SELECT ROUND(SUM({expr}), 2) AS {name} FROM "data" WHERE {obw(span)}{cond}'
    def f(d):
        x = ob(d, span)
        if cond_fn is not None: x = x[cond_fn(x)]
        return one(**{name: r2(fn(x))})
    return sql, f
sql, ref = orev('"total"', lambda x: x.total.sum())
case('o02', O, 'easy', 'period total', 'total revenue last month', sql, ref,
     [('subtotal (before shipping)', *orev('"subtotal"', lambda x: x.subtotal.sum())),
      ('after refunds', *orev('"total" - "refunded_amount"', lambda x: (x.total - x.refunded_amount).sum())),
      ('product sales (price × quantity)', *orev('"lineitem_price" * "lineitem_quantity"', lambda x: (x.lineitem_price * x.lineitem_quantity).sum())),
      ('paid orders only', *orev('"total"', lambda x: x.total.sum(), cond=" AND \"financial_status\" = 'Paid'", cond_fn=lambda x: x.financial_status == 'Paid'))])

def aov(expr, fn, cond='', cond_fn=None):
    sql = f'SELECT ROUND(SUM({expr}) / COUNT(DISTINCT "name"), 2) AS average_order_value FROM "data"{(" WHERE " + cond) if cond else ""}'
    def f(d):
        x = d if cond_fn is None else d[cond_fn(d)]
        return one(average_order_value=r2(fn(x) / x['name'].nunique()))
    return sql, f
sql, ref = aov('"total"', lambda x: x.total.sum())
case('o03', O, 'medium', 'average per order', "what's our average order value", sql, ref,
     [('subtotal (before shipping)', *aov('"subtotal"', lambda x: x.subtotal.sum())),
      ('paid orders only', *aov('"total"', lambda x: x.total.sum(), "\"financial_status\" = 'Paid'", lambda x: x.financial_status == 'Paid')),
      ('after refunds', *aov('"total" - COALESCE("refunded_amount", 0)', lambda x: x.total.sum() - x.refunded_amount.sum()))])

def prod_rank(expr, fn, n=10, name='units'):
    return (f'SELECT "lineitem_name", ROUND(SUM({expr}), 2) AS {name} FROM "data" GROUP BY 1 ORDER BY {name} DESC LIMIT {n}',
            lambda d, k=n: rows(top(d.assign(v=fn(d)).groupby('lineitem_name', as_index=False).v.sum().rename(columns={'v': name}), name, k).assign(**{name: lambda x: x[name].map(r2)})))
sql, ref = prod_rank('"lineitem_quantity"', lambda d: d.lineitem_quantity)
case('o04', O, 'medium', 'ranking', 'which product sells the most', sql, ref,
     [('the top product only', *prod_rank('"lineitem_quantity"', lambda d: d.lineitem_quantity, 1)),
      ('by revenue', *prod_rank('"lineitem_price" * "lineitem_quantity"', lambda d: d.lineitem_price * d.lineitem_quantity, 10, 'revenue')),
      ('by revenue, top only', *prod_rank('"lineitem_price" * "lineitem_quantity"', lambda d: d.lineitem_price * d.lineitem_quantity, 1, 'revenue'))])
case('o05', O, 'medium', 'breakdown', 'Revenue by product this year',
     f'SELECT "lineitem_name", ROUND(SUM("lineitem_price" * "lineitem_quantity"), 2) AS revenue FROM "data" WHERE {obw(YEAR)} GROUP BY 1 ORDER BY revenue DESC',
     lambda d: rows(ob(d, YEAR).assign(v=lambda x: x.lineitem_price * x.lineitem_quantity).groupby('lineitem_name', as_index=False).v.sum().rename(columns={'v': 'revenue'}).sort_values('revenue', ascending=False).assign(revenue=lambda x: x.revenue.map(r2))))
case('o06', O, 'easy', 'filtered count', 'How many orders used a discount code?',
     'SELECT COUNT(DISTINCT "name") AS orders FROM "data" WHERE "discount_code" <> \'None\'',
     lambda d: one(orders=int(d[d.discount_code != 'None']['name'].nunique())))

def code_rev(n=10):
    return (f'SELECT "discount_code", ROUND(SUM("total"), 2) AS revenue FROM "data" WHERE "discount_code" <> \'None\' GROUP BY 1 ORDER BY revenue DESC LIMIT {n}',
            lambda d, k=n: rows(top(d[d.discount_code != 'None'].groupby('discount_code', as_index=False).total.sum().rename(columns={'total': 'revenue'}), 'revenue', k).assign(revenue=lambda x: x.revenue.map(r2))))
sql, ref = code_rev()
case('o07', O, 'medium', 'ranking', 'Which discount code brought in the most revenue?', sql, ref, [('the top code only', *code_rev(1))])

def refunds_year(by_status):
    cond = "\"financial_status\" = 'Refunded'" if by_status else '"refunded_amount" > 0'
    def f(d, s=by_status):
        x = ob(d, YEAR); x = x[(x.financial_status == 'Refunded') if s else (x.refunded_amount > 0)]
        return one(refunds=int(x['name'].nunique()), refunded=r2(x.refunded_amount.sum()))
    return (f'SELECT COUNT(DISTINCT "name") AS refunds, ROUND(SUM("refunded_amount"), 2) AS refunded FROM "data" WHERE {obw(YEAR)} AND {cond}', f)
sql, ref = refunds_year(True)
case('o08', O, 'medium', 'filtered total', 'How many refunds have we had this year and how much did we give back?', sql, ref, [('orders with a refunded amount', *refunds_year(False))])
case('o09', O, 'medium', 'rate', "what's our refund rate",
     'SELECT ROUND(100.0 * COUNT(DISTINCT CASE WHEN "financial_status" = \'Refunded\' THEN "name" END) / COUNT(DISTINCT "name"), 1) AS refund_rate_pct FROM "data"',
     lambda d: one(refund_rate_pct=r1(100 * d[d.financial_status == 'Refunded']['name'].nunique() / d['name'].nunique())),
     [('share of revenue refunded', 'SELECT ROUND(100.0 * SUM("refunded_amount") / SUM("total"), 1) AS refund_rate_pct FROM "data"',
       lambda d: one(refund_rate_pct=r1(100 * d.refunded_amount.sum() / d.total.sum())))])
case('o10', O, 'medium', 'repeat customers', 'How many customers have ordered more than once?',
     'SELECT COUNT(*) AS repeat_customers FROM (SELECT "email" FROM "data" WHERE "email" IS NOT NULL GROUP BY 1 HAVING COUNT(DISTINCT "name") > 1) t',
     lambda d: one(repeat_customers=int((d.dropna(subset=['email']).groupby('email')['name'].nunique() > 1).sum())))
case('o11', O, 'medium', 'share', 'What share of our orders come from outside the UK?',
     'SELECT ROUND(100.0 * COUNT(DISTINCT CASE WHEN "billing_country" <> \'GB\' THEN "name" END) / COUNT(DISTINCT "name"), 1) AS outside_uk_pct FROM "data"',
     lambda d: one(outside_uk_pct=r1(100 * d[d.billing_country != 'GB']['name'].nunique() / d['name'].nunique())),
     [('share of revenue', 'SELECT ROUND(100.0 * SUM(CASE WHEN "billing_country" <> \'GB\' THEN "total" ELSE 0 END) / SUM("total"), 1) AS outside_uk_pct FROM "data"',
       lambda d: one(outside_uk_pct=r1(100 * d[d.billing_country != 'GB'].total.sum() / d.total.sum())))])
case('o12', O, 'easy', 'breakdown', 'sales by country',
     'SELECT "billing_country", ROUND(SUM("total"), 2) AS sales FROM "data" GROUP BY 1 ORDER BY sales DESC',
     lambda d: rows(d.groupby('billing_country', as_index=False).total.sum().rename(columns={'total': 'sales'}).sort_values('sales', ascending=False).assign(sales=lambda x: x.sales.map(r2))),
     [('product sales (price × quantity)', 'SELECT "billing_country", ROUND(SUM("lineitem_price" * "lineitem_quantity"), 2) AS sales FROM "data" GROUP BY 1 ORDER BY sales DESC',
       lambda d: rows(d.assign(v=d.lineitem_price * d.lineitem_quantity).groupby('billing_country', as_index=False).v.sum().rename(columns={'v': 'sales'}).sort_values('sales', ascending=False).assign(sales=lambda x: x.sales.map(r2))))])

def omonthly(n=None, order='1'):
    lim = f' ORDER BY revenue DESC LIMIT {n}' if n else ' ORDER BY 1'
    def f(d, k=n):
        g = d.assign(month=oday(d).str[:7] + '-01').groupby('month', as_index=False).total.sum().rename(columns={'total': 'revenue'})
        g = top(g, 'revenue', k) if k else g
        return rows(g.assign(revenue=lambda x: x.revenue.map(r2)))
    return (f'SELECT STRFTIME(DATE_TRUNC(\'month\', {DAY_ONLINE}), \'%Y-%m-%d\') AS month, ROUND(SUM("total"), 2) AS revenue FROM "data" GROUP BY 1{lim}', f)
sql, ref = omonthly()
case('o13', O, 'medium', 'trend', 'Monthly revenue for the last 12 months', sql, ref)
sql, ref = orev('"shipping"', lambda x: x.shipping.sum(), name='shipping')
case('o14', O, 'easy', 'period total', 'How much did customers pay for shipping last month?', sql, ref)
sql, ref = omonthly(10)
case('o15', O, 'easy', 'ranking', "what's been our best month", sql, ref, [('the best month only', *omonthly(1))])
case('o16', O, 'medium', 'average per order', 'Average number of items per order?',
     'SELECT ROUND(SUM("lineitem_quantity") * 1.0 / COUNT(DISTINCT "name"), 2) AS items_per_order FROM "data"',
     lambda d: one(items_per_order=r2(d.lineitem_quantity.sum() / d['name'].nunique())))

def city_aov(n):
    def f(d, k=n):
        g = d.groupby('billing_city').agg(t=('total', 'sum'), o=('name', 'nunique')).reset_index()
        g['average_order_value'] = g.t / g.o
        return rows(top(g, 'average_order_value', k)[['billing_city', 'average_order_value']].assign(average_order_value=lambda x: x.average_order_value.map(r2)))
    return (f'SELECT "billing_city", ROUND(SUM("total") / COUNT(DISTINCT "name"), 2) AS average_order_value FROM "data" GROUP BY 1 ORDER BY average_order_value DESC LIMIT {n}', f)
sql, ref = city_aov(10)
case('o17', O, 'hard', 'ranking', 'Which city has the highest average order value?', sql, ref, [('the top city only', *city_aov(1))])
case('o18', O, 'easy', 'filtered count', 'how many hoodies did we sell in october',
     f'SELECT SUM("lineitem_quantity") AS units FROM "data" WHERE "lineitem_name" ILIKE \'%hoodie%\' AND {obw(OCT)}',
     lambda d: one(units=int(ob(d[d.lineitem_name.str.lower().str.contains('hoodie')], OCT).lineitem_quantity.sum())))

def repeat_share():
    def f(d):
        n = d.dropna(subset=['email']).groupby('email')['name'].nunique()
        rep = set(n[n > 1].index)
        return one(repeat_revenue_pct=r1(100 * d[d.email.isin(rep)].total.sum() / d.total.sum()))
    return ('SELECT ROUND(100.0 * SUM(CASE WHEN "email" IN (SELECT "email" FROM "data" GROUP BY 1 HAVING COUNT(DISTINCT "name") > 1) THEN "total" ELSE 0 END) / SUM("total"), 1) AS repeat_revenue_pct FROM "data"', f)
sql, ref = repeat_share()
case('o19', O, 'hard', 'repeat customers', 'What percentage of revenue comes from repeat customers?', sql, ref)
sql, ref = orev('"refunded_amount"', lambda x: x.refunded_amount.sum(), name='refunded')
case('o20', O, 'easy', 'period total', 'How much did we refund last month?', sql, ref)

def owd(n=None):
    lim = f' LIMIT {n}' if n else ''
    def f(d, k=n):
        g = d.assign(weekday=pd.to_datetime(oday(d)).dt.day_name()).groupby('weekday', as_index=False)['name'].nunique().rename(columns={'name': 'orders'}).sort_values('orders', ascending=False)
        return rows(g.head(k) if k else g)
    return (f'SELECT DAYNAME({DAY_ONLINE}) AS weekday, COUNT(DISTINCT "name") AS orders FROM "data" GROUP BY 1 ORDER BY orders DESC{lim}', f)
sql, ref = owd()
case('o21', O, 'medium', 'day of week', 'Which day of the week do we get the most orders?', sql, ref, [('the top day only', *owd(1))])

def new_customers():
    def f(d):
        first = d.dropna(subset=['email']).assign(day=lambda x: oday(x)).groupby('email').day.min()
        return one(new_customers=int(((first >= OCT[0]) & (first <= OCT[1])).sum()))
    return (f"""SELECT COUNT(*) AS new_customers FROM (SELECT "email", MIN({DAY_ONLINE}) AS first_order FROM "data" WHERE "email" IS NOT NULL GROUP BY 1) t WHERE first_order BETWEEN DATE '{OCT[0]}' AND DATE '{OCT[1]}'""", f)
sql, ref = new_customers()
case('o22', O, 'hard', 'new customers', 'How many new customers did we get last month?', sql, ref)
case('o23', O, 'medium', 'average', "what's the average discount when someone uses a code",
     'SELECT ROUND(AVG("discount_amount"), 2) AS average_discount FROM "data" WHERE "discount_code" <> \'None\' AND "discount_amount" IS NOT NULL',
     lambda d: one(average_discount=r2(d[(d.discount_code != 'None')].dropna(subset=['discount_amount']).discount_amount.mean())))
case('o24', O, 'medium', 'breakdown', 'Revenue by product type last month',
     f'SELECT "product_type", ROUND(SUM("lineitem_price" * "lineitem_quantity"), 2) AS revenue FROM "data" WHERE {obw(OCT)} GROUP BY 1 ORDER BY revenue DESC',
     lambda d: rows(ob(d, OCT).assign(v=lambda x: x.lineitem_price * x.lineitem_quantity).groupby('product_type', as_index=False).v.sum().rename(columns={'v': 'revenue'}).sort_values('revenue', ascending=False).assign(revenue=lambda x: x.revenue.map(r2))))
sql, ref = orev('"total"', lambda x: x.total.sum(), span=('2025-11-28', '2025-11-28'))
case('o25', O, 'easy', 'filtered total', 'What did we make on Black Friday last year?', sql, ref,
     [('product sales (price × quantity)', *orev('"lineitem_price" * "lineitem_quantity"', lambda x: (x.lineitem_price * x.lineitem_quantity).sum(), span=('2025-11-28', '2025-11-28')))])
