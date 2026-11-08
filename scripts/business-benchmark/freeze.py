import json, sqlite3, statistics, re
from questions import Q, DUCK_ONLY
dbs = {}
for key in ['retail', 'weekly', 'appointments', 'employees']:
    ds = json.load(open(f'ds_{key}.json'))
    cols = [c['name'] for c in ds['columns']]
    con = sqlite3.connect(':memory:')
    con.execute('CREATE TABLE data (' + ', '.join(f'"{c}"' for c in cols) + ')')
    con.executemany('INSERT INTO data VALUES (' + ','.join('?' * len(cols)) + ')', [[r.get(c) for c in cols] for r in ds['rows']])
    bools = {c['name'] for c in ds['columns'] if all(isinstance(r.get(c['name']), bool) for r in ds['rows'][:200])}
    dbs[key] = (con, ds, bools)
out = {}
for qid, key, diff, cat, question, sql in Q:
    con, ds, bools = dbs[key]
    if sql is None:
        sal = sorted(r['salary'] for r in ds['rows']); rows = [{'median_salary': statistics.median(sal)}]
        sql = DUCK_ONLY[qid]
    else:
        cur = con.execute(sql); names = [d[0] for d in cur.description]
        rows = [dict(zip(names, r)) for r in cur.fetchall()]
        for r in rows:
            for k in r:
                if k in bools: r[k] = bool(r[k])
    # tie check for LIMIT queries: rerun without LIMIT and show the next value
    note = ''
    m = re.search(r'ORDER BY (.+?) (DESC|ASC) LIMIT (\d+)$', sql)
    if m:
        n = int(m.group(3)); base = sql[:m.start()]
        ks = [r[0] for r in con.execute(f'SELECT __k FROM (SELECT *, {m.group(1)} AS __k FROM ({base}) z) y ORDER BY __k {m.group(2)} LIMIT {n + 1}').fetchall()] if False else None
        try:
            wrapped = re.sub(r'^SELECT (.+?) FROM', lambda mm: f'SELECT {mm.group(1)}, {m.group(1)} AS __k FROM', base, count=1)
            ks = [r[-1] for r in con.execute(wrapped + f' ORDER BY {m.group(1)} {m.group(2)} LIMIT {n + 1}').fetchall()]
        except Exception:
            ks = [r[-1] for r in con.execute(base + f' ORDER BY {m.group(1)} {m.group(2)} LIMIT {n + 1}').fetchall()]
        if len(ks) > n and ks[n - 1] == ks[n]: note = '  !! TIE'
        else: note = f'  (gap {ks[n-1]} vs {ks[n] if len(ks) > n else "-"})'
    out[qid] = rows
    print(qid, json.dumps(rows)[:150], note)
json.dump(out, open('expected.json', 'w'))
