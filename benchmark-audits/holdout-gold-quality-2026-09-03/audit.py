"""Read-only audit of frozen inputs. Never changes fixtures or model scores."""
import argparse, csv, gzip, hashlib, json, math, re, sqlite3, time
from collections import Counter
from pathlib import Path

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[1]
SOURCE = ROOT / '.benchmark-source'

def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)

def digest(value):
    return hashlib.sha256(value).hexdigest()

def cases():
    text = (ROOT / 'services/benchmark/holdoutFixtures.generated.ts').read_text(encoding='utf-8')
    return json.loads(re.search(r'const CASES: BenchmarkCase\[\] = (.+?);\nexport', text, re.S)[1])

def execute(db, sql):
    deadline = time.monotonic() + 20
    db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
    try:
        cursor = db.execute(sql)
        columns = [d[0] for d in cursor.description or []]
        rows = cursor.fetchmany(10001)
        if len(rows)>10000: return None, 'over_10000_rows'
        return [dict(zip(columns, row)) for row in rows], None
    except sqlite3.Error as exc:
        return None, str(exc)
    finally:
        db.set_progress_handler(None, 0)

def equivalent(left, right):
    if left is None or len(left) != len(right): return False
    def same(a,b):
        if a is None or b is None: return a is None and b is None
        if isinstance(a,(int,float)) and isinstance(b,(int,float)):
            return math.isclose(a,b,rel_tol=1e-6,abs_tol=1e-6)
        return str(a)==str(b)
    remaining=[list(r.values()) for r in right]
    for row in left:
        vals=list(row.values())
        idx=next((i for i,other in enumerate(remaining) if len(vals)==len(other) and all(same(a,b) for a,b in zip(vals,other))),None)
        if idx is None:return False
        remaining.pop(idx)
    return True

def collect():
    all_cases=cases()
    bird=json.loads((SOURCE/'bird/dev_20240627/dev.json').read_text(encoding='utf-8'))
    spiders={c['instance_id']:c for c in map(json.loads,(SOURCE/'spider2/spider2-lite/spider2-lite.jsonl').read_text(encoding='utf-8').splitlines())}
    manifest=json.loads((ROOT/'public/benchmarks/holdout-v1/manifest.json').read_text())
    entries=[]; asset_checks={}; table_checks={}
    for number,case in enumerate(sorted(all_cases,key=lambda c:c['sourceId'])):
        family,index,db_name=case['sourceId'].split(':')
        is_bird=family=='bird-dev'
        original=bird[int(index)] if is_bird else spiders[index]
        db_path=SOURCE/('bird/dev_20240627/dev_databases/dev_databases/'+db_name+'/'+db_name+'.sqlite' if is_bird else 'spider2/databases/'+db_name+'.sqlite')
        check={'questionMatchesSource':case['question']==original['question'], 'sourceSqlMatches':case['goldSql']==original['SQL'] if is_bird else None}
        asset_ref=case['datasetRef']
        if asset_ref not in asset_checks:
            raw=gzip.decompress((ROOT/'public'/asset_ref.lstrip('/')).read_bytes())
            asset=json.loads(raw)
            asset_check={'checksumMatches':digest(raw)==case['datasetSha256'], 'completeTablesMatchSource':True,'tables':[]}
            with sqlite3.connect(db_path.as_uri()+'?mode=ro',uri=True) as db:
                for table in asset['relatedTables']:
                    name=table['name']; key=(str(db_path),name)
                    if key not in table_checks:
                        cur=db.execute('SELECT * FROM "'+name.replace('"','""')+'"')
                        cols=[d[0] for d in cur.description]
                        native=[dict(zip(cols,row)) for row in cur.fetchall()]
                        table_checks[key]=Counter(canonical(row) for row in native)
                    matches=Counter(canonical(row) for row in table['rows'])==table_checks[key]
                    asset_check['completeTablesMatchSource'] &= matches
                    asset_check['tables'].append({'name':name,'rows':len(table['rows']),'columns':list(table['rows'][0]) if table['rows'] else [],'matches':matches})
            asset_checks[asset_ref]=asset_check
        check.update(asset_checks[asset_ref])
        native=None; error=None
        if case['goldSql']:
            with sqlite3.connect(db_path.as_uri()+'?mode=ro',uri=True) as db:
                native,error=execute(db,case['goldSql'])
            check['nativeSqlError']=error
            check['nativeResultMatchesFrozen']=equivalent(native,case['expectedRows']) if is_bird else None
        else:check['nativeSqlError']='No published reference SQL'
        if not is_bird:
            check['publishedReferenceFilesMatch']=all(digest((SOURCE/'spider2'/r['source']).read_bytes())==r['sha256'] for r in case['referenceResult']['alternatives'])
        rows=case['expectedRows']
        flags=[]
        if not rows:flags.append('empty_reference')
        if rows and all(v is None for r in rows for v in r.values()):flags.append('all_null_reference')
        if len({canonical(r) for r in rows})<len(rows):flags.append('duplicate_reference_rows')
        entries.append({**case,'integrity':check,'nativeRows':native,'referenceFlags':flags,'semanticReview':{'status':'pending'}})
        if (number+1)%50==0:print(f'Checked source/complete results: {number+1}/550',flush=True)
    report={'corpusId':'holdout-550','manifestSha256':manifest['manifestSha256'],'auditScope':'All 550 questions; complete outputs and full fixture tables; semantic review is separate from execution/source integrity. No model calls.','cases':entries}
    (OUT/'audit-evidence.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'cases':len(entries),'assetSets':len(asset_checks),'uniqueSourceTables':len(table_checks),'integrityFailures':[c['id'] for c in entries if not c['integrity']['questionMatchesSource'] or not c['integrity']['checksumMatches'] or not c['integrity']['completeTablesMatchSource'] or c['integrity'].get('nativeResultMatchesFrozen') is False]}),flush=True)

def show(offset,count,family):
    all_cases=sorted(cases(),key=lambda c:int(c['sourceId'].split(':')[1]) if c['suiteId']=='bird-dev-holdout' else int(c['sourceId'].split(':')[1].replace('local','')))
    selected=[c for c in all_cases if (c['suiteId']=='bird-dev-holdout')==(family=='bird')][offset:offset+count]
    for c in selected:
        print('\n'+c['id']+' | '+c['sourceId'])
        print('Q: '+c['question'])
        if c.get('context'):print('Evidence: '+c['context'])
        print('SQL: '+(c['goldSql'] or '[NO PUBLISHED SQL]'))
        rows=c['expectedRows']
        print('Output: '+str(len(rows))+' rows; '+json.dumps(rows[:2],ensure_ascii=False))
        if c.get('referenceResult'):print('Alternatives: '+str(len(c['referenceResult']['alternatives'])))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--show',type=int);parser.add_argument('--count',type=int,default=40);parser.add_argument('--family',default='bird');args=parser.parse_args()
    show(args.show,args.count,args.family) if args.show is not None else collect()
