"""Independent read-only checks. Proposed interpretations, not replacement gold."""
import csv, gzip, json, math, sqlite3
from collections import Counter, defaultdict
from datetime import datetime
from audit import ROOT, SOURCE, OUT, execute, equivalent, canonical

evidence=json.loads((OUT/'audit-evidence.json').read_text(encoding='utf8'))
cases={c['id']:c for c in evidence['cases']}
checks=[]

def connect(db, spider=False):
    path=SOURCE/(f'spider2/databases/{db}.sqlite' if spider else f'bird/dev_20240627/dev_databases/dev_databases/{db}/{db}.sqlite')
    return sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)

def run(index, sql, purpose='Independent question-aligned interpretation; not a gold replacement', spider=False):
    key=f'holdout-spider2-local{index:03}' if spider else f'holdout-bird-dev-{index:04}'
    case=cases[key]
    with connect(case['sourceId'].split(':')[2],spider) as db: rows,error=execute(db,sql)
    checks.append({'caseId':key,'purpose':purpose,'sql':sql,'rows':rows,'error':error,
                   'matchesOriginalFrozenByPositionalValues':equivalent(rows,case['expectedRows'])})
    print(key, json.dumps(rows[:3] if rows else rows,ensure_ascii=False),f'({len(rows or [])} rows)',error or '',flush=True)
    return rows

def custom(index,rows,purpose,method):
    key=f'holdout-spider2-local{index:03}'
    checks.append({'caseId':key,'purpose':purpose,'method':method,'rows':rows,'error':None,
        'matchesOriginalFrozenByPositionalValues':equivalent(rows,cases[key]['expectedRows'])})
    print(key,json.dumps(rows[:3],ensure_ascii=False),f'({len(rows)} rows)',flush=True)

run(16,cases['holdout-bird-dev-0016']['goldSql'].replace("'Lake'","'Alameda'"))
run(88,"SELECT s.School, t.sname,t.NumGE1500,s.Phone FROM satscores t JOIN schools s ON t.cds=s.CDSCode ORDER BY t.NumGE1500 DESC LIMIT 4",'Inspect whether winning SAT row is school or district aggregate')
for n in [7,44,88]:
    sql=cases[f'holdout-bird-dev-{n:04}']['goldSql'].replace('ORDER BY', 'WHERE T2.School IS NOT NULL ORDER BY')
    run(n,sql,'Rank named schools only; compare source district aggregate winner')
run(109,"SELECT COUNT(DISTINCT c.client_id) FROM client c JOIN disp d ON d.client_id=c.client_id JOIN account a ON a.account_id=d.account_id JOIN district b ON b.district_id=a.district_id WHERE c.gender='F' AND b.A2='Jesenik'",'Use actual account branch, not residential district')
run(112,"SELECT DISTINCT b.A2 FROM client c JOIN disp d ON d.client_id=c.client_id JOIN account a ON a.account_id=d.account_id JOIN district b ON b.district_id=a.district_id WHERE c.gender='F' AND c.birth_date='1976-01-29'",'Actual account opening district')
run(130,"SELECT COUNT(DISTINCT c.client_id) FROM client c JOIN district b ON b.district_id=c.district_id WHERE b.A3='south Bohemia' AND EXISTS(SELECT 1 FROM disp d WHERE d.client_id=c.client_id AND d.type='OWNER') AND NOT EXISTS(SELECT 1 FROM disp d JOIN card k ON k.disp_id=d.disp_id WHERE d.client_id=c.client_id)", 'Account owners with no credit card; residence scope retained to isolate ownership error')
run(197,"SELECT AVG(n) FROM (SELECT m.molecule_id,COUNT(a.atom_id) n FROM molecule m LEFT JOIN atom a ON a.molecule_id=m.molecule_id AND a.element='o' WHERE EXISTS(SELECT 1 FROM bond b WHERE b.molecule_id=m.molecule_id AND b.bond_type='-') GROUP BY m.molecule_id)")
run(198,"SELECT AVG(n) FROM (SELECT m.molecule_id,COUNT(b.bond_id) n FROM molecule m JOIN bond b ON b.molecule_id=m.molecule_id WHERE m.label='+' AND b.bond_type='-' GROUP BY m.molecule_id)",'Average single-bond count per carcinogenic molecule having a single bond; removes atom fan-out')
run(207,"SELECT DISTINCT a.element FROM atom a JOIN connected c ON c.atom_id=a.atom_id JOIN bond b ON b.bond_id=c.bond_id WHERE b.bond_type='='")
run(214,"SELECT DISTINCT label FROM molecule EXCEPT SELECT m.label FROM molecule m JOIN atom a ON a.molecule_id=m.molecule_id WHERE a.element='sn'",'Labels absent from all tin-containing molecules')
run(218,"SELECT 100.0*SUM(NOT EXISTS(SELECT 1 FROM atom a WHERE a.molecule_id=m.molecule_id AND a.element='f'))/COUNT(*) FROM molecule m WHERE label='+'").__class__
run(234,"SELECT COUNT(DISTINCT bond_id) FROM connected WHERE atom_id='TR009_12' OR atom_id2='TR009_12'")
run(245,"SELECT COUNT(c.bond_id)*1.0/COUNT(DISTINCT a.atom_id) FROM atom a LEFT JOIN connected c ON c.atom_id=a.atom_id WHERE a.element='i'")
run(247,"SELECT DISTINCT a.element FROM atom a WHERE NOT EXISTS(SELECT 1 FROM connected c WHERE c.atom_id=a.atom_id OR c.atom_id2=a.atom_id)")
run(254,"WITH pairs AS (SELECT DISTINCT c.bond_id,MIN(a.element,b.element) x,MAX(a.element,b.element) y FROM connected c JOIN atom a ON a.atom_id=c.atom_id JOIN atom b ON b.atom_id=c.atom_id2), counts AS (SELECT x,y,COUNT(*) n FROM pairs GROUP BY x,y) SELECT MAX(n)*100.0/(SELECT COUNT(*) FROM bond) percentage FROM counts")
run(263,"SELECT SUM(a.element='cl')*100.0/COUNT(*) FROM atom a WHERE EXISTS(SELECT 1 FROM bond b WHERE b.molecule_id=a.molecule_id AND b.bond_type='-')")
run(269,"SELECT COUNT(DISTINCT c.bond_id) FROM atom a JOIN connected c ON c.atom_id=a.atom_id WHERE a.element='i'")
run(286,"SELECT SUM(EXISTS(SELECT 1 FROM bond b WHERE b.molecule_id=m.molecule_id AND b.bond_type='#'))*100.0/COUNT(*) FROM molecule m")
run(298,"SELECT SUM(m.label='+' AND EXISTS(SELECT 1 FROM atom a WHERE a.molecule_id=m.molecule_id AND a.element='h'))*100.0/COUNT(*) FROM molecule m",'Molecule share of all molecules that are carcinogenic and contain hydrogen')
run(311,"SELECT COUNT(*) FROM molecule m WHERE NOT EXISTS(SELECT 1 FROM atom a WHERE a.molecule_id=m.molecule_id AND a.element='s') AND NOT EXISTS(SELECT 1 FROM bond b WHERE b.molecule_id=m.molecule_id AND b.bond_type='=')")
run(326,"SELECT DISTINCT a.molecule_id FROM atom a JOIN connected c ON c.atom_id=a.atom_id JOIN bond b ON b.bond_id=c.bond_id WHERE a.element='s' AND b.bond_type='='")
run(328,"SELECT DISTINCT a.element FROM atom a JOIN connected c ON c.atom_id=a.atom_id JOIN bond b ON b.bond_id=c.bond_id WHERE a.molecule_id='TR024' AND b.bond_type='='")
run(330,"SELECT COUNT(DISTINCT a.molecule_id) AS molecules_with_triple_bonded_hydrogen FROM atom a JOIN connected c ON c.atom_id=a.atom_id JOIN bond b ON b.bond_id=c.bond_id WHERE a.element='h' AND b.bond_type='#'",'Existence probe: does requested triple-bonded hydrogen population exist?')
run(335,"SELECT COUNT(DISTINCT a.molecule_id) FROM atom a JOIN connected c ON c.atom_id=a.atom_id JOIN bond b ON b.bond_id=c.bond_id WHERE a.element='o' AND b.bond_type='='")
run(338,"SELECT DISTINCT a.atom_id FROM atom a JOIN connected c ON c.atom_id=a.atom_id JOIN bond b ON b.bond_id=c.bond_id WHERE a.molecule_id='TR012' AND a.element='c' AND b.bond_type='='")
run(519,"SELECT t.language FROM sets s JOIN set_translations t ON t.setCode=s.code WHERE s.name='Battlebond'",'Use declared set-code relationship')
run(741,"SELECT s.id,s.superhero_name,COUNT(*) n FROM superhero s JOIN hero_power p ON p.hero_id=s.id GROUP BY s.id ORDER BY n DESC LIMIT 5",'Rank unique hero IDs instead of merging same-named heroes')
for n,attr,asc in [(732,'Speed',True),(736,'Intelligence',True),(766,'Strength',False),(794,'Speed',False)]:
    aggregate='MIN' if asc else 'MAX'
    run(n,f"SELECT s.superhero_name,p.publisher_name,s.full_name,h.attribute_value FROM superhero s JOIN hero_attribute h ON h.hero_id=s.id JOIN attribute a ON a.id=h.attribute_id LEFT JOIN publisher p ON p.id=s.publisher_id WHERE a.attribute_name='{attr}' AND h.attribute_value=(SELECT {aggregate}(x.attribute_value) FROM hero_attribute x JOIN attribute a2 ON a2.id=x.attribute_id WHERE a2.attribute_name='{attr}')",'Enumerate all extremum ties; not a replacement projection')
run(893,"SELECT d.forename,d.surname,x.points FROM races r JOIN results x ON x.raceId=r.raceId JOIN drivers d ON d.driverId=x.driverId WHERE r.name='Chinese Grand Prix' AND r.year=2017 ORDER BY x.positionOrder LIMIT 3")
run(903,"SELECT COUNT(*) FROM results x JOIN races r ON r.raceId=x.raceId JOIN circuits c ON c.circuitId=r.circuitId JOIN drivers d ON d.driverId=x.driverId WHERE c.name='Sepang International Circuit' AND d.forename='Michael' AND d.surname='Schumacher' AND x.positionOrder=1")
run(928,"SELECT d.driverRef FROM races r JOIN results x ON x.raceId=r.raceId JOIN drivers d ON d.driverId=x.driverId WHERE r.name='Canadian Grand Prix' AND r.year=2007 AND x.positionOrder=1",'Final race winner rather than fastest-lap rank')
run(951,"SELECT COUNT(*) FROM (SELECT c.constructorId FROM constructorStandings s JOIN constructors c ON c.constructorId=s.constructorId WHERE s.points=0 AND c.nationality='Japanese' GROUP BY c.constructorId HAVING COUNT(s.raceId)=2)")
run(966,"SELECT COUNT(DISTINCT driverId) FROM results WHERE raceId=18",'Actual race participants instead of standings records')
run(979,"SELECT raceId,COUNT(time) finishers,COUNT(*) starters FROM results GROUP BY raceId ORDER BY finishers DESC LIMIT 5",'Correct finisher counts')
run(1005,"SELECT duration,milliseconds FROM pitStops ORDER BY milliseconds DESC LIMIT 3",'Numeric elapsed duration rather than lexicographic text')
run(1029,cases['holdout-bird-dev-1029']['goldSql'].replace('ASC','DESC'),'Isolate reversed sorting direction, retaining original row grain')
run(1041,cases['holdout-bird-dev-1041']['goldSql'].replace("WHERE t4.buildUpPlayDribblingClass", "WHERE SUBSTR(t4.date,1,4)='2014' AND t4.buildUpPlayDribblingClass"))
run(1113,cases['holdout-bird-dev-1113']['goldSql'].replace('chanceCreationShootingClass','defenceAggressionClass'))
for n in [1222,1278,1280,1286,1295,1297,1299,1302,1305,1306,1308,1311]:
    case=cases[f'holdout-bird-dev-{n:04}'];sql=case['goldSql'].replace('COUNT(T1.ID)','COUNT(DISTINCT T1.ID)')
    run(n,sql,'Count patients once; preserve other source predicates to isolate fan-out')
run(1247,cases['holdout-bird-dev-1247']['goldSql'].replace('T2.FG <= 150 OR T2.FG >= 450','(T2.FG <= 150 OR T2.FG >= 450)'))
run(1248,cases['holdout-bird-dev-1248']['goldSql'].replace('T2.FG <= 150 OR T2.FG >= 450','(T2.FG <= 150 OR T2.FG >= 450)'))
run(1251,"SELECT COUNT(DISTINCT p.ID) FROM Patient p JOIN Laboratory l ON l.ID=p.ID WHERE l.IGG>=2000",'Remove unrequested Examination existence restriction')
run(1268,cases['holdout-bird-dev-1268']['goldSql'].replace('SELECT T1.ID','SELECT DISTINCT T1.ID'))
run(1274,"SELECT COUNT(DISTINCT e.ID) FROM Examination e JOIN Laboratory l ON l.ID=e.ID WHERE l.SSB IN ('negative','0') AND e.Symptoms IS NOT NULL")
run(1279,"SELECT COUNT(DISTINCT CASE WHEN p.Diagnosis LIKE '%SLE%' THEN p.ID END)*100.0/COUNT(DISTINCT p.ID) FROM Patient p JOIN Laboratory l ON l.ID=p.ID WHERE l.GOT>=60",'Fix conditional count, percentage scale and patient grain; retain substring diagnosis meaning')
run(1284,cases['holdout-bird-dev-1284']['goldSql'].replace('LDH ASC','LDH DESC'))
run(1391,"SELECT SUM(mj.major_name='Finance')*1.0/NULLIF(SUM(mj.major_name='Physics'),0) FROM member m JOIN major mj ON mj.major_id=m.link_to_major")
run(1362,"SELECT COUNT(DISTINCT city) FROM zip_code WHERE county='Orange County' AND state='Virginia'")
run(1442,"WITH totals AS (SELECT e.event_id,SUM(b.remaining) remaining FROM event e LEFT JOIN budget b ON b.link_to_event=e.event_id GROUP BY e.event_id) SELECT SUM(remaining<0)*100.0/COUNT(*) FROM totals",'Event-level net overspend; denominator all events. Alternative any-category policy requires clarification')
run(1491,"SELECT Country,COUNT(*) AS station_count FROM gasstations WHERE Segment='Value for money' GROUP BY Country ORDER BY station_count DESC")
run(1513,"SELECT g.Country,t.Time FROM transactions_1k t JOIN gasstations g ON g.GasStationID=t.GasStationID WHERE t.Date='2012-08-25' ORDER BY t.Time ASC LIMIT 1")

# Independent reference reconstructions for a selection of unpublished Spider2 tasks.
run(85,"SELECT employeeid, SUM(shippeddate>=requireddate) late_orders, ROUND(100.0*SUM(shippeddate>=requireddate)/COUNT(*),6) percentage FROM orders GROUP BY employeeid HAVING COUNT(*)>50 ORDER BY percentage DESC LIMIT 3",spider=True)
run(81,"WITH spend AS (SELECT o.customerid,SUM(d.unitprice*d.quantity) total FROM orders o JOIN order_details d ON d.orderid=o.orderid WHERE SUBSTR(o.orderdate,1,4)='1998' GROUP BY o.customerid) SELECT g.groupname,COUNT(*) n,ROUND(COUNT(*)*100.0/(SELECT COUNT(*) FROM spend),2) pct FROM spend s JOIN customergroupthreshold g ON s.total BETWEEN g.rangebottom AND g.rangetop GROUP BY g.groupname",spider=True)
run(131,"SELECT s.StyleID,s.StyleName,SUM(CASE WHEN p.PreferenceSeq=1 THEN 1 ELSE 0 END),SUM(CASE WHEN p.PreferenceSeq=2 THEN 1 ELSE 0 END),SUM(CASE WHEN p.PreferenceSeq=3 THEN 1 ELSE 0 END) FROM Musical_Styles s LEFT JOIN Musical_Preferences p ON p.StyleID=s.StyleID GROUP BY s.StyleID,s.StyleName",spider=True)
run(133,"WITH scores AS (SELECT s.StyleName,SUM(CASE p.PreferenceSeq WHEN 1 THEN 3 WHEN 2 THEN 2 WHEN 3 THEN 1 ELSE 0 END) score FROM Musical_Styles s JOIN Musical_Preferences p ON p.StyleID=s.StyleID WHERE p.PreferenceSeq IN (1,2,3) GROUP BY s.StyleID,s.StyleName) SELECT StyleName,ABS(score-(SELECT AVG(score) FROM scores)) FROM scores",spider=True)
run(193,"WITH totals AS (SELECT customer_id,MIN(payment_date) first_date,SUM(amount) ltv FROM payment GROUP BY customer_id HAVING SUM(amount)>0), amounts AS (SELECT t.customer_id,t.ltv,SUM(CASE WHEN julianday(p.payment_date)<julianday(t.first_date)+7 THEN p.amount ELSE 0 END) a7,SUM(CASE WHEN julianday(p.payment_date)<julianday(t.first_date)+30 THEN p.amount ELSE 0 END) a30 FROM totals t JOIN payment p ON p.customer_id=t.customer_id GROUP BY t.customer_id,t.ltv) SELECT AVG(a7*100.0/ltv),AVG(a30*100.0/ltv),AVG(ltv) FROM amounts",spider=True)
run(198,"WITH totals AS (SELECT c.Country,SUM(i.Total) v FROM Customer c JOIN Invoice i ON i.CustomerId=c.CustomerId WHERE c.Country IN (SELECT Country FROM Customer GROUP BY Country HAVING COUNT(*)>4) GROUP BY c.Country), numbered AS (SELECT v,ROW_NUMBER() OVER(ORDER BY v) rn,COUNT(*) OVER() n FROM totals) SELECT AVG(v) FROM numbered WHERE rn IN ((n+1)/2,(n+2)/2)",spider=True)
run(330,"WITH r AS (SELECT session,path,ROW_NUMBER() OVER(PARTITION BY session ORDER BY stamp) first_rank,ROW_NUMBER() OVER(PARTITION BY session ORDER BY stamp DESC) last_rank FROM activity_log) SELECT path,COUNT(DISTINCT session) FROM r WHERE first_rank=1 OR last_rank=1 GROUP BY path ORDER BY COUNT(DISTINCT session) DESC",spider=True)
run(331,"WITH r AS (SELECT session,path,LAG(path,1) OVER(PARTITION BY session ORDER BY stamp) prev1,LAG(path,2) OVER(PARTITION BY session ORDER BY stamp) prev2 FROM activity_log) SELECT path,COUNT(*) FROM r WHERE RTRIM(prev1,'/')='/detail' AND RTRIM(prev2,'/')='/detail' GROUP BY path ORDER BY COUNT(*) DESC LIMIT 3",spider=True)
run(75,"WITH purchases AS (SELECT DISTINCT visit_id FROM shopping_cart_events WHERE event_type=3) SELECT h.page_id,h.page_name,SUM(e.event_type=1) views,SUM(e.event_type=2) adds,SUM(e.event_type=2 AND p.visit_id IS NOT NULL) bought,SUM(e.event_type=2 AND p.visit_id IS NULL) abandoned FROM shopping_cart_page_hierarchy h LEFT JOIN shopping_cart_events e ON e.page_id=h.page_id LEFT JOIN purchases p ON p.visit_id=e.visit_id WHERE h.page_id NOT IN (1,2,12,13) GROUP BY h.page_id,h.page_name",spider=True)

with connect('modern_data',True) as db:
    def records(table):
        cur=db.execute('SELECT * FROM '+table); names=[c[0] for c in cur.description];return [dict(zip(names,r)) for r in cur]
    orders=records('pizza_clean_customer_orders'); runners=records('pizza_clean_runner_orders')
    recipes={r['pizza_id']:r['toppings'] for r in records('pizza_recipes')}; toppings={str(r['topping_id']):r['topping_name'] for r in records('pizza_toppings')}
    delivered={r['order_id'] for r in runners if r['cancellation'] is None}
    def split(value): return [x.strip() for x in str(value or '').split(',') if x.strip() and x.strip().lower()!='null']
    revenue=0;counts=Counter();strings=[]
    for i,r in enumerate(orders,1):
        ingredients=Counter(x for x in split(recipes[r['pizza_id']]) if x not in split(r['exclusions']))
        ingredients.update(split(r['extras']))
        if r['order_id'] in delivered:
            revenue+=(12 if r['pizza_id']==1 else 10)+len(split(r['extras']))
            counts.update(ingredients)
        pizza='Meatlovers' if r['pizza_id']==1 else 'Vegetarian'
        names=sorted(ingredients,key=lambda x:(0 if ingredients[x]>1 else 1,toppings[x]))
        strings.append({'ROW_ID':i,'FINAL_INGREDIENTS':pizza+': '+', '.join((str(ingredients[x])+'x ' if ingredients[x]>1 else '')+toppings[x] for x in names)})
    custom(65,[{'total_income':revenue}],'Delivered pizzas only, per-pizza base price plus actual extra token count','Native source rows; Python per-record accounting')
    custom(66,[{'topping_name':toppings[k],'quantity':v} for k,v in sorted(counts.items(),key=lambda kv:toppings[kv[0]])],'Delivered pizzas only; per-pizza recipe minus exclusions plus extras','Native source rows; multiset accounting')
    custom(73,strings,'Per-source-row ingredient string; compare source condition-column projection only','Python per-pizza multiset accounting; source row order used for row_id')

# Inspect every published alternative, not only the first result preview.
for c in cases.values():
    if not c.get('referenceResult'):continue
    for reference in c['referenceResult']['alternatives']:
        with (SOURCE/'spider2'/reference['source']).open(encoding='utf-8-sig',newline='') as f:
            reader=csv.DictReader(f); columns=reader.fieldnames; rows=list(reader)
        checks.append({'caseId':c['id'],'purpose':'Complete original published CSV inspection','source':reference['source'],
                       'originalColumns':columns,'originalRowCount':len(rows),'firstRows':rows[:2],
                       'projectedColumns':list(reference['rows'][0]) if reference['rows'] else [],
                       'conditionColumns':reference.get('conditionColumns')})
(OUT/'independent-checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2),encoding='utf8')
print('Saved',len(checks),'checks; query errors:',[(x['caseId'],x['error']) for x in checks if x.get('error')])
