import json, sqlite3, math, gzip, hashlib
from collections import defaultdict,Counter
from datetime import datetime,timedelta
from audit import OUT,SOURCE,ROOT,execute,equivalent

data=json.loads((OUT/'audit-evidence.json').read_text(encoding='utf8'))
checks=json.loads((OUT/'independent-checks.json').read_text(encoding='utf8'))
cases={c['id']:c for c in data['cases']}
def db_for(c):
    fam,_,name=c['sourceId'].split(':')
    p=SOURCE/(f'spider2/databases/{name}.sqlite' if fam.startswith('spider') else f'bird/dev_20240627/dev_databases/dev_databases/{name}/{name}.sqlite')
    return sqlite3.connect(p.as_uri()+'?mode=ro',uri=True)
def record(key,rows,method,sql=None,error=None):
    c=cases[key]; result={'caseId':key,'purpose':method,'rows':rows,'error':error,'sql':sql,
        'matchesOriginalFrozenByPositionalValues':equivalent(rows,c['expectedRows'])}
    if c.get('referenceResult'):
        result['matchingPublishedAlternatives']=[a['source'] for a in c['referenceResult']['alternatives'] if equivalent(rows,a['rows'])]
    checks.append(result)
    print(key,'n',len(rows or []),'first',str((rows or [])[:1])[:230],'error',error,'matches',result.get('matchingPublishedAlternatives',result['matchesOriginalFrozenByPositionalValues']),flush=True)
def run(key,sql,method):
    with db_for(cases[key]) as db:rows,error=execute(db,sql)
    record(key,rows,method,sql,error); return rows

run('holdout-bird-dev-0311',"SELECT COUNT(*) FROM molecule WHERE molecule_id NOT IN (SELECT molecule_id FROM atom WHERE element='s') AND molecule_id NOT IN (SELECT molecule_id FROM bond WHERE bond_type='=')",'Set-based anti-existence equivalent avoids slow correlated scan; source keys are non-null')
run('holdout-spider2-local198',"WITH totals AS (SELECT c.Country,SUM(i.Total) v FROM customers c JOIN invoices i ON i.CustomerId=c.CustomerId WHERE c.Country IN (SELECT Country FROM customers GROUP BY Country HAVING COUNT(*)>4) GROUP BY c.Country), numbered AS (SELECT v,ROW_NUMBER() OVER(ORDER BY v) rn,COUNT(*) OVER() n FROM totals) SELECT AVG(v) FROM numbered WHERE rn IN ((n+1)/2,(n+2)/2)",'Independent country revenue median, correct source plural table names')
run('holdout-spider2-local054',"WITH sales AS (SELECT a.ArtistId,a.Name,i.CustomerId,SUM(x.UnitPrice*x.Quantity) spent FROM artists a JOIN albums b ON b.ArtistId=a.ArtistId JOIN tracks t ON t.AlbumId=b.AlbumId JOIN invoice_items x ON x.TrackId=t.TrackId JOIN invoices i ON i.InvoiceId=x.InvoiceId GROUP BY a.ArtistId,a.Name,i.CustomerId), best AS (SELECT ArtistId FROM sales GROUP BY ArtistId,Name ORDER BY SUM(spent) DESC,Name LIMIT 1) SELECT c.FirstName,s.spent FROM sales s JOIN customers c ON c.CustomerId=s.CustomerId WHERE s.ArtistId IN (SELECT ArtistId FROM best) AND s.spent<1",'Independent best artist by total revenue; customers with positive purchases under1')
run('holdout-spider2-local055',"WITH sales AS (SELECT a.ArtistId,a.Name,i.CustomerId,SUM(x.UnitPrice*x.Quantity) spent FROM artists a JOIN albums b ON b.ArtistId=a.ArtistId JOIN tracks t ON t.AlbumId=b.AlbumId JOIN invoice_items x ON x.TrackId=t.TrackId JOIN invoices i ON i.InvoiceId=x.InvoiceId GROUP BY a.ArtistId,a.Name,i.CustomerId), totals AS (SELECT ArtistId,Name,SUM(spent) total,AVG(spent) average FROM sales GROUP BY ArtistId,Name) SELECT ABS((SELECT average FROM totals ORDER BY total DESC,Name LIMIT 1)-(SELECT average FROM totals ORDER BY total ASC,Name LIMIT 1))",'Independent top/bottom revenue-selling artists among artists with purchases; alphabetical ties')

with db_for(cases['holdout-spider2-local009']) as db:
    airports={a[0]:(json.loads(a[1])['en'],tuple(map(float,a[2].strip('()').split(',')))) for a in db.execute('SELECT airport_code,city,coordinates FROM airports_data')}
    distances=defaultdict(list)
    for dep,arr in db.execute('SELECT departure_airport,arrival_airport FROM flights'):
        c1,(lon1,lat1)=airports[dep];c2,(lon2,lat2)=airports[arr]
        a1,a2,dlat,dlon=map(math.radians,(lat1,lat2,lat2-lat1,lon2-lon1))
        h=math.sin(dlat/2)**2+math.cos(a1)*math.cos(a2)*math.sin(dlon/2)**2
        distances[tuple(sorted((c1,c2)))].append(2*6371*math.asin(math.sqrt(min(1,max(0,h)))))
    averages={k:sum(v)/len(v) for k,v in distances.items()}
    record('holdout-spider2-local009',[{'km':max(v for k,v in averages.items() if 'Abakan' in k)}],'Python Haversine r6371; mean flight distance per undirected city pair')
    buckets=Counter(min(int(v//1000),6) for v in averages.values())
    record('holdout-spider2-local010',[{'pairs':min(buckets.values())}],'Independent mean-route distance buckets; minimum among populated bins: '+str(dict(buckets)))

# Reconstruct daily balances without SQL/window reuse; clip only the displayed balance.
with db_for(cases['holdout-spider2-local300']) as db:
    daily=defaultdict(lambda:defaultdict(int))
    for customer,date,kind,value in db.execute('SELECT customer_id,txn_date,txn_type,txn_amount FROM customer_transactions'):
        daily[customer][datetime.fromisoformat(date).date()]+=value if kind=='deposit' else -value
    totals=Counter()
    for dates in daily.values():
        current=min(dates);last=max(dates);balance=0;maxima=defaultdict(int)
        while current<=last:
            balance+=dates.get(current,0);month=current.strftime('%Y-%m-01')
            maxima[month]=max(maxima[month],max(0,balance));current+=timedelta(days=1)
        totals.update(maxima)
    record('holdout-spider2-local300',[{'month':m,'total_monthly_max_balances':v} for m,v in sorted(totals.items())], 'Independent per-customer daily running balance over own earliest/latest dates; floor displayed daily balance then sum monthly maxima. Original projected gold checks only month.')

run('holdout-spider2-local197',"WITH monthly AS (SELECT customer_id,strftime('%Y-%m',payment_date) ym,SUM(amount) v FROM payment GROUP BY customer_id,ym), top10 AS (SELECT customer_id FROM payment GROUP BY customer_id ORDER BY SUM(amount) DESC LIMIT 10) SELECT a.customer_id,a.ym,ROUND(ABS(a.v-b.v),2) difference FROM monthly a JOIN monthly b ON a.customer_id=b.customer_id AND date(a.ym||'-01')=date(b.ym||'-01','+1 month') WHERE a.customer_id IN (SELECT customer_id FROM top10) ORDER BY ABS(a.v-b.v) DESC LIMIT 1",'Independent exact consecutive-calendar-month comparison; retain required customer and month')
run('holdout-spider2-local331',"WITH r AS (SELECT session,path,LAG(path,1) OVER(PARTITION BY session ORDER BY stamp) p1,LAG(path,2) OVER(PARTITION BY session ORDER BY stamp) p2 FROM activity_log) SELECT path,COUNT(*) n FROM r WHERE p1='/detail' AND p2='/detail' GROUP BY path ORDER BY n DESC,path LIMIT 3",'Exact /detail paths, within session, stable alphabetical tie-break (tie rule not in question)')

# Persist the generated-column corruption diagnosis, including a concrete raw row.
c=cases['holdout-spider2-local309']
with db_for(c) as db:
    cur=db.execute('SELECT * FROM drivers WHERE driver_id=1');cols=[x[0] for x in cur.description]; native=dict(zip(cols,cur.fetchone()))
    table_info=[x[1] for x in db.execute('PRAGMA table_info(drivers)')]
    xinfo=[{'name':x[1],'hidden':x[6]} for x in db.execute('PRAGMA table_xinfo(drivers)')]
asset=json.loads(gzip.decompress((ROOT/'public'/c['datasetRef'].lstrip('/')).read_bytes()))
frozen=next(r for t in asset['relatedTables'] if t['name']=='drivers' for r in t['rows'] if r['driver_id']==1)
checks.append({'caseId':c['id'],'purpose':'Confirmed importer field shift', 'alsoAffects':['holdout-spider2-local310','holdout-spider2-local311'],
    'sourceRow':native,'fixtureRow':frozen,'pragmaTableInfoNames':table_info,'selectStarNames':cols,'pragmaTableXinfo':xinfo,
    'cause':'build-research-benchmark-packs.py lines229-237 zips PRAGMA table_info names with SELECT* row positions. Generated columns are omitted from table_info but present in SELECT*.'})

# Reconcile comparisons with all reference alternatives after independent calculations.
for check in checks:
    c=cases[check['caseId']]
    if c.get('referenceResult') and check.get('rows') is not None:
        check['matchingPublishedAlternatives']=[r['source'] for r in c['referenceResult']['alternatives'] if equivalent(check['rows'],r['rows'])]
(OUT/'independent-checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2),encoding='utf8')
