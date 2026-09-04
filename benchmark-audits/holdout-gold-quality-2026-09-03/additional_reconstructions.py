import json,sqlite3,re
from collections import defaultdict
from datetime import datetime,timedelta
from audit import OUT,SOURCE,execute,equivalent

data=json.loads((OUT/'audit-evidence.json').read_text(encoding='utf8'))
cases={int(c['sourceId'].split(':')[1].replace('local','')):c for c in data['cases'] if c['sourceId'].startswith('spider2')}
checks=json.loads((OUT/'independent-checks.json').read_text(encoding='utf8'))
def db(n):return sqlite3.connect((SOURCE/f"spider2/databases/{cases[n]['sourceId'].split(':')[2]}.sqlite").as_uri()+'?mode=ro',uri=True)
def save(n,rows,method,sql=None,error=None):
    matches=[a['source'] for a in cases[n]['referenceResult']['alternatives'] if equivalent(rows,a['rows'])]
    checks.append({'caseId':cases[n]['id'],'purpose':method,'sql':sql,'error':error,'rows':rows,
        'matchesOriginalFrozenByPositionalValues':equivalent(rows,cases[n]['expectedRows']), 'matchingPublishedAlternatives':matches})
    print(n,'rows',len(rows or []),'first',str((rows or [])[:1])[:250],'matches',matches,'error',error,flush=True)
def run(n,sql,method):
    with db(n) as con: rows,error=execute(con,sql)
    save(n,rows,method,sql,error)

with db(7) as con:
    spans=[]
    for start,end in con.execute('SELECT debut,final_game FROM player'):
        if not start or not end:continue
        a=datetime.fromisoformat(start);b=datetime.fromisoformat(end)
        spans.append(round(abs(b.year-a.year),2)+round(abs(b.month-a.month)/12,2)+round(abs(b.day-a.day)/365,2))
    save(7,[{'average':round(sum(spans)/len(spans),2)}],'Independent date-component year/month/day absolute differences; round each part2dp, average valid-date players, final2dp')
with db(71) as con:
    rows=list(con.execute('SELECT country_code_2,insert_date,capital FROM cities'))
    def streaks(prefix):
        countries=defaultdict(set)
        for country,date,capital in rows:
            if date.startswith(prefix):countries[country].add(datetime.fromisoformat(date).date())
        result=[]
        for country,dates in countries.items():
            group=[];last=None
            for date in sorted(dates):
                if last is not None and date!=last+timedelta(days=1):result.append((country,len(dates),group));group=[]
                group.append(date);last=date
            if group:result.append((country,len(dates),group))
        return result
    groups=streaks('2022-06');maximum=max(len(g) for _,_,g in groups)
    save(71,[{'country':c} for c in sorted({c for c,_,g in groups if len(g)==maximum})],f'Independent unique-day streaks in June2022; longest streak={maximum}')
    january=[(c,n,g) for c,n,g in streaks('2022-01') if n==9];longest=max(len(g) for c,n,g in january)
    computed=[]
    for country,n,group in january:
        if len(group)!=longest:continue
        qualifying=[r for r in rows if r[0]==country and group[0].isoformat()<=r[1][:10]<=group[-1].isoformat()]
        capitals=sum(bool(r[2]) for r in qualifying)
        computed.append({'country':country,'days':n,'start':group[0].isoformat(),'end':group[-1].isoformat(),'streak':len(group),'entries':len(qualifying),'capital_entries':capitals,'percentage':capitals*100/len(qualifying)})
    save(72,computed,'Independent nine-day countries, longest January streak and capital share of entries')

run(114,"WITH rep AS (SELECT r.id region_id,r.name region_name,s.id rep_id,s.name rep_name,COUNT(*) n,SUM(o.total_amt_usd) sales FROM web_orders o JOIN web_accounts a ON a.id=o.account_id JOIN web_sales_reps s ON s.id=a.sales_rep_id JOIN web_region r ON r.id=s.region_id GROUP BY r.id,r.name,s.id,s.name), totals AS (SELECT region_id,region_name,SUM(n) n,SUM(sales) sales,MAX(sales) top FROM rep GROUP BY region_id,region_name) SELECT t.region_name,t.n,t.sales,GROUP_CONCAT(r.rep_name||' ($'||ROUND(r.sales,2)||')',', ') top_reps FROM totals t JOIN rep r ON r.region_id=t.region_id AND r.sales=t.top GROUP BY t.region_id,t.region_name,t.n,t.sales",'Independent single-pass order/rep/region aggregation; all maximum-revenue ties; serialization may differ harmlessly')
run(132,"WITH e AS (SELECT EntertainerID,MAX(CASE WHEN StyleStrength=1 THEN StyleID END) a,MAX(CASE WHEN StyleStrength=2 THEN StyleID END) b FROM Entertainer_Styles GROUP BY EntertainerID HAVING COUNT(*)<=3), c AS (SELECT CustomerID,MAX(CASE WHEN PreferenceSeq=1 THEN StyleID END) a,MAX(CASE WHEN PreferenceSeq=2 THEN StyleID END) b FROM Musical_Preferences GROUP BY CustomerID HAVING COUNT(*)<=3) SELECT x.EntStageName,y.CustLastName FROM e JOIN c ON (e.a=c.a AND e.b=c.b) OR (e.a=c.b AND e.b=c.a) JOIN Entertainers x ON x.EntertainerID=e.EntertainerID JOIN Customers y ON y.CustomerID=c.CustomerID",'Independent first/second style pair equality or reversal, each entity with<=3 rows')
run(152,"WITH films AS (SELECT d.name_id,m.*,r.avg_rating,r.total_votes,LAG(m.date_published) OVER(PARTITION BY d.name_id ORDER BY m.date_published,m.id) previous FROM director_mapping d JOIN movies m ON m.id=d.movie_id JOIN ratings r ON r.movie_id=m.id) SELECT f.name_id,n.name,COUNT(*),ROUND(AVG(julianday(f.date_published)-julianday(f.previous))),ROUND(AVG(f.avg_rating),2),SUM(f.total_votes),MIN(f.avg_rating),MAX(f.avg_rating),SUM(f.duration) FROM films f JOIN names n ON n.id=f.name_id GROUP BY f.name_id,n.name ORDER BY COUNT(*) DESC,SUM(f.duration) DESC LIMIT 9",'Independent director aggregation and ordered consecutive-release gaps')
with db(253) as con:
    values=[];groups=defaultdict(list)
    for company,city,salary in con.execute('SELECT CompanyName,Location,Salary FROM SalaryDataset'):
        numeric=re.sub(r'[^0-9.]','',salary or '')
        if not numeric:continue
        value=float(numeric);values.append(value);groups[(city,company)].append(value)
    country=sum(values)/len(values);out=[]
    for city in ['Mumbai','Pune','New Delhi','Hyderabad']:
        grouped=sorted([(sum(v)/len(v),company) for (location,company),v in groups.items() if location==city],key=lambda t:(-t[0],t[1]))[:5]
        out.extend({'location':city,'company':company,'city_salary':value,'national_salary':country} for value,company in grouped)
    save(253,out,'Independent currency/comma/unit-text stripping preserving decimal point, record-weighted company-city means and national mean; no annualization specified')
run(262,"WITH compared AS (SELECT name,version,step,MAX(CASE WHEN model<>'Stack' THEN test_score END) other,MAX(CASE WHEN model='Stack' THEN test_score END) stack FROM model_score WHERE step IN(1,2,3) GROUP BY name,version,step), wins AS (SELECT name,COUNT(*) n FROM compared WHERE other<stack GROUP BY name) SELECT name FROM wins WHERE n>(SELECT COUNT(*) FROM solution s WHERE s.name=wins.name)",'Independent per-name/version/step maximum comparisons versus solution row counts')
run(263,"WITH compared AS (SELECT name,version,step,MAX(CASE WHEN model<>'Stack' THEN test_score END) other,MAX(CASE WHEN model='Stack' THEN test_score END) stack FROM model_score GROUP BY name,version,step), counts AS (SELECT CASE WHEN c.other<c.stack THEN 'strong' ELSE 'soft' END status,m.L1_model,COUNT(*) n FROM compared c JOIN model m ON m.name=c.name AND m.version=c.version AND m.step=c.step WHERE c.other<=c.stack GROUP BY status,m.L1_model), ranks AS (SELECT *,DENSE_RANK() OVER(PARTITION BY status ORDER BY n DESC) r FROM counts) SELECT status,L1_model,n FROM ranks WHERE r=1 ORDER BY status",'Independent step-level strong/soft comparisons and L1 frequency maxima, preserving ties')
(OUT/'independent-checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2),encoding='utf8')
