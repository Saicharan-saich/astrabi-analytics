"""Work out every frozen answer with pandas (not SQL) from the cleaned datasets.

The datasets are read the way the app loads them into DuckDB: blank text is a blank (None),
numbers are numbers. Writes expected.json: {case id: {"rows": [...], "alts": [[...], ...]}}.
"""
import json, sys
import pandas as pd
from questions import Q

dfs = {}
for key in ['cafe', 'shop', 'online']:
    ds = json.load(open(f'ds_{key}.json'))
    df = pd.DataFrame(ds['rows'])
    for c in df.columns:
        if df[c].dtype == object or str(df[c].dtype) in ('str', 'string'):
            df[c] = df[c].map(lambda v: None if v is None or (isinstance(v, str) and v.strip() == '') else v)
    dfs[key] = df

out, problems = {}, []
for c in Q:
    d = dfs[c['ds']]
    main = c['ref'](d)
    alts = [ref(d) for _reading, _sql, ref in c['alts']]
    for label, r in [('main', main)] + [(a[0], x) for a, x in zip(c['alts'], alts)]:
        if not r:
            problems.append(f"{c['id']} {label}: no rows")
        if any(v is None for row in r for v in row.values()) and label == 'main':
            problems.append(f"{c['id']} {label}: blank value {r[:2]}")
    # Two readings that give the same answer are one reading.
    seen = [json.dumps(main, sort_keys=True)]
    for (reading, _s, _r), a in zip(c['alts'], alts):
        key = json.dumps(a, sort_keys=True)
        if key in seen:
            problems.append(f"{c['id']}: reading '{reading}' gives the same answer as another")
        seen.append(key)
    out[c['id']] = {'rows': main, 'alts': alts}
    print(c['id'], json.dumps(main)[:140])
json.dump(out, open('expected.json', 'w'))
print('\n'.join(problems) or 'no problems')
