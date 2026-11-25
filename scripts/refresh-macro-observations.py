"""Refresh the macro dashboard's market stress observations."""
import csv
import io
import json
import os
import subprocess
import tempfile
import re
import sqlite3
import sys
from statistics import mean
from urllib.parse import urlencode
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / 'data/macro-observations.json'
TODAY = datetime.now(timezone.utc).date()

def download(url):
    return subprocess.check_output(['curl.exe', '-fgsSL', '--ssl-revoke-best-effort', '--retry', '2', '--retry-all-errors', '--max-time', '20',
                                    '-A', 'Mozilla/5.0', url], timeout=75)

def option_stress():
    def closes(symbol):
        raw = download(f'https://cdn.cboe.com/api/global/us_indices/daily_prices/{symbol}_History.csv')
        series = {}
        for row in csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))):
            day = datetime.strptime(row['DATE'], '%m/%d/%Y').date()
            if day <= TODAY and float(row['CLOSE']) > 0:
                series[day] = float(row['CLOSE'])
        return series
    with ThreadPoolExecutor(max_workers=2) as pool:
        spot, quarter = pool.map(closes, ('VIX', 'VIX3M'))
    aligned = sorted(spot.keys() & quarter.keys())
    previous, latest = aligned[-2:]
    vix = spot[latest]
    ratio = vix / quarter[latest]
    flags = int(vix >= 25) + int(ratio > 1)
    return dict(date=latest.isoformat(), vix=vix, prior=spot[previous], threeMonth=quarter[latest],
                ratio=ratio, level=['常态', '压力升温', '高波动警示'][flags], flags=flags)

def credit_spread():
    with urllib.request.urlopen('https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2&cosd=2025-01-01', timeout=20) as response:
        raw = response.read()
    rows = [(r['observation_date'], float(r['BAMLH0A0HYM2'])) for r in
            csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))) if r['BAMLH0A0HYM2'] not in ('', '.')]
    rows.sort()
    day, value = rows[-1]
    return dict(date=day, bp=round(100*value), change=round(100*(value-rows[-21][1])))

HSI_API = 'https://www.hsi.com.hk/api/wsit-hsi-ddoc-ea-public-website-proxy/v1/'

def public_json(url):
    return json.loads(download(url))

def vhsi():
    url = HSI_API+'product-data/pub/indexes/metadata/v2?data=valueHistoryPub&language=en-hk&indexCodes=01050.00'
    index = public_json(url)['data'][0]
    if index['indexCode'] != '01050.00': raise ValueError('VHSI identity')
    rows = sorted((date.fromisoformat(r['date']), float(r['close'])) for r in index['valueHistory']
                  if r.get('close') and float(r['close']) > 0)
    day, value = rows[-1]
    window = [v for d,v in rows if day-timedelta(days=1096)<d<=day]
    if len(window)<650: raise ValueError('VHSI history')
    return dict(date=day.isoformat(), value=value, change=value-rows[-6][1],
                percentile=100*sum(v<=value for v in window)/len(window))

def fear_greed():
    source='https://raw.githubusercontent.com/whit3rabbit/fear-greed-data/main/fear-greed.csv'
    raw=download(source).decode('utf-8-sig')
    rows=sorted(csv.DictReader(io.StringIO(raw)),key=lambda r:r['Date'])
    latest=rows[-1]
    score=float(latest['Fear Greed'])
    if not 0<=score<=100: raise ValueError('invalid sentiment score')
    return dict(date=date.fromisoformat(latest['Date']).isoformat(),value=score,
                change=score-float(rows[-2]['Fear Greed']),rating=latest['Rating'].lower())

def hk_funding():
    url='https://api.hkma.gov.hk/public/market-data-and-statistics/daily-monetary-statistics/daily-figures-interbank-liquidity?pagesize=60'
    records=public_json(url)['result']['records']
    rows=sorted((r for r in records if r['hibor_fixing_1m'] is not None),key=lambda r:r['end_of_date'])
    last=rows[-1]
    return dict(date=last['end_of_date'],value=last['hibor_fixing_1m'],
                change=100*(last['hibor_fixing_1m']-rows[-21]['hibor_fixing_1m']),
                balance=last['closing_balance']/100 if last['closing_balance'] is not None else None)

def members(market):
    if market=='US':
        url='https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv'
        symbols={r['Symbol'] for r in csv.DictReader(io.StringIO(download(url).decode('utf-8-sig')))}
        if not 490<=len(symbols)<=520: raise ValueError('invalid SPX membership')
        return symbols, None
    sys.path.insert(0,str(ROOT/'data/macro-python'))
    from pypdf import PdfReader
    reports=public_json(HSI_API+'product-data/pub/series/metadata/v2?data=dailyReport&seriesCode=hsci')[0]
    file=next(group for group in reports['reportList'] if group['reportType']=='con-pdf-1')['reportDate'][0]
    pdf=PdfReader(io.BytesIO(download(HSI_API+'content/gcs/download?'+urlencode({'resource':file['url']}))))
    symbols=set()
    for page in pdf.pages:
        text=page.extract_text().replace('\xa0',' ')
        codes=re.findall(r'\d{8}\s+Hang Seng Composite Index\s+恒生綜合指數\s+(\d{4,5})\.HK',text)
        if symbols and not codes: break
        symbols.update(code.zfill(5) for code in codes if code!='99999')  # detached securities placeholder
    count=public_json(HSI_API+'product-data/pub/constituent/metadata/v2?data=rt&seriesCode=hsci&language=en-hk')
    expected=next(r['count'] for r in count['data']['numOfConsList'] if r['indexCode']=='00011.00')
    if len(symbols)!=expected: raise ValueError('incomplete HSCI membership')
    return symbols,file['date']

def breadth(market):
    symbols,member_date=members(market)
    db=sqlite3.connect((ROOT/'data/market_data.db').as_uri()+'?mode=ro',uri=True)
    with db:
        db.execute('BEGIN')
        query="""SELECT date,close,data_suspect,adjust_type FROM radar_v2_bars
                 WHERE market=? AND symbol=? ORDER BY date DESC LIMIT 230"""
        def bars(symbol):
            return db.execute(query,(market,symbol)).fetchall()
        dates=[r[0] for r in bars('MSFT' if market=='US' else '00700')]
        day,previous=dates[0],dates[20]
        if member_date and member_date!=day: raise ValueError('membership and bars dates differ')
        above=old_above=valid=0
        for symbol in sorted(symbols):
            rows=bars(symbol)
            if not rows and '.' in symbol: rows=bars(symbol.replace('.','-'))
            if not rows or rows[0][0]!=day: continue
            offset=next((i for i,r in enumerate(rows[:25]) if r[0]==previous),None)
            if offset is None or len(rows)<offset+200: continue
            sample=rows[:offset+200]
            if any(r[2] or not r[1] or r[1]<=0 or r[3]!=sample[0][3] for r in sample):continue
            above+=sample[0][1]>mean(r[1] for r in sample[:200])
            old_above+=sample[offset][1]>mean(r[1] for r in sample[offset:offset+200])
            valid+=1
    db.close()
    if valid<len(symbols)*.5: raise ValueError(f'insufficient breadth coverage {valid}/{len(symbols)}')
    return dict(date=day,value=100*above/valid,change=100*(above-old_above)/valid,above=above,
                covered=valid,total=len(symbols),previous=previous)

def run():
    old=json.loads(TARGET.read_text(encoding='utf8')) if TARGET.exists() else {}
    tasks={'credit':credit_spread,'options':option_stress,'vhsi':vhsi,'sentiment':fear_greed,
           'funding':hk_funding,'breadthUS':lambda:breadth('US'),'breadthHK':lambda:breadth('HK')}
    failures=[]
    with ThreadPoolExecutor(max_workers=5) as pool:
        pending={k:pool.submit(fn) for k,fn in tasks.items()}
        for key,job in pending.items():
            try:
                value=job.result()
                if value['date']<old.get(key,{}).get('date',''): raise ValueError('源数据日期倒退')
                old[key]=value
            except Exception as err:
                failures.append(key)
                print(key,type(err).__name__,str(err)[:180])
    old['failures']=failures
    old['checked']=datetime.now(timezone.utc).isoformat(timespec='seconds')
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile('w',encoding='utf8',dir=TARGET.parent,delete=False) as f:
        json.dump(old,f,allow_nan=False)
    os.replace(f.name,TARGET)
    print(old['checked'],old.get('options'), 'fallback',failures)
    if failures: raise SystemExit(1)

if __name__=='__main__': run()
